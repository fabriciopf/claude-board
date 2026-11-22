#!/usr/bin/env node
// Stand-in for the Claude Code CLI in tests: same flags, same stream-json shape, real MCP calls
// to the Board. The scenario comes from a "[fake:<name>]" tag in the prompt; a resume without a
// tag behaves as "success".
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--version')) {
  console.log('9.9.9 (Claude Code fake)');
  process.exit(0);
}

const prompt = await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d));
  process.stdin.on('end', () => resolve(s));
});

// Import classification: `--output-format json`, one result object with a JSON array as text.
if (get('--output-format') === 'json') {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, scenario: 'classify' }) + '\n');
  const sessions = JSON.parse(prompt.slice(prompt.indexOf('Sessões:') + 'Sessões:'.length));
  const items = sessions.map((s) => ({
    sessionId: s.sessionId,
    title: `Classificado: ${String(s.title).slice(0, 40)}`,
    status: /trivial/i.test(s.firstPrompt ?? '') ? 'ignore' : (s.signals?.length ? 'waiting_user' : 'done'),
    evidence: 'Evidência do classificador falso.',
    confidence: 0.8,
  }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(items) + '\n```', total_cost_usd: 0.004 }));
  process.exit(0);
}

const resume = get('--resume');
const sessionId = resume ?? get('--session-id') ?? randomUUID();
// A handoff session (D129) gets the card description again: like a resume, only the request before
// the package picks the scenario, and none means "success".
const handoffAt = prompt.indexOf('## Pacote de handoff');
const asked = handoffAt >= 0 ? prompt.slice(0, handoffAt) : prompt;
const scenario = /\[fake:([a-z_]+)\]/.exec(asked)?.[1] ?? (resume || handoffAt >= 0 ? 'success' : 'no_report');

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ args, prompt, sessionId, scenario, cwd: process.cwd(), cardEnv: process.env.DEXM_CARD_ID, legacyCardEnv: process.env.CLAUDE_BOARD_CARD_ID, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT }) + '\n',
  );
}

const out = (ev) => process.stdout.write(JSON.stringify({ ...ev, session_id: sessionId }) + '\n');
const assistant = (content) => out({ type: 'assistant', message: { content, usage: { input_tokens: 100, output_tokens: 20 } } });
const result = (extra) =>
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 0.12, usage: { input_tokens: 300, output_tokens: 60 }, ...extra });

out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart' });
out({ type: 'system', subtype: 'init', model: 'fake-model', cwd: process.cwd(), tools: [] });
out({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 3600, status: 'allowed' },
      seven_day: { utilization: 0.3, resetsAt: Math.floor(Date.now() / 1000) + 86400, status: 'allowed' },
    },
  },
});

async function board() {
  const cfg = JSON.parse(fs.readFileSync(get('--mcp-config'), 'utf8')).mcpServers['dexm'];
  const client = new Client({ name: 'fake-claude', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
  return client;
}

async function call(client, name, input) {
  assistant([{ type: 'tool_use', id: randomUUID(), name: `mcp__dexm__${name}`, input }]);
  const r = await client.callTool({ name, arguments: input });
  out({ type: 'user', message: { content: [{ type: 'tool_result', content: r.content, is_error: !!r.isError }] } });
  return r;
}

switch (scenario) {
  case 'success': {
    const c = await board();
    assistant([{ type: 'text', text: 'Vou quebrar a tarefa em passos.' }]);
    // Like the real one: the first run names the task (the system prompt asks for it only then).
    if (/card_rename/.test(get('--append-system-prompt') ?? '')) await call(c, 'card_rename', { name: 'Documento de instalação' });
    await call(c, 'card_checklist_add', { items: ['Ler o card', 'Escrever o documento'] });
    await call(c, 'card_checklist_check', { item: 'Ler o card' });
    await call(c, 'card_comment', { text: 'Documento em andamento.' });
    await call(c, 'card_submit_for_review', { summary: 'Escrevi o documento em README.md. Confira a seção de instalação.' });
    result({ result: 'Pronto.' });
    break;
  }
  case 'split': {
    // Like the real one when the list holds independent tasks: name the card, split it, stop.
    const c = await board();
    if (/card_rename/.test(get('--append-system-prompt') ?? '')) await call(c, 'card_rename', { name: 'Três relatórios' });
    await call(c, 'card_split', {
      tasks: [
        { title: 'Relatório de vendas', description: 'Monte o relatório de vendas. [fake:success]' },
        { title: 'Relatório de estoque', description: 'Monte o relatório de estoque. [fake:success]' },
      ],
    });
    result({ result: 'Dividi o card em duas tarefas.' });
    break;
  }
  case 'ask': {
    const c = await board();
    await call(c, 'card_ask_user', { question: 'Qual é a branch base?', options: ['main', 'production'] });
    result({ result: 'Perguntei ao usuário.', total_cost_usd: 0.05 });
    break;
  }
  case 'slow': {
    // A run still going when a publication arrives (D42 QA): it must end on its own, not be interrupted.
    assistant([{ type: 'text', text: 'Trabalhando devagar…' }]);
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CLAUDE_SLOW_MS ?? 15000)));
    const c = await board();
    await call(c, 'card_submit_for_review', { summary: 'Terminei a tarefa demorada.' });
    result({ result: 'Pronto, devagar.' });
    break;
  }
  case 'comment_midrun':
  case 'comment_before_submit':
  case 'comment_after_submit': {
    // The user comments while the run is in progress (D104): mid-run, right before the delivery, or
    // after it. The text of every tool reply goes to the log, to check what the run got to read.
    const c = await board();
    const cardId = process.env.DEXM_CARD_ID;
    const userComment = (body) =>
      fetch(`${process.env.DEXM_URL}/api/cards/${cardId}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) });
    const replies = [];
    const logged = async (name, input) => {
      const r = await call(c, name, input);
      replies.push({ name, isError: !!r.isError, text: r.content.map((x) => x.text).join('\n') });
      return r;
    };
    if (scenario === 'comment_midrun') {
      await userComment('Use tabela, não lista.');
      await logged('card_comment', { text: 'Montando o relatório.' });
      await logged('card_submit_for_review', { summary: 'Relatório em tabela.' });
    } else if (scenario === 'comment_before_submit') {
      await userComment('Inclua o mês de outubro.');
      const first = await logged('card_submit_for_review', { summary: 'Relatório sem outubro.' });
      if (first.isError) await logged('card_submit_for_review', { summary: 'Relatório com outubro.' });
    } else {
      await logged('card_submit_for_review', { summary: 'Relatório pronto.' });
      await userComment('Faltou o total no rodapé.');
    }
    if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ scenario, replies }) + '\n');
    result({ result: 'Pronto.' });
    break;
  }
  case 'no_report':
    assistant([{ type: 'text', text: 'Terminei: criei o arquivo notas.md.' }]);
    result({ result: 'Terminei: criei o arquivo notas.md.' });
    break;
  case 'max_turns':
    assistant([{ type: 'text', text: 'Ainda trabalhando…' }]);
    result({ subtype: 'error_max_turns', is_error: true, num_turns: Number(get('--max-turns') ?? 40), result: undefined });
    break;
  case 'crash':
    process.stderr.write('boom: falha simulada da API\n');
    process.exit(1);
    break;
  case 'hang': {
    // A grandchild proves the whole tree dies on "Parar".
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (process.env.FAKE_CLAUDE_PIDS) fs.writeFileSync(process.env.FAKE_CLAUDE_PIDS, JSON.stringify([process.pid, child.pid]));
    assistant([{ type: 'text', text: 'Pensando por muito tempo…' }]);
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    break;
  }
  default:
    process.stderr.write(`cenário desconhecido: ${scenario}\n`);
    process.exit(2);
}
