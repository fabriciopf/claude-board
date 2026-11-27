import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { candidates, openCommand, resolveOpenTarget, splitPosition } from '../src/service/open-path.js';

// Card #309: a local path in a card text opens through the server.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dexm-open-path-'));
const cardDir = path.join(root, 'worktree');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(cardDir, 'src', 'ui'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'specs'), { recursive: true });
fs.writeFileSync(path.join(cardDir, 'src', 'ui', 'a.ts'), 'x');
fs.writeFileSync(path.join(workspace, 'notes.md'), 'x');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('open a local path', () => {
  it('splits a line and column, but not a drive', () => {
    expect(splitPosition('src/a.ts:12:3')).toEqual({ file: 'src/a.ts', line: 12, column: 3 });
    expect(splitPosition('src/a.ts:7')).toEqual({ file: 'src/a.ts', line: 7, column: undefined });
    expect(splitPosition('C:')).toEqual({ file: 'C:' });
    expect(splitPosition('C:\\a.ts')).toEqual({ file: 'C:\\a.ts' });
  });

  it('turns Git Bash and file:// spellings into the disk path', () => {
    expect(candidates('/c/Users/x.md', [], 'win32')).toEqual(['C:\\Users/x.md']);
    expect(candidates('~/x.md', [])).toEqual([path.join(os.homedir(), 'x.md')]);
    const file = path.join(workspace, 'notes.md');
    expect(candidates(pathToFileURL(file).href, [])).toEqual([file]);
  });

  it('looks a relative path up in the card folders first, then in the workspace', () => {
    const t = resolveOpenTarget('src/ui/a.ts:4', [cardDir, workspace]);
    expect(t).toEqual({ path: path.join(cardDir, 'src', 'ui', 'a.ts'), kind: 'file', line: 4, column: undefined });
    expect(resolveOpenTarget('notes.md', [cardDir, workspace])?.path).toBe(path.join(workspace, 'notes.md'));
    expect(resolveOpenTarget('specs/', [null, cardDir, workspace])).toEqual({ path: path.join(workspace, 'specs'), kind: 'dir' });
  });

  it('resolves a path that starts with the base folder name itself (card #301 link)', () => {
    expect(resolveOpenTarget('workspace/notes.md', [null, workspace])?.path).toBe(path.join(workspace, 'notes.md'));
    expect(resolveOpenTarget('workspace/specs', [path.join(workspace, 'specs')])).toEqual({ path: path.join(workspace, 'specs'), kind: 'dir' });
    expect(resolveOpenTarget('worktree/notes.md', [cardDir, workspace])).toBeNull();
  });

  it('refuses what does not exist or is not a path', () => {
    expect(resolveOpenTarget('nope/x.md', [cardDir, workspace])).toBeNull();
    expect(resolveOpenTarget('', [workspace])).toBeNull();
    expect(resolveOpenTarget('notes.md\nrm -rf', [workspace])).toBeNull();
    expect(resolveOpenTarget('src/ui/a.ts', [])).toBeNull();
  });

  it('opens a file in VS Code at the line and a folder in the file manager, never running it', () => {
    expect(openCommand({ path: 'C:\\a\\run.bat', kind: 'file' }, 'win32')).toEqual({ cmd: 'code', args: ['--goto', 'C:\\a\\run.bat'] });
    expect(openCommand({ path: '/a/b.ts', kind: 'file', line: 3, column: 2 }, 'linux')).toEqual({ cmd: 'code', args: ['--goto', '/a/b.ts:3:2'] });
    expect(openCommand({ path: 'C:\\a', kind: 'dir' }, 'win32')).toEqual({ cmd: 'explorer.exe', args: ['C:\\a'] });
    expect(openCommand({ path: '/a', kind: 'dir' }, 'darwin').cmd).toBe('open');
    expect(openCommand({ path: '/a', kind: 'dir' }, 'linux').cmd).toBe('xdg-open');
  });
});
