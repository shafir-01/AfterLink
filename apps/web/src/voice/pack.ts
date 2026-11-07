import type { MissionCapsule } from '@afterlink/protocol';
import { clipKey, createClipStore, type ClipStore } from './clipStore.ts';
import { packItems } from './phrases.ts';
import { relayBase, relayService } from '../relay.ts';

export type ClipSource = 'cached' | 'live';
/** captioned: nothing could be played, the caption is all there is. */
export type SpeakSource = ClipSource | 'captioned';
export interface SpeakResult {
  source: SpeakSource;
  caption: string;
}

export interface Player {
  play(blob: Blob): Promise<void>;
  stop(): void;
}

export function browserPlayer(): Player {
  let audio: HTMLAudioElement | null = null;
  let url: string | null = null;
  const cleanup = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    audio = null;
  };
  return {
    play(blob) {
      this.stop();
      return new Promise((resolve, reject) => {
        url = URL.createObjectURL(blob);
        const a = (audio = new Audio(url));
        a.onended = () => (cleanup(), resolve());
        a.onerror = () => (cleanup(), reject(new Error('playback failed')));
        a.play().catch((e) => (cleanup(), reject(e)));
      });
    },
    stop() {
      if (audio) {
        audio.pause();
        audio.onended = null;
        audio.onerror = null;
      }
      cleanup();
    },
  };
}

export interface PackProgress {
  done: number;
  total: number;
  failed: number;
}

export interface VoicePackOptions {
  baseUrl?: string;
  store?: ClipStore;
  player?: Player;
  fetchImpl?: typeof fetch;
  /** Whether the relay can synthesise at all. Asked before every live request. */
  available?: () => Promise<boolean>;
}

/** After a refused request the pack stops asking for a while, so a failing provider costs one call, not one per clip. */
const PAUSE_AFTER_FAILURE_MS = 60_000;

export class VoicePack {
  private base: string;
  private store: ClipStore;
  private player: Player;
  private doFetch: typeof fetch;
  private available: () => Promise<boolean>;
  private pausedUntil = 0;
  private gen = 0;

  constructor(o: VoicePackOptions = {}) {
    this.base = (o.baseUrl ?? relayBase()).replace(/\/$/, '');
    this.store = o.store ?? createClipStore();
    this.player = o.player ?? browserPlayer();
    this.doFetch = o.fetchImpl ?? ((...a) => fetch(...a));
    this.available = o.available ?? (async () => (await relayService('elevenlabs')) === 'live');
  }

  get persistent() {
    return this.store.persistent;
  }

  async has(text: string, role: string): Promise<boolean> {
    return (await this.store.get(clipKey(role, text))) !== null;
  }

  /** Cached clip first, then a live synthesis when online. Null when neither is possible. */
  async clip(text: string, role: string, online: boolean): Promise<{ blob: Blob; source: ClipSource } | null> {
    const key = clipKey(role, text);
    const hit = await this.store.get(key);
    if (hit) return { blob: hit, source: 'cached' };
    if (!online || Date.now() < this.pausedUntil || !(await this.available())) return null;
    try {
      const res = await this.doFetch(`${this.base}/api/voice/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, role }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (!blob.size) return null;
      await this.store.put(key, blob);
      return { blob, source: 'live' };
    } catch {
      this.pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
      return null;
    }
  }

  async speak(text: string, role: string, online: boolean): Promise<SpeakResult> {
    const c = await this.clip(text, role, online);
    if (!c) return { source: 'captioned', caption: text };
    return this.playAll([c], text);
  }

  /** Plays segments back to back. If any segment has no audio, nothing plays and the caption stands alone. */
  async speakSequence(parts: string[], role: string, online: boolean): Promise<SpeakResult> {
    const caption = parts.join(' ');
    const whole = await this.clip(caption, role, online);
    if (whole) return this.playAll([whole], caption);
    const clips: { blob: Blob; source: ClipSource }[] = [];
    for (const p of parts) {
      const c = await this.clip(p, role, online);
      if (!c) return { source: 'captioned', caption };
      clips.push(c);
    }
    return this.playAll(clips, caption);
  }

  stop() {
    this.gen++;
    this.player.stop();
  }

  async prepare(capsule: MissionCapsule, team: string, online: boolean, onProgress?: (p: PackProgress) => void): Promise<PackProgress> {
    const items = packItems(capsule, team);
    const p: PackProgress = { done: 0, total: items.length, failed: 0 };
    onProgress?.({ ...p });
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++]!;
        const c = await this.clip(item.text, item.role, online);
        if (c) p.done++;
        else p.failed++;
        onProgress?.({ ...p });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return p;
  }

  private async playAll(clips: { blob: Blob; source: ClipSource }[], caption: string): Promise<SpeakResult> {
    const gen = ++this.gen;
    const source: ClipSource = clips.every((c) => c.source === 'cached') ? 'cached' : 'live';
    try {
      for (const c of clips) {
        if (gen !== this.gen) break;
        await this.player.play(c.blob);
      }
      return { source, caption };
    } catch {
      return { source: 'captioned', caption };
    }
  }
}

let shared: VoicePack | null = null;
export function getVoicePack(): VoicePack {
  return (shared ??= new VoicePack());
}
