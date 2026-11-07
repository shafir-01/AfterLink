import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MEMORY_LIMIT = 200;
const KEY = /^[0-9a-f]{64}$/;

export function clipKey(model: string, voice: string, text: string): string {
  return createHash('sha256').update(`${model}\n${voice}\n${text}`).digest('hex');
}

/** Content-addressed audio cache: memory first, disk second. */
export class ClipCache {
  private mem = new Map<string, Uint8Array>();
  constructor(private dir: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    if (!KEY.test(key)) return null;
    const hit = this.mem.get(key);
    if (hit) return hit;
    try {
      const bytes = new Uint8Array(await readFile(join(this.dir, `${key}.mp3`)));
      this.remember(key, bytes);
      return bytes;
    } catch {
      return null;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!KEY.test(key)) return;
    this.remember(key, bytes);
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `${key}.tmp`);
      await writeFile(tmp, bytes);
      await rename(tmp, join(this.dir, `${key}.mp3`));
    } catch {
      // the disk copy is best effort; memory still serves
    }
  }

  private remember(key: string, bytes: Uint8Array) {
    this.mem.delete(key);
    this.mem.set(key, bytes);
    if (this.mem.size > MEMORY_LIMIT) this.mem.delete(this.mem.keys().next().value as string);
  }
}
