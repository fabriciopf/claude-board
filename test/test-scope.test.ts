import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_TESTS, testScope } from '../src/publish/test-scope.js';

describe('scope of the publication tests (card #347)', () => {
  it('a screen-only batch runs only the unit project', () => {
    const r = testScope(['src/ui/App.tsx', 'src/ui/styles.css', 'test/column-toast.test.ts', 'docs/x.md', 'DECISIONS.md']);
    expect(r.scope).toBe('unit');
    expect(r.reason).toBe('só tela: 5 arquivo(s) em src/ui, docs ou testes unitários');
  });

  it('a mixed batch runs the whole suite and names what is outside the screen', () => {
    const r = testScope(['src/ui/App.tsx', 'src/server/routes.ts']);
    expect(r).toEqual({ scope: 'full', reason: 'arquivo(s) fora da tela: src/server/routes.ts' });
  });

  it('in doubt, everything runs', () => {
    const full = (files: string[]) => testScope(files).scope;
    expect(full([])).toBe('full');
    // Code shared with the server, the build and test configs, packages.
    for (const f of ['src/shared/domain.ts', 'vitest.config.ts', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.ui.json', 'src/publish/test-scope.ts'])
      expect(full(['src/ui/App.tsx', f]), f).toBe('full');
    // Test helpers the integration files use.
    for (const f of ['test/helpers.ts', 'test/fake-build.mjs', 'test/setup.ts', 'test/global-setup.ts', 'test/fixtures/make-fixtures.mjs', 'test/git-fixture.ts'])
      expect(full(['src/ui/App.tsx', f]), f).toBe('full');
    // Each integration test file.
    for (const f of INTEGRATION_TESTS) expect(full(['src/ui/App.tsx', f]), f).toBe('full');
    // A Markdown file below the root is not a doc of the repo.
    expect(full(['src/ui/notes.md', 'src/server/README.md'])).toBe('full');
  });

  it('names at most three files', () => {
    expect(testScope(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']).reason).toBe('arquivo(s) fora da tela: a.ts, b.ts, c.ts e mais 2');
  });

  it('every integration file exists and vitest.config.ts takes the list from here', () => {
    for (const f of INTEGRATION_TESTS) expect(fs.existsSync(f), f).toBe(true);
    const config = fs.readFileSync('vitest.config.ts', 'utf8');
    expect(config).toMatch(/import \{ INTEGRATION_TESTS \} from '\.\/src\/publish\/test-scope\.js'/);
    expect(config).not.toMatch(/'hidden-console'/);
  });
});
