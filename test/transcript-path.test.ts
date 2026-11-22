import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleHook } from '../src/hooks/handler.js';
import { safeTranscriptPath } from '../src/hooks/transcript-path.js';
import { makeContext, tempDir } from './helpers.js';

// Card #226: /api/hooks/:event takes transcript_path from the request body, and the importer reads
// that file. Only a .jsonl inside <claudeHome>/projects may get through.
const claudeHome = tempDir('cb-tp-home-');
const projects = path.join(claudeHome, 'projects');
const projectDir = path.join(projects, 'C--repo');
fs.mkdirSync(projectDir, { recursive: true });
const inside = path.join(projectDir, 'abc.jsonl');
fs.writeFileSync(inside, '');
const outsideDir = tempDir('cb-tp-outside-');
const outside = path.join(outsideDir, 'secret.jsonl');
fs.writeFileSync(outside, 'segredo\n');

describe('safeTranscriptPath', () => {
  it('accepts a transcript inside <claudeHome>/projects', () => {
    expect(safeTranscriptPath(claudeHome, inside)).toBe(path.resolve(inside));
  });

  it('accepts one whose file does not exist yet', () => {
    const later = path.join(projectDir, 'still-writing.jsonl');
    expect(safeTranscriptPath(claudeHome, later)).toBe(later);
  });

  it('accepts a path with a harmless .. that stays inside', () => {
    const p = path.join(projectDir, '..', 'C--repo', 'abc.jsonl');
    expect(safeTranscriptPath(claudeHome, p)).toBe(path.resolve(inside));
  });

  it('refuses an absolute path in another folder', () => {
    expect(safeTranscriptPath(claudeHome, outside)).toBeNull();
  });

  it('refuses a path whose .. escapes projects', () => {
    const p = path.join(projects, '..', '..', path.basename(outsideDir), 'secret.jsonl');
    expect(safeTranscriptPath(claudeHome, p)).toBeNull();
    expect(safeTranscriptPath(claudeHome, path.join(projects, '..', 'history.jsonl'))).toBeNull();
  });

  it('refuses the projects folder itself, a sibling with the same prefix and a non-.jsonl file', () => {
    expect(safeTranscriptPath(claudeHome, projects)).toBeNull();
    expect(safeTranscriptPath(claudeHome, path.join(claudeHome, 'projects-evil', 'x.jsonl'))).toBeNull();
    expect(safeTranscriptPath(claudeHome, path.join(projectDir, 'settings.json'))).toBeNull();
  });

  it('refuses relative paths and non-strings', () => {
    expect(safeTranscriptPath(claudeHome, path.join('projects', 'C--repo', 'abc.jsonl'))).toBeNull();
    expect(safeTranscriptPath(claudeHome, '')).toBeNull();
    expect(safeTranscriptPath(claudeHome, 42)).toBeNull();
    expect(safeTranscriptPath(claudeHome, undefined)).toBeNull();
    expect(safeTranscriptPath(claudeHome, `${inside}\0`)).toBeNull();
  });

  it('refuses a link inside projects that points outside', () => {
    const link = path.join(projects, 'escape');
    // A junction needs no admin rights on Windows; elsewhere it is a plain directory symlink.
    fs.symlinkSync(outsideDir, link, 'junction');
    expect(safeTranscriptPath(claudeHome, path.join(link, 'secret.jsonl'))).toBeNull();
    expect(safeTranscriptPath(claudeHome, path.join(link, 'not-there-yet.jsonl'))).toBeNull();
  });
});

describe('handleHook with transcript_path', () => {
  const ctx = makeContext({ claudeHome });
  const row = (id: string) => ctx.db.prepare('SELECT decision, transcript_path FROM imported_sessions WHERE claude_session_id = ?').get(id) as
    | { decision: string; transcript_path: string | null }
    | undefined;

  function withScans(fn: (scans: string[]) => void) {
    const scans: string[] = [];
    ctx.importer = { scheduleScan: (p: string) => scans.push(p) } as unknown as typeof ctx.importer;
    fn(scans);
  }

  it('stores and scans a transcript inside projects', () => {
    withScans((scans) => {
      handleHook(ctx, 'SessionEnd', { session_id: 's-in', transcript_path: inside });
      expect(row('s-in')).toEqual({ decision: 'pending', transcript_path: path.resolve(inside) });
      expect(scans).toEqual([path.resolve(inside)]);
    });
  });

  it('keeps the session but drops a path outside projects, without scanning it', () => {
    withScans((scans) => {
      handleHook(ctx, 'SessionEnd', { session_id: 's-out', transcript_path: outside });
      const escaping = path.join(projects, '..', '..', path.basename(outsideDir), 'secret.jsonl');
      handleHook(ctx, 'Stop', { session_id: 's-dots', transcript_path: escaping });
      expect(row('s-out')).toEqual({ decision: 'pending', transcript_path: null });
      expect(row('s-dots')).toEqual({ decision: 'pending', transcript_path: null });
      expect(scans).toEqual([]);
    });
  });

  it('a later bad path does not overwrite a good one already stored', () => {
    withScans(() => {
      handleHook(ctx, 'SessionStart', { session_id: 's-keep', transcript_path: inside });
      handleHook(ctx, 'SessionEnd', { session_id: 's-keep', transcript_path: outside });
      expect(row('s-keep')?.transcript_path).toBe(path.resolve(inside));
    });
  });
});
