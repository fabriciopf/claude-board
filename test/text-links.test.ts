import { afterEach, describe, expect, it } from 'vitest';
import { codePath, hrefPath, markdownToHtml, setCardLinks, setLinkContext } from '../src/ui/markdown.js';

// Card #309: links inside the card texts (description, comments, summaries, questions).

const html = (md: string) => markdownToHtml(md);

describe('links in card texts', () => {
  afterEach(() => {
    setLinkContext({});
    setCardLinks([]);
  });

  it('keeps plain URLs as links', () => {
    expect(html('veja https://example.com/a?b=1')).toContain('<a href="https://example.com/a?b=1">');
  });

  it('links a Jira key only when the Jira address is set', () => {
    expect(html('ver PROD-1234 hoje')).not.toContain('<a');
    setLinkContext({ jiraBaseUrl: 'https://acme.atlassian.net/' });
    expect(html('ver PROD-1234 hoje')).toContain('<a href="https://acme.atlassian.net/browse/PROD-1234">PROD-1234</a>');
    expect(html('(STAYS2-12).')).toContain('/browse/STAYS2-12">STAYS2-12</a>');
  });

  it('leaves standards and zero-padded codes as text', () => {
    setLinkContext({ jiraBaseUrl: 'https://acme.atlassian.net' });
    for (const s of ['UTF-8', 'ISO-8601', 'SHA-256', 'CVE-2024-1234', 'GOV-04', 'H2-2026', 'Q3-2026', 'xPROD-1a']) expect(html(s), s).not.toContain('<a');
  });

  it('with project keys set, links only those projects', () => {
    setLinkContext({ jiraBaseUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['PROD'] });
    expect(html('PROD-1 e CD-22')).toContain('/browse/PROD-1"');
    expect(html('PROD-1 e CD-22')).not.toContain('CD-22</a>');
  });

  it('does not link a key inside a URL or inside a link text', () => {
    setLinkContext({ jiraBaseUrl: 'https://acme.atlassian.net' });
    const out = html('[o ticket PROD-9](https://x.dev/PROD-9) e https://y.dev/browse/PROD-8');
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out).not.toContain('<a href="https://acme');
  });

  it('links a GitHub reference to the issue/PR', () => {
    expect(html('PR acme/app#1002 aberto')).toContain('<a href="https://github.com/acme/app/issues/1002">acme/app#1002</a>');
  });

  it('links another card (#N) to open it in the Board', () => {
    const out = html('veio do card #305, não de x#1');
    expect(out).toContain('<a href="#" class="card-ref" data-card-id="305">#305</a>');
    expect(out.match(/data-card-id/g)).toHaveLength(1);
  });

  it('links #N to the PR when the card has a GitHub link with that number', () => {
    setCardLinks(['https://github.com/acme/app/pull/1005', 'https://github.com/acme/app/issues/7', 'https://example.com/x/1']);
    const out = html('#1005 (Barueri), #7 e o card #305');
    expect(out).toContain('<a href="https://github.com/acme/app/pull/1005">#1005</a>');
    expect(out).toContain('<a href="https://github.com/acme/app/issues/7">#7</a>');
    expect(out).toContain('data-card-id="305"');
    expect(out).not.toContain('data-card-id="1005"');
  });

  it('keeps #N as a card when two repos share that number, and after the links change', () => {
    setCardLinks(['https://github.com/acme/app/pull/12', 'https://github.com/acme/api/pull/12']);
    expect(html('#12')).toContain('data-card-id="12"');
    setCardLinks(['https://github.com/acme/app/pull/1005']);
    setCardLinks([]);
    expect(html('#1005')).toContain('data-card-id="1005"');
  });

  it('links a Windows path in prose, without the final punctuation', () => {
    const out = html('Salvo em C:\\Users\\ana\\docs\\notas.md.');
    expect(out).toContain('data-local-path="C:\\Users\\ana\\docs\\notas.md"');
    expect(out).toContain('notas.md</a>.');
  });

  it('keeps underscores of a path out of emphasis', () => {
    expect(html('C:/tmp/a_b_c.txt')).toContain('data-local-path="C:/tmp/a_b_c.txt"');
  });

  it('links a path in a code span, also relative and with spaces when absolute', () => {
    expect(html('`src/ui/markdown.ts:12`')).toContain('data-local-path="src/ui/markdown.ts:12"');
    expect(html('`C:\\Users\\x\\meus projetos\\a.md`')).toContain('data-local-path="C:\\Users\\x\\meus projetos\\a.md"');
    expect(html('`specs/finance/`')).toContain('data-local-path="specs/finance/"');
    expect(html('`/c/Users/ana/x.md`')).toContain('data-local-path="/c/Users/ana/x.md"');
  });

  it('leaves code that is not a path as code', () => {
    for (const s of ['`npm test`', '`and/or`', '`package.json`', '`a.b`', '`https://x.dev/a.md`', '`git push origin HEAD:refs/heads/x`']) {
      const out = html(s);
      expect(out, s).toContain('<code>');
      expect(out, s).not.toContain('data-local-path');
    }
  });

  it('turns a markdown link to the disk into a local link', () => {
    expect(html('[o plano](C:/Users/ana/plano.md)')).toContain('data-local-path="C:/Users/ana/plano.md"');
    expect(html('[x](file:///C:/a/b.txt)')).toContain('data-local-path="file:///C:/a/b.txt"');
  });

  it('does not nest a code-span path link inside another link', () => {
    const out = html('[`src/a.ts`](https://x.dev)');
    expect(out).not.toContain('data-local-path');
  });

  it('escapes what goes into the attributes', () => {
    expect(html('`C:\\a\\"x.md`')).not.toContain('data-local-path');
    expect(html('C:\\a\\b&c.md')).toContain('data-local-path="C:\\a\\b&amp;c.md"');
  });

  it('recognizes code paths and disk hrefs', () => {
    expect(codePath('npm run build')).toBeNull();
    expect(codePath('test/x.test.ts')).toBe('test/x.test.ts');
    expect(hrefPath('C:%5CUsers%5Cx')).toBe('C:\\Users\\x');
    expect(hrefPath('https://x.dev')).toBeNull();
  });
});
