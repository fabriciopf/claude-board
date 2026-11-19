/** Images pasted into a card's markdown (D57): stored by the Board, referenced as /images/<name>. */

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** File name the Board gives a stored image: content hash plus extension. */
export const IMAGE_NAME = /^[a-f0-9]{16,64}\.(png|jpg|gif|webp)$/;

const IMAGE_REF = /\/images\/([a-f0-9]{16,64}\.(?:png|jpg|gif|webp))\b/g;

/** Names of the Board images a markdown text points to, in order, without repeats. */
export function imageRefs(md: string): string[] {
  const out: string[] = [];
  for (const m of (md ?? '').matchAll(IMAGE_REF)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Content type from the first bytes; null when the bytes are not one of the accepted formats. */
export function sniffImage(buf: Uint8Array): string | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => buf[i + k] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  return null;
}

/** Markdown for an uploaded image, on its own line. */
export function imageMarkdown(url: string, alt = 'imagem'): string {
  return `![${alt}](${url})`;
}

/** Inserts a snippet where the selection is, on its own line, and says where the caret goes. */
export function insertSnippet(text: string, start: number, end: number, snippet: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const trail = after && !after.startsWith('\n') ? '\n' : '';
  const piece = `${lead}${snippet}${trail}`;
  return { text: before + piece + after, caret: before.length + piece.length };
}
