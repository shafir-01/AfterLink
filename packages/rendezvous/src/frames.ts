import { b64u, fromB64u } from '@afterlink/protocol';
import { DEFAULT_CHUNK, crc32, type WireFrame } from '@afterlink/ferry';

/** Ferry frame ids are always 8 characters, so a 7 character id can never be mistaken for one. */
const ID_PREFIX = 'rv';
const ID_LENGTH = 7;

export function isRendezvousFrame(f: { id: string }): boolean {
  return f.id.length === ID_LENGTH && f.id.startsWith(ID_PREFIX);
}

/** The payload as QR frames in the ferry's frame format: same renderer, same scanner. */
export function payloadFrames(payload: Uint8Array, digest: string, chunkSize = DEFAULT_CHUNK): WireFrame[] {
  const text = b64u(payload);
  const n = Math.max(1, Math.ceil(text.length / chunkSize));
  const size = Math.ceil(text.length / n);
  const id = `${ID_PREFIX}${digest.slice(0, ID_LENGTH - ID_PREFIX.length)}`;
  const frames: WireFrame[] = [];
  for (let i = 0; i < n; i++) {
    const data = text.slice(i * size, (i + 1) * size);
    frames.push({ id, i, n, data, c: crc32(`${id}.${i}.${n}.${data}`) });
  }
  return frames;
}

/** Collects the frames of one payload in any order. Foreign and corrupt frames are ignored. */
export class PayloadAssembler {
  private parts = new Map<number, string>();
  private id: string | null = null;
  private total = 0;

  add(f: WireFrame): { have: number; total: number } {
    const valid =
      isRendezvousFrame(f) &&
      Number.isInteger(f.i) &&
      Number.isInteger(f.n) &&
      f.i >= 0 &&
      f.i < f.n &&
      f.c === crc32(`${f.id}.${f.i}.${f.n}.${f.data}`) &&
      (this.id === null || (f.id === this.id && f.n === this.total));
    if (valid) {
      this.id = f.id;
      this.total = f.n;
      this.parts.set(f.i, f.data);
    }
    return { have: this.parts.size, total: this.total };
  }

  get done(): boolean {
    return this.total > 0 && this.parts.size === this.total;
  }

  payload(): Uint8Array {
    if (!this.done) throw new Error(`rendezvous: have ${this.parts.size} of ${this.total} frames`);
    let text = '';
    for (let i = 0; i < this.total; i++) text += this.parts.get(i)!;
    return fromB64u(text);
  }
}
