import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardHome, expandHome, protectedBranchList } from '../config.js';
import type { AppContext } from '../context.js';
import { nowIso } from '../db/index.js';
import { slugify } from '../runner/worktree.js';
import { git, runCommand, type CmdResult } from './git.js';
import { isBoardEnvKey } from '../shared/brand.js';

/**
 * Public mirror of the Board (D66). The Board's own repository has no remote: the public copy lives
 * in another checkout (`mirrorRepoPath`) whose origin is on GitHub. When a card of the Board reaches
 * "Concluída", the tree of the publish branch, without the excluded paths (DECISIONS.md), becomes one
 * commit on top of the mirror's base branch, is pushed to a `cb/<id>-<slug>` branch and gets a draft
 * PR. Everything happens in the mirror's object store: its working tree and checked-out branch stay
 * as they are. Never forced, never to a protected branch.
 */

export interface MirrorOptions {
  run?: (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<CmdResult>;
}

export type MirrorOutcome =
  | { status: 'off' }
  | { status: 'unchanged'; branch: string | null; prUrl: string | null }
  | { status: 'blocked'; hits: string[] }
  | { status: 'pushed'; branch: string; commit: string; prUrl: string | null; updated: boolean }
  | { status: 'failed'; message: string };

class MirrorError extends Error {}

const fence = (text: string) => `\n\n\`\`\`\n${text.trim().split('\n').slice(-30).join('\n').replace(/```/g, "'''")}\n\`\`\``;

/** owner/name of a GitHub remote URL (https or ssh), or null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Comma- or line-separated list, blanks dropped. */
export function splitList(value: string | null | undefined): string[] {
  return String(value ?? '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Lines a diff adds that contain one of the terms (case-insensitive), as `file: line`. A guard for a
 * public repository: a private name that slips into the code stops the push.
 */
export function blockedHits(diff: string, terms: string[], max = 15): string[] {
  const lower = terms.map((t) => t.toLowerCase());
  if (!lower.length) return [];
  const hits: string[] = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const text = line.slice(1);
    const t = text.toLowerCase();
    const term = lower.find((x) => t.includes(x));
    if (term) hits.push(`${file}: ${text.trim().slice(0, 160)} (termo "${term}")`);
    if (hits.length >= max) break;
  }
  return hits;
}

/** The same check on a piece of text (PR title, commit message). */
export function textHits(label: string, text: string, terms: string[]): string[] {
  const t = text.toLowerCase();
  return terms.filter((x) => t.includes(x.toLowerCase())).map((x) => `${label} (termo "${x}")`);
}

export class Mirror {
  private chain: Promise<unknown> = Promise.resolve();
  private run: NonNullable<MirrorOptions['run']>;

  constructor(
    private ctx: AppContext,
    private selfRepo: () => string | null,
    opts: MirrorOptions = {},
  ) {
    this.run = opts.run ?? runCommand;
  }

  enabled(): boolean {
    return !!String(this.ctx.config.mirrorRepoPath ?? '').trim();
  }

  /** Queues the card; one mirror at a time, in the order the cards were concluded. */
  request(cardId: number): Promise<MirrorOutcome> {
    const p = this.chain.then(() => this.mirrorCard(cardId));
    this.chain = p.catch(() => undefined);
    return p;
  }

  async whenIdle(): Promise<void> {
    await this.chain;
  }

  private log(line: string): void {
    try {
      fs.appendFileSync(path.join(boardHome(), 'publish.log'), `${nowIso()} espelho: ${line}\n`);
    } catch {
      /* logging must never break the mirror */
    }
  }

  private comment(cardId: number, body: string): void {
    try {
      this.ctx.service.addComment(cardId, { author: 'system', bodyMd: body });
    } catch {
      /* the card may have been deleted */
    }
  }

  async mirrorCard(cardId: number): Promise<MirrorOutcome> {
    if (!this.enabled()) return { status: 'off' };
    try {
      const out = await this.doMirror(cardId);
      this.log(`card #${cardId}: ${out.status}`);
      return out;
    } catch (err) {
      const message = err instanceof MirrorError ? err.message : `Falha interna: ${(err as Error).message}`;
      this.log(`card #${cardId}: falhou: ${message}`);
      this.ctx.service.recordEvent(cardId, 'mirror_failed', {}, 'system');
      this.comment(cardId, `O push para o repositório público falhou e nenhum PR foi aberto.\n\n${message}`);
      return { status: 'failed', message };
    }
  }

  /** Environment that authenticates git and gh as `mirrorGhUser`, without switching the active gh account. */
  private async authEnv(mirror: string): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const k of Object.keys(env)) if (isBoardEnvKey(k)) delete env[k];
    const user = String(this.ctx.config.mirrorGhUser ?? '').trim();
    if (!user) return env;
    const tok = await this.run('gh', ['auth', 'token', '--user', user], mirror, env);
    const token = tok.out.split('\n').pop()?.trim() ?? '';
    if (!tok.ok || !token) throw new MirrorError(`Não consegui o token do gh da conta \`${user}\` (\`gh auth login\` com ela).${fence(tok.out)}`);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    // Passed by environment, never on the command line: the token does not show in the process list.
    return {
      ...env,
      GH_TOKEN: token,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    };
  }

  private async must(label: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    const r = await this.run(cmd, args, cwd, env);
    if (!r.ok) throw new MirrorError(`${label}: \`${[cmd, ...args].join(' ')}\` falhou.${fence(r.out)}`);
    return r.out;
  }

  private async doMirror(cardId: number): Promise<MirrorOutcome> {
    const { config, service } = this.ctx;
    const card = service.getCard(cardId);
    const self = this.selfRepo();
    if (!self) throw new MirrorError('Não achei o repositório do Board (configure `selfRepoPath`).');
    const mirror = path.resolve(expandHome(String(config.mirrorRepoPath).trim()));
    if (!fs.existsSync(mirror) || !git(mirror, ['rev-parse', '--git-dir']).ok) throw new MirrorError(`\`${mirror}\` não é um repositório git.`);
    // The configured URL, before any insteadOf rewrite: it says which GitHub repository the PR goes to.
    const originUrl = git(mirror, ['config', '--get', 'remote.origin.url']);
    if (!originUrl.ok) throw new MirrorError(`O repositório \`${mirror}\` não tem o remoto \`origin\`.`);
    const slug = githubSlug(originUrl.out);
    const source = config.publishBranch;
    const base = String(config.mirrorBaseBranch ?? '').trim() || 'main';
    const terms = splitList(config.mirrorBlockTerms);
    const env = await this.authEnv(mirror);

    // 1. The public base, fresh.
    await this.must('Atualizar o repositório público', 'git', ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], mirror, env);
    const baseSha = git(mirror, ['rev-parse', `refs/remotes/origin/${base}`]);
    if (!baseSha.ok) throw new MirrorError(`A branch \`${base}\` não existe no \`origin\` do repositório público.`);

    // 2. The Board's publish branch, into a private ref of the mirror (nothing checked out changes).
    const sourceRef = `refs/board/${source}`;
    const fetched = git(mirror, ['fetch', '--quiet', '--no-tags', self, `+refs/heads/${source}:${sourceRef}`]);
    if (!fetched.ok) throw new MirrorError(`Não consegui trazer a \`${source}\` do Board:${fence(fetched.out)}`);
    const sourceSha = git(mirror, ['rev-parse', sourceRef]).out;

    // 3. Its tree without the excluded paths, through a throwaway index.
    const index = path.join(os.tmpdir(), `cb-mirror-index-${process.pid}-${Date.now()}`);
    const ienv = { ...process.env, GIT_INDEX_FILE: index };
    let tree: string;
    try {
      const rt = git(mirror, ['read-tree', sourceRef], ienv);
      if (!rt.ok) throw new MirrorError(`\`git read-tree\` falhou:${fence(rt.out)}`);
      for (const p of splitList(config.mirrorExclude)) {
        // -f: the same path loose in the public checkout makes git refuse; --cached never touches that file.
        const rm = git(mirror, ['rm', '--cached', '-r', '-f', '-q', '--ignore-unmatch', '--', p], ienv);
        if (!rm.ok) throw new MirrorError(`Não consegui tirar \`${p}\` da árvore:${fence(rm.out)}`);
      }
      const wt = git(mirror, ['write-tree'], ienv);
      if (!wt.ok) throw new MirrorError(`\`git write-tree\` falhou:${fence(wt.out)}`);
      tree = wt.out;
    } finally {
      fs.rmSync(index, { force: true });
    }

    // 4. The card's branch: reuse it while its PR is open (the new commit goes on top), else a new name.
    const stem = `cb/${card.id}-${slugify(card.title)}`;
    let branch = stem;
    let parent = baseSha.out;
    let openPr: string | null = null;
    for (let n = 2; ; n++) {
      if (protectedBranchList(config.protectedBranches).some((p) => (p.endsWith('*') ? branch.startsWith(p.slice(0, -1)) : branch === p))) {
        throw new MirrorError(`A branch \`${branch}\` é protegida.`);
      }
      const remote = await this.must('Consultar a branch no repositório público', 'git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], mirror, env);
      if (!remote.trim()) break;
      const pr = slug ? await this.run('gh', ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url'], mirror, env) : null;
      const url = pr?.ok ? pr.out.trim() : '';
      if (url) {
        await this.must('Trazer a branch do card', 'git', ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], mirror, env);
        parent = git(mirror, ['rev-parse', `refs/remotes/origin/${branch}`]).out;
        openPr = url;
        break;
      }
      branch = `${stem}-${n}`;
      if (n > 20) throw new MirrorError(`Branches \`${stem}-*\` demais no repositório público.`);
    }

    const parentTree = git(mirror, ['rev-parse', `${parent}^{tree}`]).out;
    if (parentTree === tree) {
      const where = openPr ? `O PR aberto já tem a \`${source}\` atual: ${openPr}` : `O repositório público (\`${base}\`) já está igual à \`${source}\` do Board.`;
      this.comment(cardId, `Nada a enviar ao repositório público. ${where}`);
      return { status: 'unchanged', branch: openPr ? branch : null, prUrl: openPr };
    }

    // 5. Guard: private terms in the lines added, the title or the message.
    const title = `Card #${card.id}: ${card.title}`;
    const diff = git(mirror, ['diff', '--unified=0', parentTree, tree]).out;
    const hits = [...textHits('título do PR', title, terms), ...blockedHits(diff, terms)];
    if (hits.length) {
      service.recordEvent(cardId, 'mirror_blocked', { hits: hits.length }, 'system');
      this.comment(
        cardId,
        `Não enviei ao repositório público: o que iria tem termos da lista \`mirrorBlockTerms\`.\n\n${hits.map((h) => `- ${h}`).join('\n')}\n\nTire os termos do código (ou da lista, em Configurações) e comente no card para tentar de novo.`,
      );
      return { status: 'blocked', hits };
    }

    // 6. Commit (author = the mirror's own git identity) and push, never forced.
    const stat = git(mirror, ['diff', '--stat', parentTree, tree]).out;
    const message = `${title}\n\nSynced from the Board's ${source} (${sourceSha.slice(0, 7)}).`;
    const commit = await this.must('Criar o commit', 'git', ['commit-tree', tree, '-p', parent, '-m', message], mirror, env);
    const sha = commit.trim().split('\n').pop() as string;
    await this.must('Push', 'git', ['push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`], mirror, env);
    service.recordEvent(cardId, 'mirrored', { branch, commit: sha, source: sourceSha }, 'system');

    // 7. The PR.
    let prUrl = openPr;
    if (!prUrl && slug) {
      const body = [
        `${title}`,
        '',
        `Tree of the Board's \`${source}\` (${sourceSha.slice(0, 7)})${splitList(config.mirrorExclude).length ? `, without ${splitList(config.mirrorExclude).map((p) => `\`${p}\``).join(', ')}` : ''}.`,
        '',
        '```',
        stat,
        '```',
      ].join('\n');
      const pr = await this.run('gh', ['pr', 'create', '--repo', slug, '--base', base, '--head', branch, '--draft', '--title', title, '--body', body], mirror, env);
      if (!pr.ok) {
        this.comment(cardId, `Push feito na branch \`${branch}\` (\`${sha.slice(0, 7)}\`) do repositório público, mas o PR não abriu.${fence(pr.out)}`);
        return { status: 'pushed', branch, commit: sha, prUrl: null, updated: false };
      }
      prUrl = /https:\/\/\S+/.exec(pr.out)?.[0] ?? null;
    }
    if (prUrl) {
      try {
        service.addLink(cardId, { kind: 'pr', value: prUrl, title: `PR (rascunho) no repositório público` }, 'system');
      } catch {
        /* the card may have been deleted */
      }
    }
    const lines = [
      openPr
        ? `Repositório público atualizado: novo commit \`${sha.slice(0, 7)}\` na branch \`${branch}\`, no PR que já estava aberto: ${openPr}`
        : `Push feito para o repositório público na branch \`${branch}\` (\`${sha.slice(0, 7)}\`)${prUrl ? ` e PR aberto em rascunho: ${prUrl}` : slug ? '' : '; o \`origin\` não é do GitHub, então não abri PR'}.`,
      `É a \`${source}\` do Board (\`${sourceSha.slice(0, 7)}\`) inteira sobre a \`${base}\` pública: inclui o que outros cards publicaram e ainda não estava lá.`,
      fence(stat).trim(),
    ];
    this.comment(cardId, lines.join('\n\n'));
    return { status: 'pushed', branch, commit: sha, prUrl, updated: !!openPr };
  }
}
