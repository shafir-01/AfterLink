import { b64u, fromB64u, canonicalize } from '@afterlink/protocol';
import type { FerryFrame, FerryPacket } from '@afterlink/protocol';

export type WireFrame = FerryFrame & { c: string };

export const FRAME_PREFIX = 'AL1';
export const DEFAULT_CHUNK = 360;
const MAX_INFLATED = 8 * 1024 * 1024;

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(s: string): string {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, cap = Infinity) {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > cap) {
      await reader.cancel();
      throw new Error('ferry: payload too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function toFrames(p: FerryPacket, opts: { chunkSize?: number } = {}): Promise<WireFrame[]> {
  const chunk = opts.chunkSize ?? DEFAULT_CHUNK;
  const raw = new TextEncoder().encode(canonicalize(p));
  const text = b64u(await pipe(raw, new CompressionStream('deflate-raw')));
  const n = Math.max(1, Math.ceil(text.length / chunk));
  const size = Math.ceil(text.length / n);
  const id = p.id.slice(0, 8);
  const frames: WireFrame[] = [];
  for (let i = 0; i < n; i++) {
    const data = text.slice(i * size, (i + 1) * size);
    frames.push({ id, i, n, data, c: crc32(`${id}.${i}.${n}.${data}`) });
  }
  return frames;
}

export function frameText(f: WireFrame): string {
  return `${FRAME_PREFIX}.${f.id}.${f.i}.${f.n}.${f.c}.${f.data}`;
}

export function parseFrameText(text: string): WireFrame | null {
  const parts = text.split('.');
  if (parts.length !== 6 || parts[0] !== FRAME_PREFIX) return null;
  const [, id, si, sn, c, data] = parts as [string, string, string, string, string, string];
  const i = Number(si);
  const n = Number(sn);
  if (!Number.isInteger(i) || !Number.isInteger(n) || i < 0 || n < 1 || i >= n) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
  if (crc32(`${id}.${i}.${n}.${data}`) !== c) return null;
  return { id, i, n, c, data };
}

/** Collects frames in any order, ignoring duplicates, frames from other packets and corrupt frames. */
export class FrameAssembler {
  private parts = new Map<number, string>();
  private id: string | null = null;
  private total = 0;
  rejected = 0;

  add(f: FerryFrame & { c?: string }): { have: number; total: number } {
    const bad =
      !f ||
      !Number.isInteger(f.i) ||
      !Number.isInteger(f.n) ||
      f.n < 1 ||
      f.i < 0 ||
      f.i >= f.n ||
      (f.c !== undefined && f.c !== crc32(`${f.id}.${f.i}.${f.n}.${f.data}`)) ||
      (this.id !== null && (f.id !== this.id || f.n !== this.total));
    if (bad) this.rejected++;
    else {
      if (this.id === null) {
        this.id = f.id;
        this.total = f.n;
      }
      if (!this.parts.has(f.i)) this.parts.set(f.i, f.data);
    }
    return { have: this.parts.size, total: this.total };
  }

  get done(): boolean {
    return this.total > 0 && this.parts.size === this.total;
  }

  get packetId(): string | null {
    return this.id;
  }

  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.total; i++) if (!this.parts.has(i)) out.push(i);
    return out;
  }

  reset(): void {
    this.parts.clear();
    this.id = null;
    this.total = 0;
    this.rejected = 0;
  }

  async packet(): Promise<FerryPacket> {
    if (!this.done) throw new Error(`ferry: incomplete sequence, have ${this.parts.size} of ${this.total}`);
    let text = '';
    for (let i = 0; i < this.total; i++) text += this.parts.get(i)!;
    const raw = await pipe(fromB64u(text), new DecompressionStream('deflate-raw'), MAX_INFLATED);
    const p = JSON.parse(new TextDecoder().decode(raw)) as FerryPacket;
    if (!p.id || !p.id.startsWith(this.id!)) throw new Error('ferry: frames do not match packet');
    return p;
  }
}
