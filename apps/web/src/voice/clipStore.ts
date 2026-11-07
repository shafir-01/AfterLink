/** Offline clip storage: Cache Storage when present, memory otherwise. */
export interface ClipStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, blob: Blob): Promise<void>;
  persistent: boolean;
}

const CACHE_NAME = 'afterlink-voice-v1';

export function clipKey(role: string, text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const s = `${role}\n${text}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  return `/voice-clip/${role}/${n}-${s.length}`;
}

export function memoryStore(): ClipStore {
  const m = new Map<string, Blob>();
  return { persistent: false, get: async (k) => m.get(k) ?? null, put: async (k, b) => void m.set(k, b) };
}

export function createClipStore(): ClipStore {
  const mem = memoryStore();
  if (typeof caches === 'undefined') return mem;
  const open = () => caches.open(CACHE_NAME);
  return {
    persistent: true,
    async get(key) {
      try {
        const hit = await (await open()).match(key);
        if (hit) return await hit.blob();
      } catch {
        // fall through to memory
      }
      return mem.get(key);
    },
    async put(key, blob) {
      await mem.put(key, blob);
      try {
        await (await open()).put(key, new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg' } }));
      } catch {
        // storage can be refused; memory copy remains for this session
      }
    },
  };
}
