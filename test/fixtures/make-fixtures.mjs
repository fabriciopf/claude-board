// Generates the synthetic ~/.claude used by the importer tests. Run: node test/fixtures/make-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-home');
const projA = path.join(root, 'projects', 'C--work-proj-a');
const projB = path.join(root, 'projects', 'C--work-proj-b');
let clock = Date.parse('2026-11-01T12:00:00Z');
const ts = () => new Date((clock += 60000)).toISOString();
const base = (sessionId, cwd) => ({ sessionId, cwd, gitBranch: 'main', version: '2.1.325', isSidechain: false, timestamp: ts() });
const user = (sid, cwd, content, extra = {}) => ({ type: 'user', ...base(sid, cwd), message: { role: 'user', content }, ...extra });
let mid = 0;
const assistant = (sid, cwd, content, extra = {}) => ({ type: 'assistant', ...base(sid, cwd), message: { id: `msg_${++mid}`, role: 'assistant', content, usage: { input_tokens: 10, output_tokens: 5 } }, ...extra });
const write = (dir, name, events) => fs.writeFileSync(path.join(dir, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

write(projA, 's-todos.jsonl', [
  { type: 'permission-mode', permissionMode: 'default', sessionId: 's-todos' },
  user('s-todos', 'C:/work/proj-a', 'Implemente o export CSV do relatório de repasse'),
  { type: 'api-request-blob', hash: 'x', content: [{ type: 'text', text: 'enorme' }] },
  assistant('s-todos', 'C:/work/proj-a', [
    { type: 'text', text: 'Vou planejar.' },
    { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
      { content: 'Mapear colunas', status: 'completed', activeForm: 'Mapeando' },
      { content: 'Gerar o CSV com BOM', status: 'in_progress', activeForm: 'Gerando' },
      { content: 'Testar no Excel', status: 'pending', activeForm: 'Testando' },
    ] } },
  ]),
  user('s-todos', 'C:/work/proj-a', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  assistant('s-todos', 'C:/work/proj-a', [{ type: 'text', text: 'Comecei pelo mapeamento das colunas.' }]),
  { type: 'ai-title', aiTitle: 'Export CSV do repasse', sessionId: 's-todos' },
]);

write(projA, 's-question.jsonl', [
  user('s-question', 'C:/work/proj-a', 'Crie a branch da ABC-123 e suba o ajuste'),
  assistant('s-question', 'C:/work/proj-a', [{ type: 'text', text: 'Preparei o ajuste localmente.\n\nQuer que eu use a branch **production** ou **main** como base?' }]),
]);

write(projA, 's-done.jsonl', [
  user('s-done', 'C:/work/proj-a', 'Corrija o typo no README'),
  assistant('s-done', 'C:/work/proj-a', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:/work/proj-a/README.md', old_string: 'teh', new_string: 'the' } }]),
  user('s-done', 'C:/work/proj-a', [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }]),
  { type: 'pr-link', prNumber: 12, prUrl: 'https://github.com/acme/proj-a/pull/12', prRepository: 'acme/proj-a', sessionId: 's-done', timestamp: ts() },
  assistant('s-done', 'C:/work/proj-a', [{ type: 'text', text: 'Pronto, corrigi e abri o PR.' }]),
  { type: 'ai-title', aiTitle: 'Typo no README', sessionId: 's-done' },
]);
write(path.join(projA, 's-done', 'subagents'), 'agent-1.jsonl', [
  user('s-sub', 'C:/work/proj-a', 'subagente: isto não é uma sessão do usuário'),
]);

write(projB, 's-noise.jsonl', [
  user('s-noise', 'C:/work/proj-b', 'Base directory for this skill: ...', { isMeta: true }),
  user('s-noise', 'C:/work/proj-b', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
  user('s-noise', 'C:/work/proj-b', '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>o PR 44</command-args>'),
  user('s-noise', 'C:/work/proj-b', 'Corrija o teste que quebrou'),
  assistant('s-noise', 'C:/work/proj-b', [{ type: 'text', text: 'Subagente: devo continuar?' }], { isSidechain: true }),
  assistant('s-noise', 'C:/work/proj-b', [{ type: 'text', text: 'Vou rodar os testes.' }]),
  { type: 'system', subtype: 'api_error', error: { status: 529 }, sessionId: 's-noise', timestamp: ts() },
]);

write(projB, 's-ask.jsonl', [
  user('s-ask', 'C:/work/proj-b', 'Monte o plano de monetização'),
  assistant('s-ask', 'C:/work/proj-b', [{ type: 'tool_use', id: 't3', name: 'AskUserQuestion', input: { questions: [{ question: 'Qual régua de preço usar?', header: 'Preço', options: [] }] } }]),
]);

write(projB, 's-trivial.jsonl', [
  user('s-trivial', 'C:/work/proj-b', 'trivial: que horas são?'),
  assistant('s-trivial', 'C:/work/proj-b', [{ type: 'text', text: 'Não tenho relógio, mas posso rodar `date`.' }]),
]);

fs.writeFileSync(
  path.join(root, 'history.jsonl'),
  [
    { display: '/clear', pastedContents: {}, timestamp: Date.parse('2026-09-01T10:00:00Z'), project: 'C:/work/old', sessionId: 'h-only' },
    { display: 'Revisar a planilha de custos do Hugo', pastedContents: {}, timestamp: Date.parse('2026-09-01T10:01:00Z'), project: 'C:/work/old', sessionId: 'h-only' },
    { display: 'Implemente o export CSV do relatório de repasse', pastedContents: {}, timestamp: Date.parse('2026-11-01T12:01:00Z'), project: 'C:/work/proj-a', sessionId: 's-todos' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n',
);
console.log('fixtures em', root);
