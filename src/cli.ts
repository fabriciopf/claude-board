import { loadConfig, paths } from './config.js';
import { openDb } from './db/index.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { buildApp } from './server/app.js';
import { EventBus } from './server/bus.js';
import { BoardService } from './service/board.js';
import type { AppContext } from './context.js';
import { runStdioProxy } from './mcp/stdio.js';
import { Runner } from './runner/runner.js';
import { hooksStatus, installHooks, uninstallHooks } from './hooks/install.js';
import { Importer } from './importer/importer.js';
import { UsageTracker } from './service/usage.js';
import { AgendaWatcher } from './service/agenda.js';
import { Publisher } from './publish/publisher.js';
import { relaunch } from './publish/relaunch.js';
import { claudeHomeDir } from './config.js';
import readline from 'node:readline';

const HELP = `Claude Board — quadro de tarefas que o Claude Code executa sozinho

Uso: claude-board <comando> [opções]

  start [--port N] [--host H] [--allow-remote]   sobe API, interface, runner e MCP
  doctor                                         verifica o que falta na máquina
  mcp [--url http://127.0.0.1:4317]              servidor MCP por stdio (repassa ao Board)
  hooks install | uninstall | status             hooks do Claude Code (com backup do settings.json)
  import scan [--no-triage]                      lê o histórico do Claude Code, sem LLM
  import classify [--ids a,b] [--yes]            classifica sessões com um modelo barato (pede confirmação)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function createContext(): AppContext {
  const config = loadConfig();
  const db = openDb(paths.db());
  const bus = new EventBus();
  const service = new BoardService(db, bus);
  service.seed();
  const ctx: AppContext = { db, config, bus, service };
  ctx.importer = new Importer(ctx);
  ctx.usage = new UsageTracker(service, bus);
  if (!ctx.usage.get()) ctx.usage.seedFromTranscripts(paths.transcripts());
  return ctx;
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [s/N] `, resolve));
  rl.close();
  return /^(s|sim|y|yes)$/i.test(answer.trim());
}

async function importCommand(args: string[]): Promise<void> {
  const ctx = createContext();
  const importer = ctx.importer as Importer;
  const sub = args[0];
  if (sub === 'scan') {
    console.log(`Lendo ${claudeHomeDir(ctx.config)}…`);
    const r = await importer.scan({ createTriage: !args.includes('--no-triage') });
    console.log(
      [
        `${r.files} transcripts (${r.scanned} lidos, ${r.unchanged} sem mudança, ${r.ownSessions} do próprio Board) em ${(r.durationMs / 1000).toFixed(1)} s`,
        `${r.sessions} sessões no total; ${r.withSignals} com sinal de pendência; ${r.partial} só com history.jsonl (evidência parcial)`,
        `${r.triageCreated} card(s) novo(s) na Triagem`,
        `Passo 2 (classify): ${r.classifyCandidates} sessões candidatas, ≈ ${r.classifyEstimateTokens.toLocaleString('pt-BR')} tokens com ${ctx.config.classificationModel}`,
      ].join('\n'),
    );
  } else if (sub === 'classify') {
    const ids = flag(args, '--ids')?.split(',').filter(Boolean);
    const est = importer.estimate(ids);
    if (!est.sessions) {
      console.log('Nada a classificar: rode "claude-board import scan" antes, ou passe --ids.');
      return;
    }
    console.log(`Vou classificar ${est.sessions} sessões em ${est.batches} lote(s) com o modelo ${est.model}, ≈ ${est.tokens.toLocaleString('pt-BR')} tokens.`);
    console.log('Cada lote abre um "claude -p" com --safe-mode (sem CLAUDE.md, plugins nem MCPs) e manda só o resumo de cada sessão.');
    if (!args.includes('--yes') && !(await confirm('Continuar?'))) {
      console.log('Cancelado.');
      return;
    }
    const r = await importer.classify({ sessionIds: ids, confirm: true, onProgress: (d, t) => console.log(`  ${d}/${t}`) });
    console.log(`${r.classified} classificadas (${r.ignored} ignoradas), ${r.failedBatches} lote(s) com falha.`);
    for (const e of r.errors) console.log(`  erro: ${e}`);
  } else {
    throw new Error('Use: claude-board import scan [--no-triage] | classify [--ids a,b] [--yes]');
  }
  ctx.db.close();
}

async function start(args: string[]): Promise<void> {
  const ctx = createContext();
  const port = Number(flag(args, '--port') ?? ctx.config.port);
  const host = flag(args, '--host') ?? ctx.config.host;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && !args.includes('--allow-remote')) {
    throw new Error(`Recusando escutar em ${host}: o Board não tem autenticação. Use --allow-remote se souber o que está fazendo.`);
  }
  ctx.config = { ...ctx.config, port, host };
  ctx.startArgs = ['start', ...args];
  const runner = new Runner(ctx);
  ctx.runner = runner;
  const publisher = new Publisher(ctx);
  ctx.publisher = publisher;
  const app = await buildApp(ctx, { allowAnyHost: !isLoopback });
  await app.listen({ port, host });
  runner.start();
  publisher.startup();
  const agenda = new AgendaWatcher(ctx);
  ctx.agenda = agenda;
  agenda.start();
  console.log(`Claude Board em http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Encerrando. As execuções em andamento continuam; o próximo "claude-board start" volta a acompanhá-las.');
    agenda.close();
    await runner.close();
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  ctx.shutdown = stop;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'start':
        await start(args);
        break;
      case 'mcp': {
        // stdout belongs to the MCP protocol here: nothing else may print to it.
        const config = loadConfig();
        const url = flag(args, '--url') ?? process.env.CLAUDE_BOARD_URL ?? `http://127.0.0.1:${config.port}`;
        await runStdioProxy(url);
        break;
      }
      case 'relaunch':
        await relaunch(args);
        break;
      case 'import':
        await importCommand(args);
        break;
      case 'hooks': {
        const config = loadConfig();
        const sub = args[0];
        if (sub === 'install') {
          const r = installHooks(config);
          console.log(`Hooks instalados em ${r.status.settingsPath} (${r.status.events.join(', ')}).`);
          console.log(r.backup ? `Backup do settings.json anterior: ${r.backup}` : 'Não havia settings.json; criei um.');
        } else if (sub === 'uninstall') {
          const r = uninstallHooks(config);
          console.log(`Hooks do Claude Board removidos de ${r.status.settingsPath}.`);
          if (r.backup) console.log(`Backup: ${r.backup}`);
        } else if (sub === 'status' || sub === undefined) {
          const s = hooksStatus(config);
          console.log(`${s.installed ? 'Instalados' : 'Não instalados'} em ${s.settingsPath}${s.events.length ? ` (${s.events.join(', ')})` : ''}.`);
        } else {
          throw new Error('Use: claude-board hooks install | uninstall | status');
        }
        break;
      }
      case 'doctor': {
        const checks = await runDoctor(loadConfig());
        console.log(formatDoctor(checks));
        process.exitCode = checks.some((c) => c.required && !c.ok) ? 1 : 0;
        break;
      }
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      default:
        console.error(`Comando desconhecido: ${cmd}\n\n${HELP}`);
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(`Erro: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
