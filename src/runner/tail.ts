import fs from 'node:fs';

const NL = 0x0a;

/**
 * Reads the lines a detached process appends to a file, from a byte offset. Only whole lines are
 * returned, so the offset always sits at a line start and can be saved and resumed from (D45).
 */
export class FileTail {
  constructor(
    private file: string,
    public offset: number,
  ) {}

  /** New complete lines since the last read. With `all`, also a last line without a newline. */
  read(all = false): string[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const buf = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    let n = 0;
    try {
      n = fs.readSync(fd, buf, 0, buf.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    const chunk = buf.subarray(0, n);
    const end = all ? chunk.length : chunk.lastIndexOf(NL) + 1;
    if (end <= 0) return [];
    this.offset += end;
    return chunk
      .subarray(0, end)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim());
  }
}

/** The last `max` characters of a file, or '' when it does not exist. */
export function readTail(file: string, max = 8000): string {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - max * 4);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8').slice(-max);
  } catch {
    return '';
  }
}
