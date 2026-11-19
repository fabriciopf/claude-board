import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Importer } from '../src/importer/importer.js';
import { endsWithQuestion, promptText } from '../src/importer/parse.js';
import { RuleError } from '../src/service/rules.js';
import { makeContext, tempDir } from './helpers.js';

const fixtures = path.resolve('test/fixtures/claude-home');
const claudeHome = tempDir('cb-import-');
fs.cpSync(fixtures, claudeHome, { recursive: true });
const ctx = makeContext({ claudeHome, claudeBin: process.execPath, claudeArgsPrefix: [path.resolve('test/fake-claude.mjs')] });
const importer = new Importer(ctx);
ctx.importer = importer;

const session = (id: string) => importer.get(id);
const kinds = (id: string) => session(id).signals.map((s) => s.kind).sort();

describe('scan (step 1, deterministic)', () => {
  let first: Awaited<ReturnType<Importer['scan']>>;
  beforeAll(async () => {
    first = await importer.scan();
  });

  it('reads every top-level transcript and skips subagent files', () => {
    expect(first.files).toBe(6);
    const ids = importer.list().map((s) => s.sessionId).sort();
    expect(ids).toEqual(['h-only', 's-ask', 's-done', 's-noise', 's-question', 's-todos', 's-trivial']);
  });

  it('finds the sessions with an open todo or a question at the end', () => {
    expect(kinds('s-todos')).toEqual(['pending_todos']);
    expect(session('s-todos').signals[0].detail).toMatch(/2 item\(ns\).*Gerar o CSV com BOM; Testar no Excel/);
    expect(kinds('s-question')).toEqual(['ended_with_question']);
    expect(kinds('s-ask')).toEqual(['unanswered_ask']);
    expect(kinds('s-noise')).toEqual(['error']);
    expect(kinds('s-done')).toEqual([]);
    expect(kinds('s-trivial')).toEqual([]);
  });

  it('extracts title, prompts, files and PR links, ignoring meta, sidechain and empty commands', () => {
    const done = session('s-done');
    expect(done.title).toBe('Typo no README');
    expect(done.editedFiles).toEqual(['C:/work/proj-a/README.md']);
    expect(done.links[0].value).toBe('https://github.com/acme/proj-a/pull/12');
    const noise = session('s-noise');
    expect(noise.firstPrompt).toBe('/review o PR 44');
    expect(noise.lastPrompt).toBe('Corrija o teste que quebrou');
    expect(noise.prompts).toBe(2);
    expect(noise.lastAssistant).toBe('Vou rodar os testes.');
  });

  it('keeps history-only sessions as partial evidence', () => {
    const h = session('h-only');
    expect(h.partial).toBe(true);
    expect(h.firstPrompt).toBe('Revisar a planilha de custos do Hugo');
  });

  it('puts the sessions with signals in Triage, with a suggestion', () => {
    expect(first.withSignals).toBe(4);
    expect(first.triageCreated).toBe(4);
    const triage = ctx.service.listCards({ status: 'triage' });
    expect(triage).toHaveLength(4);
    const q = triage.find((c) => c.id === session('s-question').cardId)!;
    expect(q.suggestedStatus).toBe('waiting_user');
    expect(q.origin).toBe('import');
    expect(q.descriptionMd).toMatch(/claude --resume s-question/);
    expect(triage.find((c) => c.id === session('s-todos').cardId)!.suggestedStatus).toBe('backlog');
  });

  it('is idempotent: a second scan reads nothing and creates nothing', async () => {
    const again = await importer.scan();
    expect(again.scanned).toBe(0);
    expect(again.unchanged).toBe(7);
    expect(again.triageCreated).toBe(0);
    expect(ctx.service.listCards({ status: 'triage' })).toHaveLength(4);
    expect(importer.list()).toHaveLength(7);
  });

  it('re-reads only the transcript that changed', async () => {
    const file = path.join(claudeHome, 'projects', 'C--work-proj-a', 's-done.jsonl');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', sessionId: 's-done', timestamp: '2026-11-02T00:00:00Z', message: { id: 'zz', content: [{ type: 'text', text: 'Mais alguma coisa?' }] } }) + '\n');
    const r = await importer.scan();
    expect(r.scanned).toBe(1);
    expect(kinds('s-done')).toEqual(['ended_with_question']);
    expect(r.triageCreated).toBe(1);
  });
});

describe('classify (step 2, with confirmation)', () => {
  it('does not run without confirmation', async () => {
    await expect(importer.classify({ confirm: false })).rejects.toThrow(RuleError);
    const est = importer.estimate();
    expect(est.sessions).toBeGreaterThan(0);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it('classifies chosen sessions in batches and fills the triage', async () => {
    const before = ctx.service.listCards({ status: 'triage' }).length;
    const r = await importer.classify({ sessionIds: ['s-trivial', 's-question'], confirm: true });
    expect(r.failedBatches).toBe(0);
    expect(r.classified).toBe(2);
    expect(r.ignored).toBe(1);
    expect(r).not.toHaveProperty('costUsd');
    expect(session('s-trivial').decision).toBe('ignored');
    const q = ctx.service.getCard(session('s-question').cardId!);
    expect(q.title).toMatch(/^Classificado:/);
    expect(q.suggestionConfidence).toBe(0.8);
    expect(q).not.toHaveProperty('areaId');
    expect(ctx.service.listCards({ status: 'triage' }).length).toBe(before);
  });
});

describe('triage decisions', () => {
  it('accepts into the suggested list and ignores by archiving', () => {
    const todos = session('s-todos').cardId!;
    importer.acceptTriage(todos);
    expect(ctx.service.getCard(todos).status).toBe('backlog');
    expect(session('s-todos').decision).toBe('accepted');

    const noise = session('s-noise').cardId!;
    importer.ignoreTriage(noise);
    expect(ctx.service.getCard(noise).archived).toBe(true);
    expect(session('s-noise').decision).toBe('ignored');
  });

  it('accepts in batch by minimum confidence', () => {
    const left = ctx.service.listCards({ status: 'triage' });
    const high = left.filter((c) => (c.suggestionConfidence ?? 0) >= 0.7).length;
    expect(importer.batchTriage({ action: 'accept', minConfidence: 0.7 })).toBe(high);
    expect(ctx.service.listCards({ status: 'triage' })).toHaveLength(left.length - high);
  });

  it('sends a session without signals to triage on request', () => {
    const [cardId] = importer.sendToTriage(['h-only']);
    expect(ctx.service.getCard(cardId).status).toBe('triage');
    expect(ctx.service.getCard(cardId).descriptionMd).toMatch(/evidência parcial/);
  });
});

describe('parse helpers', () => {
  it('recognizes a question at the end even with markdown emphasis', () => {
    expect(endsWithQuestion('Feito.\n\nQuer que eu siga com a **main**?')).toBe(true);
    expect(endsWithQuestion('Quer?\n\nFeito, tudo certo.')).toBe(false);
  });

  it('drops system-injected text and keeps what the person typed', () => {
    expect(promptText({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } })).toBeNull();
    expect(promptText({ type: 'user', message: { content: [{ type: 'text', text: 'oi' }] } })).toBe('oi');
    expect(promptText({ type: 'user', isMeta: true, message: { content: 'oi' } })).toBeNull();
  });
});
