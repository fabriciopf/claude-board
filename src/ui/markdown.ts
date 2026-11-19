import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Markdown to sanitized HTML; links open in a new tab, and an image opens full size on click (D57). */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false }) as string;
  const clean = DOMPurify.sanitize(html);
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
