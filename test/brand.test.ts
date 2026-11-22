import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boardHome, DEFAULT_CONFIG } from '../src/config.js';
import { hooksStatus, installHooks, uninstallHooks } from '../src/hooks/install.js';
import { describeToolUse } from '../src/runner/stream.js';
import { boardEnv, boardEnvVars, isBoardEnvKey, PRODUCT_NAME } from '../src/shared/brand.js';
import { tempDir } from './helpers.js';

// Card #200 (D101): "Claude Board" became Deus Ex Machina. The screen and the docs carry only the new
// name; the old identifiers keep working while machines and running sessions still use them.

const root = path.resolve(__dirname, '..');

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');

describe('guard: the old name is gone from what people read', () => {
  it('no "Claude Board" in the code, the entry points or the README', () => {
    const files = [
      ...filesUnder(path.join(root, 'src'), ['.ts', '.tsx', '.html', '.css']),
      ...filesUnder(path.join(root, 'bin'), ['.mjs']),
      path.join(root, 'README.md'),
    ].filter((f) => rel(f) !== 'src/shared/brand.ts');
    const hits = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .map((line, i) => ({ line, at: `${rel(f)}:${i + 1}` }))
        .filter(({ line }) => /claude\s+board/i.test(line))
        .map(({ at }) => at),
    );
    expect(hits).toEqual([]);
  });

  it('no form of the old name at all in the UI (screen text, keys, the page title)', () => {
    const files = filesUnder(path.join(root, 'src', 'ui'), ['.ts', '.tsx', '.html', '.css']);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => /claude[\s_-]?board/i.test(fs.readFileSync(f, 'utf8'))).map(rel);
    expect(hits).toEqual([]);
  });

  it('the page title and the header say Deus Ex Machina', () => {
    expect(fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8')).toContain('<title>Deus Ex Machina</title>');
    expect(fs.readFileSync(path.join(root, 'src/ui/App.tsx'), 'utf8')).toContain('<span className="brand-name">{PRODUCT_NAME}</span>');
    expect(PRODUCT_NAME).toBe('Deus Ex Machina');
  });

  it('the guard catches the old name (proof it is not blind)', () => {
    expect(/claude\s+board/i.test('O Claude Board recusou')).toBe(true);
    expect(/claude[\s_-]?board/i.test("locks.request('claude-board-chime')")).toBe(true);
  });

  it('package.json: new package and command, the old command as an alias', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('deusexmachina');
    expect(pkg.bin).toEqual({ dexm: 'bin/dexm.mjs', 'claude-board': 'bin/claude-board.mjs' });
    expect(pkg.repository.url).toContain('fabriciopf/deus-ex-machina');
    expect(fs.readFileSync(path.join(root, 'bin/claude-board.mjs'), 'utf8')).toContain("await import('./dexm.mjs')");
  });
});

describe('environment variables', () => {
  it('reads DEXM_* first and falls back to CLAUDE_BOARD_*', () => {
    expect(boardEnv('URL', { DEXM_URL: 'new', CLAUDE_BOARD_URL: 'old' })).toBe('new');
    expect(boardEnv('URL', { CLAUDE_BOARD_URL: 'old' })).toBe('old');
    expect(boardEnv('URL', { DEXM_URL: '' , CLAUDE_BOARD_URL: 'old' })).toBe('old');
    expect(boardEnv('URL', {})).toBeUndefined();
  });

  it('hands both prefixes to a child, so hooks of the previous version still see a run', () => {
    expect(boardEnvVars({ CARD_ID: '7' })).toEqual({ DEXM_CARD_ID: '7', CLAUDE_BOARD_CARD_ID: '7' });
    expect(isBoardEnvKey('DEXM_URL')).toBe(true);
    expect(isBoardEnvKey('CLAUDE_BOARD_URL')).toBe(true);
    expect(isBoardEnvKey('CLAUDE_CODE_ENTRYPOINT')).toBe(false);
  });
});

describe('data folder', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['DEXM_HOME', 'CLAUDE_BOARD_HOME', 'USERPROFILE', 'HOME']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const withHome = () => {
    const home = tempDir('dexm-home-');
    delete process.env.DEXM_HOME;
    delete process.env.CLAUDE_BOARD_HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    expect(os.homedir()).toBe(home);
    return home;
  };

  it('a new machine gets ~/.dexm', () => {
    const home = withHome();
    expect(boardHome()).toBe(path.join(home, '.dexm'));
  });

  it('a machine with only ~/.claude-board keeps using it: no card is lost', () => {
    const home = withHome();
    fs.mkdirSync(path.join(home, '.claude-board'));
    expect(boardHome()).toBe(path.join(home, '.claude-board'));
  });

  it('once ~/.dexm exists it wins over the old folder', () => {
    const home = withHome();
    fs.mkdirSync(path.join(home, '.claude-board'));
    fs.mkdirSync(path.join(home, '.dexm'));
    expect(boardHome()).toBe(path.join(home, '.dexm'));
  });

  it('DEXM_HOME, then CLAUDE_BOARD_HOME, override the default', () => {
    withHome();
    const a = tempDir();
    const b = tempDir();
    process.env.CLAUDE_BOARD_HOME = b;
    expect(boardHome()).toBe(path.resolve(b));
    process.env.DEXM_HOME = a;
    expect(boardHome()).toBe(path.resolve(a));
  });
});

describe('hooks installed by the previous name', () => {
  const saved = process.env.CLAUDE_BOARD_HOME;
  afterEach(() => {
    process.env.CLAUDE_BOARD_HOME = saved;
  });

  it('install replaces them instead of adding a second copy; uninstall removes them', () => {
    process.env.CLAUDE_BOARD_HOME = tempDir();
    const claudeHome = tempDir();
    const config = { ...DEFAULT_CONFIG, claudeHome };
    const old = (ev: string) => ({ hooks: [{ type: 'command', command: `"node" "C:/x/.claude-board/hooks/claude-board-hook.mjs" ${ev}`, timeout: 5 }] });
    const settings = { hooks: { SessionStart: [old('SessionStart')], Stop: [old('Stop')], SessionEnd: [old('SessionEnd')] }, model: 'x' };
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(settings));
    expect(hooksStatus(config).installed).toBe(true);

    installHooks(config);
    const after = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    for (const ev of ['SessionStart', 'Stop', 'SessionEnd']) {
      const commands = after.hooks[ev].flatMap((g: any) => g.hooks).map((h: any) => h.command);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('dexm-hook.mjs');
    }
    expect(after.model).toBe('x');

    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(settings));
    uninstallHooks(config);
    expect(JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).hooks).toBeUndefined();
  });
});

describe('tool names', () => {
  it('the Board tools read the same under the new and the old MCP name', () => {
    expect(describeToolUse('mcp__dexm__card_comment', { text: 'oi' })).toBe('board:card_comment: oi');
    expect(describeToolUse('mcp__claude-board__card_comment', { text: 'oi' })).toBe('board:card_comment: oi');
  });
});
