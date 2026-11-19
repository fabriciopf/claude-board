import { useState, type ClipboardEvent, type DragEvent } from 'react';
import { imageMarkdown, insertSnippet } from '../shared/images';

/** The first image file in a paste or a drop, if any. */
export function imageFile(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  for (const f of Array.from(dt.files ?? [])) if (f.type.startsWith('image/')) return f;
  return null;
}

/** Sends the bytes to the Board (D57); answers the URL to put in the markdown. */
export async function uploadImage(file: Blob): Promise<string> {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? `Erro ${res.status} ao enviar a imagem`);
  return data.url as string;
}

/**
 * Ctrl+V or drop of an image into a markdown textarea: uploads it and writes ![imagem](/images/…)
 * where the caret was. Text pastes are left alone.
 */
export function useImagePaste(setValue: (fn: (prev: string) => string) => void, onError: (msg: string) => void) {
  const [uploading, setUploading] = useState(false);

  const handle = async (file: File, el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    setUploading(true);
    try {
      const url = await uploadImage(file);
      let caret = 0;
      setValue((prev) => {
        const next = insertSnippet(prev, Math.min(start, prev.length), Math.min(end, prev.length), imageMarkdown(url));
        caret = next.caret;
        return next.text;
      });
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return {
    uploading,
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const file = imageFile(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      void handle(file, e.currentTarget);
    },
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      const file = imageFile(e.dataTransfer);
      if (!file) return;
      e.preventDefault();
      void handle(file, e.currentTarget);
    },
  };
}
