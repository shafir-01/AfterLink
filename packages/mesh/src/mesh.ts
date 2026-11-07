import { b64u, canonicalize, signBytes, verifyBytes } from '@afterlink/protocol';
import type {
  ActorId,
  AnyEvent,
  FaultPlan,
  Link,
  LinkInfo,
  LinkState,
  SignalClient,
  SignalMessage,
  TaskSpec,
  WireMessage,
} from '@afterlink/protocol';
import { every, systemClock, type Clock } from './clock.ts';
import { SendGate } from './gate.ts';
import { helloProofBytes, type HubChallenge, type ProvedHello } from './hub.ts';
import { hashSeed, seeded, type Random } from './random.ts';
import type { BoundLink, LinkConnector, LinkStats } from './types.ts';

export interface MeshOptions {
  self: ActorId;
  peers: ActorId[];
  signal?: SignalClient | null;
  connector: LinkConnector;
  /** Signalling room. Pass the mission room so actors from other missions stay apart. */
  room?: string;
  /**
   * This actor's signing key. When set, a link only counts as open once both ends have proved the key
   * behind their actor id, and the hub is shown the same proof. All peers must be configured alike.
   */
  secretKey?: string;
  clock?: Clock;
  /** Seeds the fault gates and retry jitter. */
  seed?: number;
  pingMs?: number;
  /** A link silent for this long no longer counts as reachable. */
  silentAfterMs?: number;
  connectTimeoutMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

/**
 * Link control messages carried in signalling. Only the dialer starts a session.
 * knock: "I have no link with you, start a fresh one." dial: a new session. neg: connector payload.
 */
type LinkSignal =
  | { k: 'knock' }
  | { k: 'dial'; s: string }
  | { k: 'neg'; s: string; d: unknown };

/** First traffic on a new link: each end sends a nonce, then signs both nonces and the transport keys. */
type AuthFrame = { t: 'auth'; nonce?: string; proof?: string };

interface LinkAuth {
  nonce: string;
  peerNonce: string | null;
}

interface Slot {
  peer: ActorId;
  role: 'dialer' | 'listener';
  link: Link | null;
  /** Set while the link was negotiated here, so payloads from the peer can reach it. */
  negotiate: ((data: unknown) => void) | null;
  auth: LinkAuth | null;
  authFailures: number;
  session: string | null;
  gate: SendGate<WireMessage>;
  state: LinkState;
  online: boolean;
  sent: number;
  received: number;
  opens: number;
  attempts: number;
  rttMs?: number;
  lastHeardAt?: number;
  pingN: number;
  pings: Map<number, number>;
  openTimer: unknown;
  retryTimer: unknown;
  retryMs: number;
}

const MAX_OUTSTANDING_PINGS = 8;
const MAX_NONCE_CHARS = 64;
const MAX_SESSION_CHARS = 64;

function linkProofBytes(a: {
  room: string;
  prover: ActorId;
  verifier: ActorId;
  proverNonce: string;
  verifierNonce: string;
  binding: string;
}): Uint8Array {
  return new TextEncoder().encode(canonicalize({ domain: 'afterlink/link/1', ...a }));
}

export class Mesh {
  readonly self: ActorId;
  readonly clock: Clock;
  private readonly room: string;
  private readonly secretKey: string | undefined;
  private readonly connector: LinkConnector;
  private readonly pingMs: number;
  private readonly silentAfterMs: number;
  private readonly connectTimeoutMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly random: Random;
  private readonly slots = new Map<ActorId, Slot>();
  private readonly messageFns = new Set<(peer: ActorId, msg: WireMessage) => void>();
  private readonly linkFns = new Set<(info: LinkInfo) => void>();
  private readonly signalFns = new Set<(up: boolean) => void>();
  private readonly ingressFns = new Set<(ref: string, spec: TaskSpec) => void>();

  private signal: SignalClient | null;
  /** Clients offer no unsubscribe, so handlers from a replaced client are disarmed by this token. */
  private signalToken = 0;
  private up = false;
  private blocked = new Set<ActorId>();
  private running = false;
  private stopPing: (() => void) | null = null;
  private lastTickAt = 0;
  private sessionCount = 0;

  constructor(o: MeshOptions) {
    this.self = o.self;
    this.connector = o.connector;
    this.signal = o.signal ?? null;
    this.room = o.room ?? 'afterlink';
    this.secretKey = o.secretKey;
    this.clock = o.clock ?? o.connector.clock ?? systemClock;
    this.pingMs = o.pingMs ?? 2000;
    this.silentAfterMs = o.silentAfterMs ?? 7000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 10000;
    this.retryMinMs = o.retryMinMs ?? 300;
    this.retryMaxMs = o.retryMaxMs ?? 4000;
    this.random = seeded(hashSeed(o.self, o.seed ?? 0));
    for (const peer of o.peers) {
      if (peer !== o.self) this.slots.set(peer, this.createSlot(peer, o.seed ?? 0));
    }
  }

  get signalUp(): boolean {
    return this.up;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTickAt = this.clock.now();
    this.stopPing = every(this.clock, this.pingMs, () => this.tick());
    this.bindSignal(this.signal);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopPing?.();
    this.stopPing = null;
    this.signalToken++;
    this.setUp(false);
    for (const slot of this.slots.values()) {
      this.clearRetry(slot);
      if (slot.link) this.release(slot, 'closed');
    }
  }

  links(): LinkInfo[] {
    return [...this.slots.values()].map((slot) => this.info(slot));
  }

  stats(): LinkStats[] {
    return [...this.slots.values()].map((slot) => ({
      ...this.info(slot),
      opens: slot.opens,
      attempts: slot.attempts,
      dropped: slot.gate.dropped,
      duplicated: slot.gate.duplicated,
      held: slot.gate.held,
      online: slot.online,
      blocked: this.blocked.has(slot.peer),
      authenticated: slot.state === 'open' && slot.auth !== null,
      authFailures: slot.authFailures,
    }));
  }

  /** Peers with an open, proved link that has been heard from recently. */
  reachable(): ActorId[] {
    const now = this.clock.now();
    return [...this.slots.values()]
      .filter((s) => s.state === 'open' && now - (s.lastHeardAt ?? 0) <= this.silentAfterMs)
      .map((s) => s.peer);
  }

  /** Returns false when no open link to the peer exists. Reliability comes from anti-entropy, not from here. */
  send(peer: ActorId, msg: WireMessage): boolean {
    const slot = this.slots.get(peer);
    if (slot?.state !== 'open') return false;
    slot.gate.push(msg);
    return true;
  }

  broadcast(msg: WireMessage): void {
    for (const slot of this.slots.values()) {
      if (slot.state === 'open') slot.gate.push(msg);
    }
  }

  onMessage(fn: (peer: ActorId, msg: WireMessage) => void): () => void {
    return subscribe(this.messageFns, fn);
  }

  onLinkChange(fn: (info: LinkInfo) => void): () => void {
    return subscribe(this.linkFns, fn);
  }

  onSignalState(fn: (up: boolean) => void): () => void {
    return subscribe(this.signalFns, fn);
  }

  /** External requests routed to this device by the hub. */
  onIngress(fn: (ref: string, spec: TaskSpec) => void): () => void {
    return subscribe(this.ingressFns, fn);
  }

  /** Read-only report to the observer. Returns false when no signalling path exists. */
  report(events: AnyEvent[]): boolean {
    if (!this.up) return false;
    this.signal?.send({ t: 'report', actor: this.self, events, links: this.links() });
    return true;
  }

  /** Severs real links to blocked peers, refuses them until unblocked, and applies traffic faults to every link. */
  setFaults(plan: FaultPlan): void {
    const next = new Set(plan.blocked);
    const released = [...this.blocked].filter((peer) => !next.has(peer));
    this.blocked = next;
    for (const slot of this.slots.values()) {
      slot.gate.plan = {
        lossRate: plan.lossRate,
        duplicateRate: plan.duplicateRate,
        delayMs: plan.delayMs,
        reorder: plan.reorder,
      };
      if (next.has(slot.peer)) {
        this.clearRetry(slot);
        if (slot.link) this.release(slot, 'severed');
        else this.setState(slot, 'severed');
      }
    }
    for (const peer of released) {
      const slot = this.slots.get(peer);
      if (!slot) continue;
      this.setState(slot, 'closed');
      this.resetRetry(slot);
      this.reconcile(slot, true);
    }
  }

  /**
   * Takes over a link that was established outside signalling, replacing any link to that peer.
   * From here on it is like any other link: faults, heartbeats, stats and anti-entropy all apply.
   * A blocked or unknown peer is refused and the link is closed.
   */
  adopt(link: Link): boolean {
    const slot = this.slots.get(link.peer);
    if (!slot || !this.running || this.blocked.has(link.peer)) {
      link.close(this.blocked.has(link.peer) ? 'severed' : 'closed');
      return false;
    }
    if (slot.link) this.release(slot, 'closed');
    this.clearRetry(slot);
    slot.attempts++;
    this.track(slot, link);
    return true;
  }

  /** Replaces the signalling path. Established links are untouched. The caller owns and closes clients. */
  setSignal(client: SignalClient | null): void {
    this.signal = client;
    if (this.running) this.bindSignal(client);
  }

  private createSlot(peer: ActorId, seed: number): Slot {
    const slot: Slot = {
      peer,
      role: this.self < peer ? 'dialer' : 'listener',
      link: null,
      negotiate: null,
      auth: null,
      authFailures: 0,
      session: null,
      gate: new SendGate<WireMessage>(
        (msg) => this.transmit(slot, msg),
        this.clock,
        seeded(hashSeed(`${this.self}|${peer}`, seed)),
      ),
      state: 'closed',
      online: false,
      sent: 0,
      received: 0,
      opens: 0,
      attempts: 0,
      pingN: 0,
      pings: new Map(),
      openTimer: null,
      retryTimer: null,
      retryMs: this.retryMinMs,
    };
    return slot;
  }

  private info(slot: Slot): LinkInfo {
    return {
      peer: slot.peer,
      state: slot.state,
      transport: this.connector.kind,
      rttMs: slot.rttMs,
      sent: slot.sent,
      received: slot.received,
      lastHeardAt: slot.lastHeardAt,
    };
  }

  private setState(slot: Slot, state: LinkState): void {
    if (slot.state === state) return;
    slot.state = state;
    const info = this.info(slot);
    for (const fn of [...this.linkFns]) fn(info);
  }

  private transmit(slot: Slot, msg: WireMessage): void {
    if (slot.state !== 'open') return;
    slot.sent++;
    slot.link?.send(msg);
  }

  // ---------- Signalling ----------

  private bindSignal(client: SignalClient | null): void {
    const token = ++this.signalToken;
    for (const slot of this.slots.values()) slot.online = false;
    if (!client) {
      this.setUp(false);
      return;
    }
    client.onMessage((m) => {
      if (token === this.signalToken) this.onSignal(m);
    });
    client.onState((up) => {
      if (token === this.signalToken) this.onSignalUp(client, up);
    });
    this.onSignalUp(client, client.connected);
  }

  private onSignalUp(client: SignalClient, up: boolean): void {
    if (!up) {
      for (const slot of this.slots.values()) slot.online = false;
    }
    this.setUp(up);
    if (up) client.send({ t: 'hello', room: this.room, actor: this.self });
  }

  private setUp(up: boolean): void {
    if (this.up === up) return;
    this.up = up;
    for (const fn of [...this.signalFns]) fn(up);
  }

  private onSignal(raw: SignalMessage): void {
    const m = raw as SignalMessage | HubChallenge;
    switch (m.t) {
      case 'challenge':
        this.proveToHub(m.nonce);
        break;
      case 'peers': {
        const present = new Set(m.peers);
        for (const slot of this.slots.values()) {
          slot.online = present.has(slot.peer);
          if (slot.online) this.peerPresent(slot);
        }
        break;
      }
      case 'joined': {
        const slot = this.slots.get(m.actor);
        if (slot) {
          slot.online = true;
          this.peerPresent(slot);
        }
        break;
      }
      case 'left': {
        const slot = this.slots.get(m.actor);
        if (slot) slot.online = false;
        break;
      }
      case 'signal': {
        const slot = this.slots.get(m.from);
        if (slot && m.to === this.self) this.onLinkSignal(slot, m.data as LinkSignal);
        break;
      }
      case 'ingress':
        for (const fn of [...this.ingressFns]) fn(m.ref, m.spec);
        break;
    }
  }

  private proveToHub(nonce: string): void {
    if (this.secretKey === undefined || typeof nonce !== 'string') return;
    const sig = signBytes(this.secretKey, helloProofBytes(this.room, this.self, nonce));
    const hello: ProvedHello = { t: 'hello', room: this.room, actor: this.self, nonce, sig };
    this.signal?.send(hello);
  }

  private peerPresent(slot: Slot): void {
    this.resetRetry(slot);
    this.reconcile(slot, false);
  }

  private onLinkSignal(slot: Slot, data: LinkSignal): void {
    if (!this.running || this.blocked.has(slot.peer) || !data) return;
    switch (data.k) {
      case 'knock':
        if (slot.role !== 'dialer') return;
        slot.online = true;
        if (slot.link) this.release(slot, 'closed');
        this.resetRetry(slot);
        this.reconcile(slot, true);
        break;
      case 'dial':
        if (slot.role !== 'listener' || !validSession(data.s)) return;
        slot.online = true;
        if (slot.link) this.release(slot, 'closed');
        this.clearRetry(slot);
        this.bind(slot, data.s);
        break;
      case 'neg':
        if (data.s === slot.session) slot.negotiate?.(data.d);
        break;
    }
  }

  private sendLinkSignal(peer: ActorId, data: LinkSignal): void {
    if (this.up) this.signal?.send({ t: 'signal', from: this.self, to: peer, data });
  }

  // ---------- Link lifecycle ----------

  /** Moves one peer towards a link if nothing stands in the way. Safe to call at any time. */
  private reconcile(slot: Slot, urgent: boolean): void {
    if (!this.running || slot.link || this.blocked.has(slot.peer)) return;
    if (!this.up || !slot.online || slot.retryTimer !== null) return;
    if (slot.role === 'dialer') {
      this.bind(slot, this.nextSession(slot));
      return;
    }
    if (urgent) this.sendLinkSignal(slot.peer, { k: 'knock' });
    this.scheduleRetry(slot);
  }

  private nextSession(slot: Slot): string {
    const session = `${this.clock.now().toString(36)}.${++this.sessionCount}`;
    this.sendLinkSignal(slot.peer, { k: 'dial', s: session });
    return session;
  }

  private bind(slot: Slot, session: string): void {
    slot.attempts++;
    slot.session = session;
    const link = this.connector.connect({
      self: this.self,
      peer: slot.peer,
      role: slot.role,
      polite: slot.role === 'listener',
      signal: (data) => {
        if (slot.session === session) this.sendLinkSignal(slot.peer, { k: 'neg', s: session, d: data });
      },
    });
    slot.negotiate = (data) => link.signal(data);
    this.track(slot, link);
  }

  private track(slot: Slot, link: Link): void {
    slot.link = link;
    link.onMessage((msg) => this.onWire(slot, link, msg));
    link.onState((state) => this.onLinkState(slot, link, state));
    this.setState(slot, 'connecting');
    slot.openTimer = this.clock.setTimeout(() => {
      if (slot.link !== link || slot.state === 'open') return;
      this.release(slot, 'closed');
      this.scheduleRetry(slot);
    }, this.connectTimeoutMs);
    if (link.state === 'open') this.onLinkState(slot, link, 'open');
  }

  private onLinkState(slot: Slot, link: Link, state: LinkState): void {
    if (slot.link !== link) return;
    if (state === 'open') {
      slot.lastHeardAt = this.clock.now();
      if (this.secretKey === undefined) this.linkReady(slot);
      else this.beginAuth(slot, link);
    } else if (state === 'closed' || state === 'severed') {
      this.release(slot, state);
      this.scheduleRetry(slot);
    }
  }

  private linkReady(slot: Slot): void {
    this.clock.clearTimeout(slot.openTimer);
    slot.retryMs = this.retryMinMs;
    slot.opens++;
    this.setState(slot, 'open');
  }

  // ---------- Key proof ----------

  private beginAuth(slot: Slot, link: Link): void {
    slot.auth = { nonce: b64u(crypto.getRandomValues(new Uint8Array(16))), peerNonce: null };
    this.sendAuth(link, { t: 'auth', nonce: slot.auth.nonce });
  }

  /** Auth frames skip the fault gate: like a transport handshake, they are not mission traffic. */
  private sendAuth(link: Link, frame: AuthFrame): void {
    link.send(frame as unknown as WireMessage);
  }

  private onAuth(slot: Slot, link: Link, frame: AuthFrame): void {
    const { auth } = slot;
    if (!auth || this.secretKey === undefined) return;
    const binding = (link as Partial<BoundLink>).binding?.() ?? '';
    if (typeof frame.nonce === 'string' && frame.nonce.length <= MAX_NONCE_CHARS) {
      auth.peerNonce ??= frame.nonce;
      const bytes = linkProofBytes({
        room: this.room,
        prover: this.self,
        verifier: slot.peer,
        proverNonce: auth.nonce,
        verifierNonce: auth.peerNonce,
        binding,
      });
      this.sendAuth(link, { t: 'auth', proof: signBytes(this.secretKey, bytes) });
      return;
    }
    if (typeof frame.proof !== 'string' || auth.peerNonce === null || slot.state === 'open') return;
    const bytes = linkProofBytes({
      room: this.room,
      prover: slot.peer,
      verifier: this.self,
      proverNonce: auth.peerNonce,
      verifierNonce: auth.nonce,
      binding,
    });
    if (safeVerify(slot.peer, bytes, frame.proof)) {
      this.linkReady(slot);
    } else {
      slot.authFailures++;
      this.release(slot, 'closed');
      this.scheduleRetry(slot);
    }
  }

  /** Tears down the transport, discards anything still held back, and records the end state. */
  private release(slot: Slot, reason: 'closed' | 'severed'): void {
    const link = slot.link;
    slot.link = null;
    slot.session = null;
    slot.negotiate = null;
    slot.auth = null;
    this.clock.clearTimeout(slot.openTimer);
    slot.gate.clear();
    slot.pings.clear();
    link?.close(reason);
    this.setState(slot, this.blocked.has(slot.peer) ? 'severed' : reason);
  }

  private scheduleRetry(slot: Slot): void {
    if (!this.running || slot.retryTimer !== null || this.blocked.has(slot.peer)) return;
    const wait = slot.retryMs * (slot.role === 'listener' ? 2 : 1) * (0.75 + this.random() * 0.5);
    slot.retryMs = Math.min(slot.retryMs * 2, this.retryMaxMs);
    slot.retryTimer = this.clock.setTimeout(() => {
      slot.retryTimer = null;
      this.reconcile(slot, true);
    }, wait);
  }

  private clearRetry(slot: Slot): void {
    this.clock.clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
  }

  private resetRetry(slot: Slot): void {
    this.clearRetry(slot);
    slot.retryMs = this.retryMinMs;
  }

  // ---------- Traffic ----------

  private onWire(slot: Slot, link: Link, raw: WireMessage): void {
    const msg = raw as WireMessage | AuthFrame;
    if (slot.link !== link || !msg || typeof msg.t !== 'string') return;
    const now = this.clock.now();
    slot.received++;
    slot.lastHeardAt = now;
    if (msg.t === 'auth') {
      this.onAuth(slot, link, msg);
      return;
    }
    if (slot.state !== 'open') return;
    if (msg.t === 'ping') {
      slot.gate.push({ t: 'pong', n: msg.n });
      return;
    }
    if (msg.t === 'pong') {
      const sentAt = slot.pings.get(msg.n);
      if (sentAt !== undefined) {
        slot.pings.delete(msg.n);
        slot.rttMs = now - sentAt;
      }
      return;
    }
    for (const fn of [...this.messageFns]) fn(slot.peer, msg);
  }

  private tick(): void {
    const now = this.clock.now();
    const stalled = now - this.lastTickAt > this.pingMs * 2;
    this.lastTickAt = now;
    for (const slot of this.slots.values()) {
      if (slot.state !== 'open') {
        if (slot.auth && slot.link) this.sendAuth(slot.link, { t: 'auth', nonce: slot.auth.nonce });
        continue;
      }
      const silent = now - (slot.lastHeardAt ?? now) > this.silentAfterMs;
      // A quiet link is only given up when a replacement can be negotiated. Without signalling it may
      // still recover by itself and could never be rebuilt, so only the transport can declare it dead.
      if (silent && !stalled && this.up && slot.online) {
        this.release(slot, 'closed');
        this.scheduleRetry(slot);
        continue;
      }
      const n = ++slot.pingN;
      slot.pings.set(n, now);
      if (slot.pings.size > MAX_OUTSTANDING_PINGS) slot.pings.delete(n - MAX_OUTSTANDING_PINGS);
      slot.gate.push({ t: 'ping', n });
    }
  }
}

function validSession(session: unknown): session is string {
  return typeof session === 'string' && session.length > 0 && session.length <= MAX_SESSION_CHARS;
}

function safeVerify(actor: ActorId, data: Uint8Array, sig: string): boolean {
  try {
    return verifyBytes(actor, data, sig);
  } catch {
    return false;
  }
}

function subscribe<F>(set: Set<F>, fn: F): () => void {
  set.add(fn);
  return () => set.delete(fn);
}
