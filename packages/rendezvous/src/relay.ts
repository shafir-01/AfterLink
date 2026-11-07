import { sha256, type ActorId, type Link, type LinkInfo, type WireMessage } from '@afterlink/protocol';
import {
  acceptOffer,
  completeAnswer,
  createOfferPayload,
  type PendingOffer,
  type RendezvousDevice,
  type RendezvousResult,
} from './session.ts';

export const DEFAULT_MAX_HOPS = 3;
const DEFAULT_SCAN_MS = 1500;
const DEFAULT_SEEK_MS = 3000;
const MAX_SEEK_MS = 30_000;
const SEEN_LIMIT = 512;

/**
 * Carried on an existing data channel. A seek says "I have no link to you" and carries nothing
 * worth forging. An offer or answer is the same signed payload a person would carry by QR, so
 * the peers in the middle can drop it but cannot alter or answer it.
 */
export interface RelayMessage {
  t: 'relay';
  id: string;
  hop: number;
  from: ActorId;
  to: ActorId;
  data?: string;
}

/** The public Mesh surface this module composes with. */
export interface RelayMesh {
  readonly signalUp: boolean;
  stats(): { peer: ActorId; state: LinkInfo['state']; blocked: boolean }[];
  send(peer: ActorId, msg: WireMessage): boolean;
  onMessage(fn: (peer: ActorId, msg: WireMessage) => void): () => void;
  onLinkChange(fn: (info: LinkInfo) => void): () => void;
  adopt?(link: Link): void;
}

export interface RelayedSignalOptions {
  device: RendezvousDevice;
  mesh: RelayMesh;
  /** Defaults to mesh.adopt. An actor passes its own adoptLink so sync starts at once. */
  adopt?: (link: Link) => void;
  maxHops?: number;
  scanMs?: number;
  seekMs?: number;
  onResult?: (peer: ActorId, result: RendezvousResult) => void;
}

interface Attempt {
  pending?: PendingOffer;
  close(): void;
}

/**
 * Heals the mesh with no signalling server. When a roster peer has no link and signalling is down,
 * this device asks through whatever links it still has. Offers and answers then cross the live
 * peers in the middle and the two devices form their own direct link.
 */
export class RelayedSignal {
  private readonly device: RendezvousDevice;
  private readonly mesh: RelayMesh;
  private readonly adopt: (link: Link) => void;
  private readonly maxHops: number;
  private readonly scanMs: number;
  private readonly seekMs: number;
  private readonly onResult: RelayedSignalOptions['onResult'];
  private readonly seen = new Set<string>();
  private readonly attempts = new Map<ActorId, Attempt>();
  private readonly backoff = new Map<ActorId, { at: number; wait: number }>();
  private stops: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private count = 0;

  constructor(o: RelayedSignalOptions) {
    this.device = o.device;
    this.mesh = o.mesh;
    const adopt = o.adopt ?? o.mesh.adopt?.bind(o.mesh);
    if (!adopt) throw new Error('rendezvous: the mesh cannot adopt links');
    this.adopt = adopt;
    this.maxHops = o.maxHops ?? DEFAULT_MAX_HOPS;
    this.scanMs = o.scanMs ?? DEFAULT_SCAN_MS;
    this.seekMs = o.seekMs ?? DEFAULT_SEEK_MS;
    this.onResult = o.onResult;
  }

  private get self(): ActorId {
    return this.device.keys.publicKey;
  }

  private now(): number {
    return this.device.now?.() ?? Date.now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.stops = [
      this.mesh.onMessage((peer, msg) => {
        if ((msg as { t: string }).t === 'relay') this.receive(peer, msg as unknown as RelayMessage);
      }),
      this.mesh.onLinkChange((info) => {
        if (info.state === 'open') {
          this.backoff.delete(info.peer);
          this.attempts.get(info.peer)?.close();
          this.attempts.delete(info.peer);
        }
        this.scan();
      }),
    ];
    this.timer = setInterval(() => this.scan(), this.scanMs);
    this.scan();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const attempt of this.attempts.values()) attempt.close();
    this.attempts.clear();
  }

  private linkable(peer: ActorId): boolean {
    const s = this.mesh.stats().find((x) => x.peer === peer);
    return !!s && !s.blocked && s.state !== 'open' && s.state !== 'connecting';
  }

  /** Signalling up means the mesh heals itself; a device with no links has nobody to ask. */
  private scan(): void {
    if (this.timer === null || this.mesh.signalUp) return;
    const stats = this.mesh.stats();
    if (!stats.some((s) => s.state === 'open')) return;
    for (const s of stats) {
      if (this.linkable(s.peer) && !this.attempts.has(s.peer)) this.seek(s.peer);
    }
  }

  private seek(peer: ActorId): void {
    const now = this.now();
    const b = this.backoff.get(peer);
    if (b && now < b.at) return;
    const wait = Math.min((b?.wait ?? this.seekMs / 2) * 2, MAX_SEEK_MS);
    this.backoff.set(peer, { at: now + wait, wait });
    this.dispatch(peer);
  }

  private dispatch(to: ActorId, data?: string): void {
    const id = sha256(`${this.self}|${to}|${++this.count}|${this.now()}`).slice(0, 16);
    this.seen.add(id);
    this.forward({ t: 'relay', id, hop: 0, from: this.self, to, data });
  }

  private forward(m: RelayMessage, via?: ActorId): void {
    const wire = m as unknown as WireMessage;
    if (this.mesh.send(m.to, wire)) return;
    for (const s of this.mesh.stats()) {
      if (s.state === 'open' && s.peer !== via && s.peer !== m.from) this.mesh.send(s.peer, wire);
    }
  }

  private receive(via: ActorId, m: RelayMessage): void {
    if (typeof m.id !== 'string' || this.seen.has(m.id)) return;
    this.seen.add(m.id);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
    if (m.to !== this.self) {
      if (m.hop + 1 <= this.maxHops) this.forward({ ...m, hop: m.hop + 1 }, via);
      return;
    }
    if (!this.device.roster.some((e) => e.actor === m.from) || !this.linkable(m.from)) return;
    if (m.data) void this.onPayload(m.from, m.data);
    else this.onSeek(m.from);
  }

  /** The lower id offers, as it dials in the mesh. The higher id seeks back so the lower id learns of it. */
  private onSeek(from: ActorId): void {
    if (this.attempts.has(from)) return;
    if (this.self < from) void this.offer(from);
    else this.seek(from);
  }

  private async offer(peer: ActorId): Promise<void> {
    const attempt: Attempt = { close: () => undefined };
    this.attempts.set(peer, attempt);
    const pending = await createOfferPayload(this.device, { to: peer });
    if (!pending.ok || this.attempts.get(peer) !== attempt) {
      if (pending.ok) pending.close();
      if (this.attempts.get(peer) === attempt) this.attempts.delete(peer);
      return;
    }
    attempt.pending = pending;
    attempt.close = () => pending.close();
    const timer = setTimeout(() => this.drop(peer, attempt), this.device.connectMs ?? 20_000);
    attempt.close = () => {
      clearTimeout(timer);
      pending.close();
    };
    this.dispatch(peer, pending.text);
  }

  private drop(peer: ActorId, attempt: Attempt): void {
    if (this.attempts.get(peer) !== attempt) return;
    attempt.close();
    this.attempts.delete(peer);
  }

  private async onPayload(from: ActorId, data: string): Promise<void> {
    const waiting = this.attempts.get(from);
    if (waiting?.pending) {
      this.finish(from, waiting, await completeAnswer(this.device, waiting.pending, data));
      return;
    }
    if (waiting) return;
    const attempt: Attempt = { close: () => undefined };
    this.attempts.set(from, attempt);
    const device = { ...this.device, answerWaitMs: this.device.connectMs ?? 20_000 };
    const accepted = await acceptOffer(device, data);
    if (!accepted.ok) {
      this.finish(from, attempt, accepted);
      return;
    }
    attempt.close = () => accepted.close();
    this.dispatch(from, accepted.text);
    this.finish(from, attempt, await accepted.connected);
  }

  private finish(peer: ActorId, attempt: Attempt, result: RendezvousResult): void {
    if (this.attempts.get(peer) === attempt) this.attempts.delete(peer);
    if (result.ok) {
      if (this.linkable(peer)) this.adopt(result.link);
      else result.link.close('closed');
    } else attempt.close();
    this.onResult?.(peer, result);
  }
}

