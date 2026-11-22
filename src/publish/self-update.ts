import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boardHome } from '../config.js';
import type { AppContext, SelfUpdateControl } from '../context.js';
import { nowIso } from '../db/index.js';
import { RuleError } from '../service/rules.js';
import type { SelfUpdateCommit, SelfUpdatePhase, SelfUpdateState } from '../shared/domain.js';
import { authorList, expandHome } from '../config.js';
import { canonicalDir, git, linkDir, repoRoot, runCommand, samePath, syncDir, type CmdResult } from './git.js';
import { DEFAULT_COMMANDS, isScreenOnly, type Publisher, type PublishCommands } from './publisher.js';
import { isBoardEnvKey } from '../shared/brand.js';
import { countTestFiles, progressDetail, testProgress } from './test-progress.js';

/**
 * Update of the Board from the git remote it was cloned from (card #183, D89).
 *
 * Every new commit on the remote branch (origin/main by default) is a new version. The check fetches
 * that branch every few hours; the strip at the foot offers "Atualizar" ('notify') or the update
 * starts on its own ('auto'). Applying reuses the publication's path (D42): merge in a throwaway
 * worktree, install when the lockfile changed, build, hold the runner, back up the database,
 * fast-forward the main checkout and restart from a detached process. Runs in progress survive the
 * restart (D45). A failure leaves the install as it was.
 *
 * Commits made here (the Board improving itself, D42) are kept: when the install has commits the
 * remote does not, the remote branch is merged into the local one and the tests run before applying.
 * A conflict aborts with the list of files.
 *
 * 'auto' runs code from the remote with nobody looking, so it only does that for commits it can trust
 * (card #225): every new commit, merges included, needs a good signature from a trusted key (%G? = G:
 * a key in gpg.ssh.allowedSignersFile, or a gpg key with full trust) or an author in selfUpdateAuthors. One
 * commit that fails turns that version into a 'notify' one: the strip waits for "Atualizar".
 */

const PACKAGE_FILES = ['package.json', 'package-lock.json'];
const MAX_COMMITS = 20;
const FAILURE_KEY = 'selfUpdateFailure';

export interface SelfUpdaterOptions {
  commands?: Partial<PublishCommands>;
  run?: (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, onOutput?: (chunk: string) => void) => Promise<CmdResult>;
  /** Replaces the detached restart (tests). */
  restart?: () => Promise<void> | void;
  /** First check after the server starts. */
  firstCheckMs?: number;
  /** Between checks. */
  checkEveryMs?: number;
  /** Retry of an automatic update that found a publication under way. */
  retryMs?: number;
  /** Limit of one fetch. */
  fetchTimeoutMs?: number;
  /** Next check after a fetch that failed (network down when the Board started, DNS, proxy). */
  retryCheckMs?: number;
}

class UpdateError extends Error {}

interface Source {
  remote: string;
  branch: string;
  /** remote/branch */
  ref: string;
}

/**
 * Only a good signature from a trusted key counts. 'U' is not enough: with SSH it is what git reports
 * for a key outside gpg.ssh.allowedSignersFile ("No principal matched"), so any key would pass (measured).
 */
const GOOD_SIGNATURE = ['G'];

/**
 * A merge of two parents whose tree is exactly what git merges on its own: it brings no code beyond its
 * parents, which are checked as commits of the range. This is what GitHub's "Create a merge commit"
 * makes when the public copy's PR is merged (D66); GitHub signs it with its own key, which only says
 * that someone with access to the repository merged it, so the signature is not what lets it through.
 */
function isCleanMerge(repo: string, parents: string[], sha: string): boolean {
  if (parents.length !== 2) return false;
  const merged = git(repo, ['merge-tree', '--write-tree', parents[0], parents[1]]);
  const tree = git(repo, ['rev-parse', `${sha}^{tree}`]);
  return merged.ok && tree.ok && merged.out.split('\n')[0] === tree.out;
}

/**
 * Why the commits in `range` cannot be applied without the user, or null when each one is signed with
 * a key git verifies, was authored by one of `authors`, or is a clean merge of its parents (card #225).
 */
export function untrustedReason(repo: string, range: string, authors: string[]): string | null {
  const log = git(repo, ['log', '--format=%H%x1f%G?%x1f%ae%x1f%s%x1f%P', range]);
  if (!log.ok) return `não consegui conferir as assinaturas de ${range}: ${log.out}`;
  const bad = log.out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\x1f'))
    .filter(([sha, sig, email, , parents]) => !GOOD_SIGNATURE.includes(sig) && !authors.includes((email ?? '').toLowerCase()) && !isCleanMerge(repo, (parents ?? '').split(' ').filter(Boolean), sha));
  if (!bad.length) return null;
  const [sha, , email, subject] = bad[0];
  const more = bad.length > 1 ? ` e mais ${bad.length - 1} commit(s)` : '';
  return `o commit ${sha.slice(0, 7)} ("${subject}", de ${email})${more} não tem assinatura válida e o autor não está em "Autores aceitos na atualização automática". Confira as novidades e use Atualizar.`;
}

/** Web page of the commits of a GitHub remote, or null for any other host. */
export function githubCommitsUrl(remoteUrl: string, branch: string): string | null {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `https://github.com/${m[1]}/${m[2]}/commits/${branch}` : null;
}

/** A remote URL without scheme, credentials, .git and case, so the https and ssh forms of one repo compare equal. */
export function normalizeRemoteUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '');
}

/**
 * The fetch error in words: what is wrong and what to do. The last line of the git output goes after
 * it, since the user may need it to fix a proxy or a credential.
 */
export function explainFetchError(ref: string, url: string, out: string, retryMinutes: number): string {
  const host = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i)?.[1] ?? 'o remoto';
  const again = `O Board tenta de novo em ${retryMinutes} min.`;
  const last = out.trim().split('\n').pop() ?? '';
  const raw = last ? ` Resposta do git: ${last}` : '';
  if (/could not resolve host|name or service not known|temporary failure in name resolution|nodename nor servname/i.test(out)) {
    return `Sem acesso a ${host} desta máquina: o nome não resolveu (rede fora, DNS ou proxy). ${again}${raw}`;
  }
  if (/failed to connect|connection (timed out|refused)|could not connect|network is unreachable|tempo esgotado/i.test(out)) {
    return `Sem conexão com ${host} desta máquina (rede, firewall ou proxy). ${again}${raw}`;
  }
  if (/authentication failed|could not read username|permission denied|repository not found|error: 403/i.test(out)) {
    return `${host} recusou o acesso a ${ref}: o repositório é privado ou a credencial do git desta máquina não vale para ele.${raw}`;
  }
  return `Não consegui buscar ${ref}. ${again}${raw || ' (o git não deu mensagem)'}`;
}

/** git with a time limit and no prompt: a fetch that wants a password fails instead of hanging the server. */
function gitAsync(cwd: string, args: string[], timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', args, {
      cwd: canonicalDir(cwd),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      windowsHide: true,
      timeout: timeoutMs,
    });
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-8000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (err) => resolve({ ok: false, out: `${out}\n${err.message}`.trim() }));
    child.on('close', (code, signal) => resolve({ ok: code === 0, out: signal ? `${out}\nTempo esgotado (${Math.round(timeoutMs / 1000)} s).`.trim() : out.trim() }));
  });
}

const fence = (text: string) => `\n\n\`\`\`\n${text.trim().split('\n').slice(-30).join('\n').replace(/```/g, "'''")}\n\`\`\``;

export class SelfUpdater implements SelfUpdateControl {
  private phase: SelfUpdatePhase = 'idle';
  private detail: string | null = null;
  private busy: Promise<void> | null = null;
  private checking: Promise<SelfUpdateState> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  /** Last version 'auto' left for the user, so the log says it once. */
  private blockedSha: string | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  private last: Pick<SelfUpdateState, 'source' | 'sourceUrl' | 'behind' | 'ahead' | 'commits' | 'remoteSha' | 'checkedAt' | 'checkError' | 'unavailable' | 'untrusted'> = {
    source: null,
    sourceUrl: null,
    behind: 0,
    ahead: 0,
    commits: [],
    remoteSha: null,
    checkedAt: null,
    checkError: null,
    unavailable: null,
    untrusted: null,
  };
  private commands: PublishCommands;
  private run: NonNullable<SelfUpdaterOptions['run']>;

  constructor(
    private ctx: AppContext,
    private publisher: Publisher,
    private opts: SelfUpdaterOptions = {},
  ) {
    this.commands = { ...DEFAULT_COMMANDS, ...opts.commands };
    this.run = opts.run ?? runCommand;
  }

  // ---------- schedule ----------

  /** First check shortly after the server starts, then every few hours. Each one reads the mode again. */
  schedule(): void {
    if (this.timers.length) return;
    const first = setTimeout(() => void this.tick(), this.opts.firstCheckMs ?? 30_000);
    const every = setInterval(() => void this.tick(), this.opts.checkEveryMs ?? 6 * 3600_000);
    first.unref?.();
    every.unref?.();
    this.timers.push(first, every);
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  /** A failed fetch is checked again in minutes, not at the next 6-hour tick (card #183 review). */
  private scheduleRecheck(): void {
    if (this.recheckTimer || !this.timers.length) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.tick();
    }, this.retryCheckMs());
    this.recheckTimer.unref?.();
  }

  private retryCheckMs(): number {
    return this.opts.retryCheckMs ?? 15 * 60_000;
  }

  private async tick(): Promise<void> {
    if (this.ctx.config.selfUpdate === 'off' || this.busy) return;
    try {
      await this.check();
    } catch (err) {
      this.log(`verificação falhou: ${(err as Error).message}`);
    }
  }

  /** 'auto': a new version that has not failed already starts on its own. */
  private maybeAuto(): void {
    if (this.ctx.config.selfUpdate !== 'auto' || this.busy) return;
    const s = this.state();
    if (s.unavailable || !s.behind || !s.remoteSha) return;
    if (s.failure?.sha === s.remoteSha) return;
    if (s.untrusted) {
      // Falls back to 'notify': the strip offers "Atualizar" and the user decides.
      if (this.blockedSha !== s.remoteSha) this.log(`atualização automática esperando o usuário: ${s.untrusted}`);
      this.blockedSha = s.remoteSha;
      return;
    }
    if (this.publisher.isBusy()) {
      // A publication is applying; try again in a few minutes instead of waiting for the next check.
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.maybeAuto();
        }, this.opts.retryMs ?? 5 * 60_000);
        this.retryTimer.unref?.();
      }
      return;
    }
    this.log(`atualização automática para ${s.remoteSha.slice(0, 7)}`);
    this.launch(true);
  }

  // ---------- state ----------

  isBusy(): boolean {
    return !!this.busy;
  }

  /** Waits for the update in progress (tests). */
  async whenIdle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  state(): SelfUpdateState {
    return {
      mode: this.ctx.config.selfUpdate,
      ...this.last,
      phase: this.phase,
      detail: this.detail,
      failure: this.ctx.service.getSetting<SelfUpdateState['failure']>(FAILURE_KEY, null),
    };
  }

  private changed(): void {
    this.ctx.bus.publish({ type: 'self-update.changed' });
  }

  private setPhase(phase: SelfUpdatePhase, detail: string | null): void {
    this.phase = phase;
    this.detail = detail;
    if (detail) this.log(`${phase}: ${detail}`);
    this.changed();
  }

  private log(line: string): void {
    try {
      fs.appendFileSync(path.join(boardHome(), 'publish.log'), `${nowIso()} [atualização] ${line}\n`);
    } catch {
      /* logging must never break an update */
    }
  }

  // ---------- where the versions come from ----------

  /**
   * True when this Board is the one that generates the public copy (D66): its mirror checkout is
   * another repository whose origin is the very remote it would update from. A filled-in
   * `mirrorRepoPath` alone proves nothing (card #183 review): a config copied from the source
   * machine, a folder that does not exist here, or the Board's own clone.
   */
  private isMirrorSource(repo: string, remoteUrl: string): boolean {
    const configured = this.ctx.config.mirrorRepoPath;
    if (!configured || !remoteUrl) return false;
    const mirror = repoRoot(path.resolve(expandHome(configured)));
    if (!mirror || samePath(mirror, repo)) return false;
    const common = (dir: string) => git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
    if (samePath(common(mirror), common(repo))) return false;
    const mirrorOrigin = git(mirror, ['config', '--get', 'remote.origin.url']).out;
    return !!mirrorOrigin && normalizeRemoteUrl(mirrorOrigin) === normalizeRemoteUrl(remoteUrl);
  }

  private source(repo: string): Source | null {
    const configured = this.ctx.config.selfUpdateSource;
    const split = (ref: string): Source | null => {
      const i = ref.indexOf('/');
      return i > 0 ? { remote: ref.slice(0, i), branch: ref.slice(i + 1), ref } : null;
    };
    if (configured) return split(configured);
    const local = this.ctx.config.publishBranch;
    const upstream = git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${local}@{upstream}`]);
    if (upstream.ok && upstream.out && git(repo, ['remote', 'get-url', upstream.out.split('/')[0]]).ok) return split(upstream.out);
    if (!git(repo, ['remote', 'get-url', 'origin']).ok) return null;
    const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.ok && head.out.startsWith('origin/')) return split(head.out);
    return split(`origin/${local}`);
  }

  // ---------- check ----------

  /**
   * Fetches the remote branch and recomputes what is new. Concurrent calls share one fetch. In 'auto',
   * a check that finds a new version (the schedule, "Verificar agora", turning the mode on) starts it.
   */
  check(): Promise<SelfUpdateState> {
    if (!this.checking) {
      this.checking = this.doCheck()
        .then((s) => {
          this.maybeAuto();
          return s;
        })
        .finally(() => {
          this.checking = null;
        });
    }
    return this.checking;
  }

  private async doCheck(): Promise<SelfUpdateState> {
    const repo = this.publisher.selfRepo();
    // An unavailable install shows only why: no stale fetch error or count from an earlier check.
    const unavailableState = (unavailable: string) => {
      this.last = { unavailable, source: null, sourceUrl: null, behind: 0, ahead: 0, commits: [], remoteSha: null, checkedAt: nowIso(), checkError: null, untrusted: null };
      this.changed();
      return this.state();
    };
    if (!repo) return unavailableState('Não achei o repositório git de onde o Board roda.');
    const src = this.source(repo);
    if (!src) {
      return unavailableState('O repositório do Board não tem remoto de onde buscar versões. Instale por `git clone` do repositório público para receber as atualizações.');
    }
    if (this.isMirrorSource(repo, git(repo, ['config', '--get', `remote.${src.remote}.url`]).out)) {
      return unavailableState(
        'Este Board gera a cópia pública (D66): o origin da pasta em "Repositório público do Board" é o mesmo remoto de onde ele buscaria versões, então ele envia as mudanças para lá e não recebe de lá.',
      );
    }
    const idle = this.phase === 'idle';
    if (idle) this.setPhase('checking', null);
    try {
      const fetched = await gitAsync(
        repo as string,
        ['fetch', '--quiet', '--no-tags', src.remote, `+refs/heads/${src.branch}:refs/remotes/${src.remote}/${src.branch}`],
        this.opts.fetchTimeoutMs ?? 60_000,
      );
      const remoteUrl = git(repo as string, ['config', '--get', `remote.${src.remote}.url`]).out;
      const base = { unavailable: null, source: src.ref, sourceUrl: githubCommitsUrl(remoteUrl, src.branch), checkedAt: nowIso() };
      if (!fetched.ok) {
        // Keep what the last good fetch found; say why this one failed.
        this.last = { ...this.last, ...base, checkError: explainFetchError(src.ref, remoteUrl, fetched.out, Math.round(this.retryCheckMs() / 60_000)) };
        this.log(`fetch falhou: ${fetched.out}`);
        this.scheduleRecheck();
      } else {
        this.last = { ...base, checkError: null, ...this.compare(repo as string, src.ref) };
      }
    } finally {
      if (idle && this.phase === 'checking') this.setPhase('idle', null);
      else this.changed();
    }
    // After the finally: the answer to "Verificar agora" comes back idle, not "checking".
    return this.state();
  }

  /** Commits on each side of the local branch and the remote ref (no network). */
  private compare(repo: string, ref: string): Pick<SelfUpdateState, 'behind' | 'ahead' | 'commits' | 'remoteSha' | 'untrusted'> {
    const local = this.ctx.config.publishBranch;
    const remoteSha = git(repo, ['rev-parse', '--verify', '--quiet', ref]);
    if (!remoteSha.ok) return { behind: 0, ahead: 0, commits: [], remoteSha: null, untrusted: null };
    const count = (range: string) => Number(git(repo, ['rev-list', '--count', range]).out) || 0;
    const behind = count(`${local}..${ref}`);
    const ahead = count(`${ref}..${local}`);
    const log = git(repo, ['log', '--no-merges', `-${MAX_COMMITS}`, '--format=%H%x1f%s%x1f%cI', `${local}..${ref}`]);
    const commits: SelfUpdateCommit[] = log.ok
      ? log.out
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [sha, subject, date] = line.split('\x1f');
            return { sha, subject, date };
          })
      : [];
    // Only 'auto' needs it, and %G? runs gpg or ssh-keygen once per commit.
    const untrusted = behind && this.ctx.config.selfUpdate === 'auto' ? untrustedReason(repo, `${local}..${ref}`, authorList(this.ctx.config.selfUpdateAuthors)) : null;
    return { behind, ahead, commits, remoteSha: remoteSha.out, untrusted };
  }

  // ---------- apply ----------

  /** "Atualizar": refuses when another apply is under way, else starts in the background (the route answers right away; the strip follows the phases). */
  begin(): void {
    const s = this.state();
    if (this.busy) throw new RuleError('self_update_busy', 'A atualização já está em andamento.', 409);
    if (s.unavailable) throw new RuleError('self_update_unavailable', s.unavailable, 409);
    if (this.publisher.isBusy()) throw new RuleError('publish_busy', 'Uma publicação do Board está em andamento; atualize quando ela terminar.', 409);
    this.launch();
  }

  private launch(auto = false): void {
    if (this.busy) return;
    this.busy = this.apply(auto)
      .catch((err) => this.log(`erro interno: ${(err as Error).stack ?? err}`))
      .finally(() => {
        this.busy = null;
        if (this.phase !== 'restarting') {
          this.setPhase('idle', null);
          // Deliveries that arrived meanwhile.
          this.publisher.kick();
        }
      });
  }

  private async apply(auto: boolean): Promise<void> {
    const repo = this.publisher.selfRepo();
    const local = this.ctx.config.publishBranch;
    let tmp: string | null = null;
    let held = false;
    let applied = false;
    let target: string | null = null;
    try {
      this.setPhase('preparing', 'Buscando a versão nova');
      const fresh = await this.check();
      if (fresh.unavailable) throw new UpdateError(fresh.unavailable);
      if (fresh.checkError) throw new UpdateError(fresh.checkError);
      if (!fresh.behind || !fresh.remoteSha || !fresh.source) {
        this.log('nada novo');
        return;
      }
      // The remote may have moved since the check that started this: an automatic update re-checks trust on what it will merge.
      if (auto && fresh.untrusted) {
        this.log(`atualização automática esperando o usuário: ${fresh.untrusted}`);
        this.blockedSha = fresh.remoteSha;
        return;
      }
      target = fresh.remoteSha;
      const r = repo as string;
      const head = git(r, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (!head.ok || head.out !== local) throw new UpdateError(`O checkout do Board \`${r}\` está em \`${head.out}\`, não em \`${local}\`.`);
      const origHead = git(r, ['rev-parse', local]).out;

      const diff = git(r, ['diff', '--name-only', `${local}...${target}`]);
      if (!diff.ok) throw new UpdateError(`Não consegui comparar \`${local}\` com \`${fresh.source}\`: ${diff.out}`);
      const files = diff.out.split('\n').filter(Boolean);
      const kind = isScreenOnly(files) ? 'ui' : 'server';
      const needsInstall = files.some((f) => PACKAGE_FILES.includes(f));
      const merging = fresh.ahead > 0;

      tmp = path.join(boardHome(), 'publish', `wt-update-${Date.now()}`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      const add = git(r, ['worktree', 'add', '--detach', tmp, local]);
      if (!add.ok) throw new UpdateError(`Não consegui criar a worktree temporária: ${add.out}`);
      const mainModules = path.join(r, 'node_modules');
      if (!needsInstall && fs.existsSync(mainModules)) linkDir(path.join(tmp, 'node_modules'), mainModules);

      this.setPhase('preparing', merging ? `Juntando \`${fresh.source}\` com as ${fresh.ahead} mudança(s) feitas aqui` : `Trazendo ${fresh.behind} mudança(s) de \`${fresh.source}\``);
      const m = merging
        ? git(tmp, ['merge', '--no-ff', '-m', `merge: atualização de ${fresh.source} (${target.slice(0, 7)})`, target])
        : git(tmp, ['merge', '--ff-only', target]);
      if (!m.ok) {
        const conflicts = git(tmp, ['diff', '--name-only', '--diff-filter=U']).out;
        git(tmp, ['merge', '--abort']);
        throw new UpdateError(
          conflicts
            ? `A versão nova conflita com mudanças feitas neste Board em: ${conflicts
                .split('\n')
                .map((f) => `\`${f}\``)
                .join(', ')}. Junte \`${fresh.source}\` à \`${local}\` à mão.`
            : `O merge de \`${fresh.source}\` falhou.${fence(m.out)}`,
        );
      }

      const env = { ...process.env };
      for (const k of Object.keys(env)) if (isBoardEnvKey(k) || k.startsWith('FAKE_CLAUDE')) delete env[k];
      if (needsInstall) await this.step(tmp, 'Instalando dependências', this.commands.install, env);
      // The remote's code was tested where it was made; a merge with local commits is new code.
      if (merging) await this.testStep(tmp, env);
      await this.step(tmp, kind === 'ui' ? 'Compilando a tela' : 'Compilando', kind === 'ui' ? this.commands.buildUi : this.commands.build, env);
      const builtUi = path.join(tmp, 'dist', 'ui');
      if (!fs.existsSync(path.join(builtUi, 'index.html'))) throw new UpdateError('O build não gerou `dist/ui/index.html`.');
      if (kind === 'server' && !fs.existsSync(path.join(tmp, 'dist', 'server', 'cli.js'))) throw new UpdateError('O build não gerou `dist/server/cli.js`.');

      if (kind === 'server') {
        held = true;
        this.publisher.setHold(true);
        this.setPhase('waiting', 'Esperando as execuções que estão começando; as que já rodam continuam depois do reinício');
        await this.publisher.waitIdleRunner();
      }

      this.setPhase('applying', `Aplicando na \`${local}\``);
      const nowHead = git(r, ['rev-parse', local]).out;
      if (nowHead !== origHead) throw new UpdateError(`A \`${local}\` andou durante a atualização (${origHead.slice(0, 7)} → ${nowHead.slice(0, 7)}).`);
      const dirty = git(r, ['status', '--porcelain', '--untracked-files=no']);
      if (!dirty.ok || dirty.out) throw new UpdateError(`O checkout do Board tem alterações não commitadas:${fence(dirty.out)}`);
      const backup = kind === 'server' ? this.publisher.backupDb() : null;
      const newHead = git(tmp, ['rev-parse', 'HEAD']).out;
      const ff = git(r, ['merge', '--ff-only', newHead]);
      if (!ff.ok) throw new UpdateError(`O fast-forward da \`${local}\` falhou.${fence(ff.out)}`);
      applied = true;
      syncDir(builtUi, path.join(r, 'dist', 'ui'));
      if (kind === 'server') {
        syncDir(path.join(tmp, 'dist', 'server'), path.join(r, 'dist', 'server'));
        if (needsInstall) await this.step(r, 'Instalando dependências no checkout do Board', this.commands.install, env);
      }
      this.ctx.service.setSetting(FAILURE_KEY, null);
      this.log(`aplicada: ${local} em ${newHead.slice(0, 7)} (${kind}${backup ? `, backup ${backup}` : ''})`);
      this.last = { ...this.last, ...this.compare(r, fresh.source) };
      this.ctx.bus.publish({ type: 'ui.updated' });
      this.publisher.dropTmp(r, tmp);
      tmp = null;

      if (kind === 'server') {
        this.setPhase('restarting', 'Reiniciando o servidor');
        await (this.opts.restart ?? (() => this.publisher.restartDetached(r)))();
      }
    } catch (err) {
      const message = err instanceof UpdateError ? err.message : `Falha interna: ${(err as Error).message}`;
      const full = applied ? `Atenção: a \`${local}\` já tinha avançado quando isto falhou; confira o checkout do Board e o \`dist/\`.\n\n${message}` : message;
      this.ctx.service.setSetting(FAILURE_KEY, { sha: target ?? this.last.remoteSha ?? '', message: full, at: nowIso() });
      this.log(`abortada: ${full}`);
      if (tmp && repo) this.publisher.dropTmp(repo, tmp);
      if (held) this.publisher.setHold(false);
    }
  }

  private async step(cwd: string, label: string, [cmd, args]: [string, string[]], env: NodeJS.ProcessEnv): Promise<void> {
    this.setPhase(this.phase === 'applying' ? 'applying' : 'preparing', label);
    const r = await this.run(cmd, args, cwd, env);
    if (!r.ok) throw new UpdateError(`${label}: \`${[cmd, ...args].join(' ')}\` falhou.${fence(r.out)}`);
  }

  /** Share of finished test files in the step, as the publication shows it (card #213). */
  private progress(cwd: string, label: string): (chunk: string) => void {
    const total = countTestFiles(cwd);
    return testProgress(total, (percent, done) => {
      this.detail = progressDetail(label, percent, done, total);
      this.changed();
    });
  }

  /** Tests, with one serial rerun before blaming the update (as the publication does, card #110). */
  private async testStep(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    const label = 'Rodando os testes';
    this.setPhase('preparing', label);
    const [cmd, args] = this.commands.test;
    if ((await this.run(cmd, args, cwd, env, this.progress(cwd, label))).ok) return;
    const retryLabel = 'Repetindo os testes, um arquivo por vez';
    this.setPhase('preparing', retryLabel);
    const [retryCmd, retryArgs] = this.commands.testRetry;
    const second = await this.run(retryCmd, retryArgs, cwd, env, this.progress(cwd, retryLabel));
    if (!second.ok) throw new UpdateError(`Rodando os testes: \`${[retryCmd, ...retryArgs].join(' ')}\` falhou também na segunda rodada.${fence(second.out)}`);
  }
}
