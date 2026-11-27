import DOMPurify from 'dompurify';
import { Marked, type MarkedExtension, type TokenizerAndRendererExtension, type Tokens } from 'marked';

/**
 * What the card texts turn into links besides URLs (card #309): Jira keys, GitHub references,
 * other cards (#N) and local paths. Set by the card modal from the config.
 */
export interface LinkContext {
  /** Jira site, e.g. https://acme.atlassian.net; '' = Jira keys stay as text. */
  jiraBaseUrl?: string;
  /** Project keys that link (PROD, STAYS2); empty = any key outside NOT_JIRA_KEYS. */
  jiraProjectKeys?: string[];
}

let linkContext: LinkContext = {};

export function setLinkContext(next: LinkContext): void {
  linkContext = { ...next };
}

/** Prefixes that look like a Jira key but are standards (UTF-8, ISO-8601, SHA-256, CVE-2024-...); a key starts with two letters, so H2-2026 and Q3-2026 stay text. */
const NOT_JIRA_KEYS = new Set(['UTF', 'ISO', 'SHA', 'MD', 'RFC', 'CVE', 'ES', 'HTTP', 'TLS', 'SSL', 'IEC', 'IEEE', 'ECMA', 'WCAG', 'COVID', 'PEP']);

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Trailing characters that end a sentence, not a path or a URL. */
const trimTrailing = (s: string) => s.replace(/[.,;:!?'")\]}>]+$/, '');

/** Absolute path written in prose: Windows drive (C:\ or C:/) or home (~/). Stops at a blank. */
const ABS_PATH_TEXT = /^(?:[A-Za-z]:[\\/]|~[\\/])[^\s<>"`|*?]*/;
/** file:// URL, which the browser will not open from an http page. */
const FILE_URL = /^file:\/\/[^\s<>"`]+/i;
const GITHUB_REF = /^([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)(?![\w-])/;
const JIRA_KEY = /^([A-Z]{2}[A-Z0-9]{0,8})-([1-9]\d{0,6})(?![\w-])/;
const CARD_REF = /^#(\d{1,6})(?![\w-])/;

/** Where a reference may start: not glued to a word, a path or an entity before it. */
const START = /(?<![\w&/\\.#-])(?:[A-Za-z]:[\\/]|~[\\/]|file:\/\/|[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d|[A-Z][A-Z0-9]{0,9}-[1-9]|#\d)/i;

/** A code span that holds a path: absolute (drive, ~, /x/...) or relative with a file extension or a final slash. */
export function codePath(text: string): string | null {
  const s = text.trim();
  if (!s || /[\n<>"|*?]/.test(s)) return null;
  // Absolute: Windows drive, home, file:// or Git Bash (/c/Users/...); a blank inside is part of the name.
  if (/^(?:[A-Za-z]:[\\/]|~[\\/]|file:\/\/|\/[a-z]\/)/i.test(s)) return s;
  if (/\s/.test(s)) return null;
  // Relative: a file with an extension (and an optional :line:col) or a folder with a final slash.
  // "and/or" and "PR/issue" stay text.
  const rel = /^(?:\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@-]+[\\/])*(?:[\p{L}\p{N}_@-][\p{L}\p{N}_.@-]*\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)?$/u;
  // A bare name (package.json, Node.js) has no folder to tell it from a word: it stays text.
  if (!/[\\/]/.test(s) || !rel.test(s) || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  return /[\\/]$/.test(s) || /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(s) ? s : null;
}

/** Turns an href into a local path when it points at the disk (C:\..., file://, ~/), else null. */
export function hrefPath(href: string): string | null {
  let h = href;
  try {
    h = decodeURI(href);
  } catch {
    // keep it as written
  }
  if (/^file:\/\//i.test(h)) return h;
  if (/^[A-Za-z]:[\\/]/.test(h) || /^~[\\/]/.test(h)) return h;
  return null;
}

const localLink = (path: string, inner: string) =>
  `<a href="#" class="local-path" data-local-path="${escapeHtml(path)}" title="${escapeHtml(path)}">${inner}</a>`;

interface RefToken extends Tokens.Generic {
  type: 'autoref';
  raw: string;
  text: string;
  href?: string;
  path?: string;
  cardId?: number;
}

function jiraAllowed(key: string): boolean {
  const keys = linkContext.jiraProjectKeys ?? [];
  return keys.length ? keys.includes(key) : !NOT_JIRA_KEYS.has(key);
}

const autoref: TokenizerAndRendererExtension = {
  name: 'autoref',
  level: 'inline',
  start(src: string) {
    const m = START.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src: string): RefToken | undefined {
    if ((this as any).lexer?.state?.inLink) return undefined;
    let m = FILE_URL.exec(src) ?? ABS_PATH_TEXT.exec(src);
    if (m) {
      const raw = trimTrailing(m[0]);
      if (raw.length > 3) return { type: 'autoref', raw, text: raw, path: raw };
    }
    if ((m = GITHUB_REF.exec(src))) {
      return { type: 'autoref', raw: m[0], text: m[0], href: `https://github.com/${m[1]}/issues/${m[2]}` };
    }
    const base = linkContext.jiraBaseUrl?.replace(/\/+$/, '');
    if (base && (m = JIRA_KEY.exec(src)) && jiraAllowed(m[1]!)) {
      return { type: 'autoref', raw: m[0], text: m[0], href: `${base}/browse/${m[0]}` };
    }
    if ((m = CARD_REF.exec(src))) return { type: 'autoref', raw: m[0], text: m[0], cardId: Number(m[1]) };
    // A key-shaped word that is not a key (UTF-8, GOV-04) is consumed whole: left to the text
    // tokenizer, it would give up one letter and "TF-8" would then match.
    if ((m = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/.exec(src))) return { type: 'autoref', raw: m[0], text: m[0] };
    return undefined;
  },
  renderer(token) {
    const t = token as RefToken;
    if (t.path) return localLink(t.path, escapeHtml(t.text));
    if (t.cardId) return `<a href="#" class="card-ref" data-card-id="${t.cardId}">${escapeHtml(t.text)}</a>`;
    if (!t.href) return escapeHtml(t.text);
    return `<a href="${escapeHtml(t.href ?? '#')}">${escapeHtml(t.text)}</a>`;
  },
};

/** Code spans inside a link's text stay plain code, or the page would nest one link in another. */
function markLinkChildren(tokens: Tokens.Generic[] | undefined): void {
  for (const tok of tokens ?? []) {
    if (tok.type === 'codespan') (tok as any).inLink = true;
    markLinkChildren(tok.tokens as Tokens.Generic[] | undefined);
  }
}

const linksExtension: MarkedExtension = {
  gfm: true,
  breaks: true,
  extensions: [autoref],
  walkTokens(token) {
    if (token.type === 'link') markLinkChildren(token.tokens as Tokens.Generic[]);
  },
  renderer: {
    codespan(token) {
      const code = `<code>${escapeHtml(token.text)}</code>`;
      const path = (token as any).inLink ? null : codePath(token.text);
      return path ? localLink(path, code) : code;
    },
    link(token) {
      const path = hrefPath(token.href);
      if (path) return localLink(path, this.parser.parseInline(token.tokens));
      return false;
    },
  },
};

const md = new Marked(linksExtension);

/** Markdown to HTML, before sanitizing; exported for the tests, which run without a DOM. */
export function markdownToHtml(text: string): string {
  return md.parse(text ?? '', { async: false }) as string;
}

/** Markdown to sanitized HTML; links open in a new tab, and an image opens full size on click (D57). */
export function renderMarkdown(text: string): string {
  const clean = DOMPurify.sanitize(markdownToHtml(text));
  return linkImages(clean).replace(/<a /g, '<a target="_blank" rel="noreferrer" ');
}

/** Wraps each image that is not already inside a link in a link to itself. Input is sanitized HTML. */
export function linkImages(html: string): string {
  let depth = 0;
  return html.replace(/<a[\s>]|<\/a>|<img\b[^>]*>/g, (tag) => {
    if (tag.startsWith('</a')) {
      depth = Math.max(0, depth - 1);
      return tag;
    }
    if (tag.startsWith('<a')) {
      depth++;
      return tag;
    }
    const src = /\ssrc="([^"]*)"/.exec(tag)?.[1];
    return depth || !src ? tag : `<a href="${src}">${tag}</a>`;
  });
}
