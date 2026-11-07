export interface Tamper {
  bytes: Uint8Array;
  offset: number;
  before: number;
  after: number;
}

const NEWLINE = 0x0a;
const EVENTS_MARK = new TextEncoder().encode('"events":[\n');

const isAlphanumeric = (b: number): boolean => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

function afterMark(bytes: Uint8Array): number {
  outer: for (let i = 0; i + EVENTS_MARK.length <= bytes.length; i++) {
    for (let j = 0; j < EVENTS_MARK.length; j++) if (bytes[i + j] !== EVENTS_MARK[j]) continue outer;
    return i + EVENTS_MARK.length;
  }
  return -1;
}

/** Flips the lowest bit of one letter or digit inside a random event line. The input is left untouched. */
export function tamperByte(file: Uint8Array, random: () => number = Math.random): Tamper {
  const start = afterMark(file);
  if (start < 0) throw new Error('This file has no event lines');
  const lines: [number, number][] = [];
  let from = start;
  for (let i = start; i < file.length; i++) {
    if (file[i] !== NEWLINE) continue;
    if (i - from > 2) lines.push([from, i]);
    from = i + 1;
  }
  if (lines.length === 0) throw new Error('This file has no event lines');
  const [lineStart, lineEnd] = lines[Math.floor(random() * lines.length)]!;
  const spots: number[] = [];
  for (let i = lineStart; i < lineEnd; i++) if (isAlphanumeric(file[i]!)) spots.push(i);
  const offset = spots[Math.floor(random() * spots.length)]!;
  const bytes = file.slice();
  const before = bytes[offset]!;
  const after = before ^ 1;
  bytes[offset] = after;
  return { bytes, offset, before, after };
}
