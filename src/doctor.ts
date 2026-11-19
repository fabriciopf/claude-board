import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import spawn from 'cross-spawn';
import { boardHome, claudeHomeDir, expandHome, type Config } from './config.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** false = only a warning, the Board still works. */
  required: boolean;
  detail: string;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawn.sync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    if (r.error) return { ok: false, out: r.error.message };
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch (err) {
    return { ok: false, out: (err as Error).message };
  }
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

export async function runDoctor(config: Config, opts: { checkPort?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'Node.js',
    ok: major > 22 || (major === 22 && minor >= 13),
    required: true,
    detail: `v${process.versions.node} (precisa de 22.13+ por causa do node:sqlite)`,
  });

  const claude = run(config.claudeBin, [...config.claudeArgsPrefix, '--version']);
  checks.push({
    name: 'Claude Code no PATH',
    ok: claude.ok,
    required: true,
    detail: claude.ok ? `${config.claudeBin}: ${claude.out.split('\n')[0]}` : `não achei "${config.claudeBin}": ${claude.out}`,
  });

  const home = claudeHomeDir(config);
  const projects = path.join(home, 'projects');
  const history = path.join(home, 'history.jsonl');
  checks.push({
    name: 'Pasta do Claude Code',
    ok: fs.existsSync(projects),
    required: false,
    detail: fs.existsSync(projects)
      ? `${home} (${fs.readdirSync(projects).length} projetos${fs.existsSync(history) ? ', com history.jsonl' : ', sem history.jsonl'})`
      : `${projects} não existe; ajuste claudeHome na configuração`,
  });

  const settingsFile = path.join(home, 'settings.json');
  let cleanup: number | undefined;
  try {
    cleanup = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).cleanupPeriodDays;
  } catch {
    /* settings.json missing or invalid: report the default */
  }
  checks.push({
    name: 'Retenção dos transcripts',
    ok: (cleanup ?? 30) > 30,
    required: false,
    detail:
      cleanup === undefined
        ? 'cleanupPeriodDays não definido: o Claude Code apaga transcripts com mais de 30 dias'
        : `cleanupPeriodDays = ${cleanup}`,
  });

  if (config.workspaceDir) {
    const ws = path.resolve(expandHome(config.workspaceDir));
    const hasClaude = fs.existsSync(path.join(ws, '.claude')) || fs.existsSync(path.join(ws, 'CLAUDE.md'));
    checks.push({
      name: 'Workspace',
      ok: fs.existsSync(ws),
      required: true,
      detail: fs.existsSync(ws) ? `${ws}${hasClaude ? ' (com CLAUDE.md/.claude: as execuções carregam as mesmas skills e configurações do VS Code)' : ' (sem CLAUDE.md nem .claude)'}` : `${ws} não existe`,
    });
  } else {
    checks.push({ name: 'Workspace', ok: false, required: false, detail: 'workspaceDir não definido: as execuções rodam fora do workspace, sem o CLAUDE.md e as skills do projeto' });
  }

  const git = run('git', ['--version']);
  checks.push({ name: 'git', ok: git.ok, required: false, detail: git.ok ? git.out : `git não encontrado: ${git.out}` });

  let writable = false;
  try {
    fs.mkdirSync(boardHome(), { recursive: true });
    const probe = path.join(boardHome(), '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  checks.push({ name: 'Pasta do Board', ok: writable, required: true, detail: boardHome() });

  if (opts.checkPort !== false) {
    const free = await portFree(config.host, config.port);
    checks.push({
      name: 'Porta',
      ok: free,
      required: false,
      detail: free ? `${config.host}:${config.port} livre` : `${config.host}:${config.port} ocupada (o Board já está rodando?)`,
    });
  }
  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((c) => `${c.ok ? 'OK   ' : c.required ? 'FALTA' : 'AVISO'}  ${c.name}: ${c.detail}`)
    .join('\n');
}
