import type { ActorId, LinkState, SignalClient, SignalMessage, WireMessage } from '@afterlink/protocol';
import { systemClock, type Clock } from './clock.ts';
import { SendGate, type GatePlan } from './gate.ts';
import { createHub, type Hub, type HubConnection, type HubState } from './hub.ts';
import { seeded, type Random } from './random.ts';
import type { LinkConnector, LinkRequest, NegotiatedLink } from './types.ts';

export interface MemoryNetworkOptions {
  seed?: number;
  clock?: Clock;
  /** One way delay of every link message. */
  latencyMs?: number;
  /** One way delay between a device and the hub. */
  signalLatencyMs?: number;
}

type Handshake = { k: 'offer' | 'answer' | 'refuse'; id: number };
type Pair = readonly [ActorId, ActorId];

const pairKey = (a: ActorId, b: ActorId) => (a < b ? `${a}|${b}` : `${b}|${a}`);

class MemoryLink implements NegotiatedLink {
  readonly kind = 'memory' as const;
  readonly peer: ActorId;
  state: LinkState = 'connecting';
  other: MemoryLink | null = null;
  readonly gate: SendGate<WireMessage>;
  private messageFn: (msg: WireMessage) => void = () => {};
  private stateFn: (s: LinkState) => void = () => {};
  private inbox: WireMessage[] = [];

  constructor(
    private readonly net: MemoryNetwork,
    readonly self: ActorId,
    private readonly req: LinkRequest,
    readonly id: number,
  ) {
    this.peer = req.peer;
    this.gate = net.gateFor(this);
  }

  send(msg: WireMessage): void {
    if (this.state === 'open') this.gate.push(msg);
  }

  onMessage(fn: (msg: WireMessage) => void): void {
    this.messageFn = fn;
  }

  onState(fn: (s: LinkState) => void): void {
    this.stateFn = fn;
  }

  signal(data: unknown): void {
    const shake = data as Handshake;
    if (shake?.k === 'offer') {
      if (this.net.pair(this, shake.id)) {
        this.setState('open');
        this.req.signal({ k: 'answer', id: shake.id } satisfies Handshake);
      } else {
        this.req.signal({ k: 'refuse', id: shake.id } satisfies Handshake);
        this.close('closed');
      }
    } else if (shake?.k === 'answer' && this.other) {
      this.setState('open');
    } else if (shake?.k === 'refuse') {
      this.close('closed');
    }
  }

  close(reason: 'severed' | 'closed'): void {
    if (this.state === 'closed' || this.state === 'severed') return;
    const other = this.other;
    this.end(reason);
    if (other) this.net.notifyClosed(other);
  }

  /** Ends this side at once, as a cut cable or a close notification does. */
  end(state: 'severed' | 'closed'): void {
    if (this.state === 'closed' || this.state === 'severed') return;
    this.other = null;
    this.gate.clear();
    this.net.forget(this);
    this.setState(state);
  }

  receive(msg: WireMessage): void {
    if (this.state === 'open') this.messageFn(msg);
    else if (this.state === 'connecting') this.inbox.push(msg);
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateFn(state);
    if (state === 'open') {
      const held = this.inbox;
      this.inbox = [];
      for (const msg of held) this.messageFn(msg);
    }
  }
}

class MemorySignalClient implements SignalClient {
  connected = false;
  private messageFns = new Set<(m: SignalMessage) => void>();
  private stateFns = new Set<(up: boolean) => void>();
  private conn: HubConnection | null = null;
  private epoch = 0;
  private closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly latencyMs: number,
    private readonly onClose: () => void,
  ) {}

  attach(hub: Hub): void {
    if (this.closed) return;
    const epoch = ++this.epoch;
    this.conn = hub.connect((m) => {
      this.clock.setTimeout(() => {
        if (epoch === this.epoch) this.emit(m);
      }, this.latencyMs);
    });
    this.clock.setTimeout(() => {
      if (epoch === this.epoch) this.setUp(true);
    }, this.latencyMs);
  }

  detach(): void {
    this.epoch++;
    this.conn = null;
    this.setUp(false);
  }

  send(msg: SignalMessage): void {
    if (!this.connected) return;
    const { conn, epoch } = this;
    this.clock.setTimeout(() => {
      if (epoch === this.epoch) conn?.receive(msg);
    }, this.latencyMs);
  }

  onMessage(fn: (m: SignalMessage) => void): void {
    this.messageFns.add(fn);
  }

  onState(fn: (up: boolean) => void): void {
    this.stateFns.add(fn);
  }

  close(): void {
    this.closed = true;
    this.conn?.close();
    this.detach();
    this.onClose();
  }

  private emit(m: SignalMessage): void {
    for (const fn of [...this.messageFns]) fn(m);
  }

  private setUp(up: boolean): void {
    if (this.connected === up) return;
    this.connected = up;
    for (const fn of [...this.stateFns]) fn(up);
  }
}

/**
 * A deterministic network for tests and the lab. Links form only through signalling, exactly as
 * WebRTC does, so killing the hub stops new links while established ones keep working.
 */
export class MemoryNetwork {
  readonly clock: Clock;
  private readonly random: Random;
  private readonly latencyMs: number;
  private readonly signalLatencyMs: number;
  private readonly clients = new Set<MemorySignalClient>();
  private readonly live = new Set<MemoryLink>();
  private readonly offers = new Map<number, MemoryLink>();
  private readonly pairPlans = new Map<string, GatePlan>();
  private currentHub: Hub | null;
  private plan: GatePlan = {};
  private groups: Map<ActorId, number> | null = null;
  private nextLinkId = 1;

  constructor(o: MemoryNetworkOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.random = seeded(o.seed ?? 1);
    this.latencyMs = o.latencyMs ?? 1;
    this.signalLatencyMs = o.signalLatencyMs ?? 1;
    this.currentHub = this.newHub();
  }

  get hubUp(): boolean {
    return this.currentHub !== null;
  }

  connector(actor: ActorId): LinkConnector {
    return {
      kind: 'memory',
      clock: this.clock,
      connect: (req) => {
        const id = this.nextLinkId++;
        const link = new MemoryLink(this, actor, req, id);
        this.live.add(link);
        if (req.role === 'dialer') {
          this.offers.set(id, link);
          req.signal({ k: 'offer', id } satisfies Handshake);
        }
        return link;
      },
    };
  }

  signal(_actor: ActorId): SignalClient {
    const client: MemorySignalClient = new MemorySignalClient(this.clock, this.signalLatencyMs, () =>
      this.clients.delete(client),
    );
    this.clients.add(client);
    if (this.currentHub) client.attach(this.currentHub);
    return client;
  }

  /** Observer state, or null while the hub is down. */
  hubState(): HubState | null {
    return this.currentHub?.state() ?? null;
  }

  /** Stops signalling and forgets all hub state, as terminating the worker does. Links are not involved. */
  killHub(): void {
    this.currentHub = null;
    for (const client of this.clients) client.detach();
  }

  restoreHub(): void {
    if (this.currentHub) return;
    const hub = this.newHub();
    this.currentHub = hub;
    for (const client of this.clients) client.attach(hub);
  }

  /** Cuts every link between groups and refuses new ones. Actors in no group are cut off from everyone. */
  partition(groups: ActorId[][]): void {
    this.groups = new Map(groups.flatMap((group, i) => group.map((actor) => [actor, i] as const)));
    for (const link of [...this.live]) {
      if (!this.canReach(link.self, link.peer)) link.end('severed');
    }
  }

  heal(): void {
    this.groups = null;
  }

  setLoss(rate: number, between?: Pair): void {
    this.applyPlan({ lossRate: rate }, between);
  }

  setDuplicate(rate: number, between?: Pair): void {
    this.applyPlan({ duplicateRate: rate }, between);
  }

  setDelay(ms: number, between?: Pair): void {
    this.applyPlan({ delayMs: ms }, between);
  }

  setReorder(on: boolean, between?: Pair): void {
    this.applyPlan({ reorder: on }, between);
  }

  /** Surviving transport paths: every pair joined by a link that is open at both ends. */
  paths(): Pair[] {
    const found = new Map<string, Pair>();
    for (const link of this.live) {
      if (link.state === 'open' && link.other?.state === 'open') {
        const pair: Pair = link.self < link.peer ? [link.self, link.peer] : [link.peer, link.self];
        found.set(pairKey(link.self, link.peer), pair);
      }
    }
    return [...found.values()].sort((a, b) => (pairKey(...a) < pairKey(...b) ? -1 : 1));
  }

  canReach(a: ActorId, b: ActorId): boolean {
    if (!this.groups) return true;
    const group = this.groups.get(a);
    return group !== undefined && group === this.groups.get(b);
  }

  gateFor(link: MemoryLink): SendGate<WireMessage> {
    const gate = new SendGate<WireMessage>(
      (msg) => link.other?.receive(msg),
      this.clock,
      this.random,
      this.latencyMs,
    );
    gate.plan = this.planFor(link.self, link.peer);
    return gate;
  }

  /** Joins a listener to the dialer that made the offer, if the network allows it. */
  pair(listener: MemoryLink, offerId: number): boolean {
    const dialer = this.offers.get(offerId);
    if (!dialer || dialer.state !== 'connecting' || !this.canReach(listener.self, dialer.self)) return false;
    this.offers.delete(offerId);
    dialer.other = listener;
    listener.other = dialer;
    return true;
  }

  notifyClosed(link: MemoryLink): void {
    this.clock.setTimeout(() => link.end('closed'), this.latencyMs);
  }

  forget(link: MemoryLink): void {
    this.live.delete(link);
    this.offers.delete(link.id);
  }

  private newHub(): Hub {
    return createHub({ now: () => this.clock.now(), verifyEvents: false });
  }

  private planFor(a: ActorId, b: ActorId): GatePlan {
    return { ...this.plan, ...this.pairPlans.get(pairKey(a, b)) };
  }

  private applyPlan(change: GatePlan, between?: Pair): void {
    if (between) {
      const key = pairKey(between[0], between[1]);
      this.pairPlans.set(key, { ...this.pairPlans.get(key), ...change });
    } else {
      this.plan = { ...this.plan, ...change };
    }
    for (const link of this.live) link.gate.plan = this.planFor(link.self, link.peer);
  }
}
