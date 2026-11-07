import { sound } from './engine.ts';
import lines from './lines.json';

export interface RadioLine {
  id: string;
  team: string;
  text: string;
}

export interface RadioNow extends RadioLine {
  /** recorded: a cached clip is playing. caption: text only. */
  mode: 'recorded' | 'caption';
}

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
const CAPTION_MS = 3200;
const MAX_QUEUE = 3;

export const RADIO_LINES: RadioLine[] = lines;

/** One line at a time. New lines queue; when the queue is full the oldest waiting line is dropped. */
export class RadioPlayer {
  private queue: RadioLine[] = [];
  private current: RadioNow | null = null;
  private audio: HTMLAudioElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private clips: Promise<Set<string>> | null = null;
  private said = new Set<string>();
  private starting = false;
  isMuted: () => boolean = () => false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getNow = () => this.current;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private available(): Promise<Set<string>> {
    this.clips ??= fetch(`${BASE}radio/manifest.json`)
      .then((r) => (r.ok ? r.json() : { clips: [] }))
      .then((m: { clips: { id: string }[] }) => new Set(m.clips.map((c) => c.id)))
      .catch(() => new Set<string>());
    return this.clips;
  }

  /** Says a line by id. With once, a line already spoken this session is skipped. */
  say(id: string, once = true) {
    const line = RADIO_LINES.find((l) => l.id === id);
    if (!line || (once && this.said.has(id))) return;
    this.said.add(id);
    this.queue.push(line);
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
    if (!this.current) void this.next();
  }

  /** Clears the queue and what has been said, for a restart. */
  reset() {
    this.queue = [];
    this.said.clear();
    this.finish(false);
  }

  /** Silences a clip that is playing when the mute toggle is pressed. The caption stays. */
  silence() {
    this.audio?.pause();
  }

  private finish(advance = true) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.audio?.pause();
    this.audio = null;
    this.current = null;
    this.emit();
    if (advance) void this.next();
  }

  private async next() {
    if (this.starting) return;
    const line = this.queue.shift();
    if (!line) return;
    this.starting = true;
    const have = (await this.available()).has(line.id);
    this.starting = false;
    if (this.current) {
      this.queue.unshift(line);
      return;
    }
    const caption = () => {
      this.current = { ...line, mode: 'caption' };
      this.emit();
      this.timer = setTimeout(() => this.finish(), CAPTION_MS);
    };
    if (!have || this.isMuted()) return caption();
    const audio = new Audio(`${BASE}radio/${line.id}.mp3`);
    this.audio = audio;
    this.current = { ...line, mode: 'recorded' };
    audio.onended = () => this.finish();
    audio.onerror = () => {
      this.audio = null;
      caption();
    };
    try {
      await audio.play();
      this.emit();
    } catch {
      this.audio = null;
      caption();
    }
  }
}

export const radio = new RadioPlayer();
radio.isMuted = () => sound.muted;
