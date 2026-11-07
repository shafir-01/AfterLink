import type { Capability, TaskId, TaskSpec, TokenId } from '@afterlink/protocol';
import { SimNet } from './net.ts';
import { TIMING, type FaultStep, type Incident, type Scenario } from './scenario.ts';
import { emptyReport, type AttackResult, type RunContext, type SystemReport, type SystemUnderTest } from './system.ts';
import { FieldWorker } from './worker.ts';

/** The same queue depth the AfterLink planner allows each team. */
const MAX_CLAIMED = 3;

const FREE = -1;

type Card = { card: TaskSpec; status: 'open' | 'claimed' | 'done'; owner: number | null };
type Booking = { holder: number; task: TaskId };
type Fact = { observed: unknown };
type BoardValue = Card | Booking | Fact;

interface Entry {
  k: string;
  v: BoardValue;
  ts: number;
  by: number;
}

type Msg =
  /** "Send me what I have not seen": `have` is the last version of yours I hold. */
  | { t: 'digest'; have: number }
  | { t: 'delta'; upTo: number; entries: Entry[] };

const newer = (a: Entry, b: Entry) => a.ts > b.ts || (a.ts === b.ts && a.by > b.by);
const stamp = (e: Entry) => `${e.k}@${e.ts}:${e.by}`;
const cardOf = (e: Entry | undefined) => e?.v as Card | undefined;
const bookingOf = (e: Entry | undefined) => e?.v as Booking | undefined;
const claimant = (e: Entry) => (e.k.startsWith('res/') ? bookingOf(e)?.holder : cardOf(e)?.owner) ?? null;

/**
 * Baseline B at full strength: a replicated board that works with no server. Every device edits
 * locally and pushes each write at once, gossips deltas between any reachable pair, and shares the
 * same links and the same cover rule as AfterLink. Clocks are perfect. What it lacks is exactly what
 * makes it a last-write-wins board: no rights model, no validity on facts, no record of losing writes.
 */
export class BoardSystem implements SystemUnderTest {
  readonly id = 'board' as const;
  private net: SimNet;
  private clients: BoardClient[];
  private scenario: Scenario;
  private attacks: AttackResult[] = [];
  private ferry: { first: number; second: number } | null = null;
  /** Lab bookkeeping, off the wire: which write each write replaced, and which writes lost a contest. */
  readonly replaced = new WeakMap<Entry, string | null>();
  readonly lostWrites = new Set<string>();

  constructor(private ctx: RunContext) {
    this.scenario = ctx.scenario;
    this.net = new SimNet(ctx.sim, ctx.rng.fork('net'));
    this.clients = this.scenario.world.teams.map((t, i) => new BoardClient(i, t.capabilities, ctx, this.net, this));
  }

  async start(): Promise<void> {
    for (const c of this.clients) c.start();
    this.net.onLinkUp = (a, b) => {
      this.clients[a]?.greet(b);
      this.clients[b]?.greet(a);
    };
  }

  inject(i: Incident): void {
    this.clients[i.reporter]?.report(i.spec);
  }

  apply(step: FaultStep): void {
    switch (step.kind) {
      case 'hub':
        this.net.setHub(step.up);
        break;
      case 'links':
        this.net.setCut(step.cut, step.hubReach);
        break;
      case 'quality':
        this.net.setQuality(step.quality);
        break;
      case 'restart':
        this.clients[step.actor]?.restart(step.downForMs);
        break;
      case 'observe':
        this.clients[step.actor]?.observe(step.key, step.value);
        break;
      case 'ferry': {
        const snapshot = (this.clients[step.from] as BoardClient).snapshot();
        const to = this.clients[step.to] as BoardClient;
        const first = to.importSnapshot(snapshot);
        let second = 0;
        for (let i = 1; i < step.copies; i++) second += to.importSnapshot(snapshot);
        this.ferry = { first, second };
        break;
      }
      case 'transfer':
        break;
      case 'attack':
        this.attacks.push(this.attack(step.attack, step.target));
        break;
    }
  }

  /**
   * Devices talk over authenticated channels, so wire attacks from outsiders are assumed stopped.
   * A carried board export is a plain file with nothing to verify, and a teammate's edit is a valid write.
   */
  private attack(attack: string, target: number): AttackResult {
    const victim = this.clients[target] as BoardClient;
    switch (attack) {
      case 'forged-packet': {
        const spec = this.scenario.incidents.find((i) => i.at <= this.ctx.sim.now && victim.entry(`task/${i.spec.id}`) && cardOf(victim.entry(`task/${i.spec.id}`))?.status !== 'done')?.spec;
        if (!spec) return { attack, outcome: 'no-effect' };
        const forged: Entry = { k: `task/${spec.id}`, v: { card: spec, status: 'done', owner: target }, ts: this.ctx.sim.now + 1, by: 9 };
        return { attack, outcome: victim.importSnapshot([forged]) > 0 ? 'accepted' : 'no-effect' };
      }
      case 'replayed-packet':
        return { attack, outcome: victim.importSnapshot(victim.firstExport()) > 0 ? 'accepted' : 'no-effect' };
      case 'insider-fork': {
        const token = this.scenario.world.resources[0]?.tokens[0]?.id as TokenId;
        victim.bookDirect(token, 'insider-1');
        victim.bookDirect(token, 'insider-2');
        return { attack, outcome: 'accepted' };
      }
      default:
        return { attack, outcome: 'assumed' };
    }
  }

  bytes(): number {
    return this.net.sentBytes;
  }

  observerBytes(): number {
    return 0;
  }

  isConverged(): boolean {
    const [first, ...rest] = this.clients.map((c) => c.digest());
    return rest.every((d) => d === first);
  }

  report(): SystemReport {
    const report = emptyReport();
    report.converged = this.isConverged();
    report.silentOverwrites = this.lostWrites.size;
    const merged = this.clients[0] as BoardClient;
    const finished = new Set(this.clients.flatMap((c) => c.finished));
    report.lostCompletions = [...finished].filter((id) => cardOf(merged.entry(`task/${id}`))?.status !== 'done').length;
    report.attacks = this.attacks;
    report.replayDivergence = merged.replayDiffers(this.ctx) ? 1 : 0;
    if (this.ferry) {
      report.ferryNewFirst = this.ferry.first;
      report.ferryNewSecond = this.ferry.second;
    }
    return report;
  }

  stop(): void {}
}

class BoardClient {
  finished: TaskId[] = [];
  private entries = new Map<string, Entry>();
  private versions = new Map<string, number>();
  private version = 0;
  private peerHave = new Map<number, number>();
  private seenUpTo = new Map<number, number>();
  private lastHeard = new Map<number, number>();
  private worker: FieldWorker;
  private off = false;
  private refused = new Set<string>();
  private firstSnapshot: Entry[] | null = null;

  constructor(
    readonly index: number,
    readonly capabilities: Capability[],
    private ctx: RunContext,
    private net: SimNet,
    private system: BoardSystem,
  ) {
    this.worker = new FieldWorker(
      ctx.sim,
      (task) => ctx.trace({ t: ctx.sim.now, kind: 'start', actor: index, task }),
      (task) => this.finish(task),
    );
  }

  private get peers(): number[] {
    return this.ctx.scenario.world.teams.map((_, i) => i).filter((i) => i !== this.index);
  }

  start(): void {
    this.net.on(this.index, (from, msg) => this.onMessage(from, msg as Msg));
    const phase = this.ctx.rng.fork(`phase${this.index}`).int(1, TIMING.tickMs);
    this.ctx.sim.every(TIMING.tickMs, () => this.tick(), phase);
  }

  entry(k: string): Entry | undefined {
    return this.entries.get(k);
  }

  report(spec: TaskSpec): void {
    if (this.entries.has(`task/${spec.id}`)) return;
    this.write(`task/${spec.id}`, { card: spec, status: 'open', owner: null });
  }

  observe(key: string, value: unknown): void {
    this.write(`obs/${key}`, { observed: value });
  }

  bookDirect(token: TokenId, task: TaskId): void {
    this.write(`res/${token}`, { holder: this.index, task });
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'commit', actor: this.index, task, token });
  }

  restart(downForMs: number): void {
    this.off = true;
    this.net.setDown(this.index, true);
    this.worker.suspend(downForMs);
    this.ctx.sim.after(downForMs, () => {
      this.off = false;
      this.net.setDown(this.index, false);
    });
  }

  snapshot(): Entry[] {
    const all = [...this.entries.values()];
    this.firstSnapshot ??= all;
    return all;
  }

  firstExport(): Entry[] {
    return this.firstSnapshot ?? [...this.entries.values()].slice(0, 20);
  }

  /** Merges a carried export. Returns how many records it changed. */
  importSnapshot(entries: Entry[]): number {
    let changed = 0;
    for (const e of entries) if (this.merge(e)) changed++;
    if (changed > 0) this.afterMerge();
    return changed;
  }

  digest(): string {
    return [...this.entries.values()].map(stamp).sort().join(',');
  }

  /** Re-applies the merged record twice in random order to an empty board and compares. */
  replayDiffers(ctx: RunContext): boolean {
    const all = [...this.entries.values()];
    const replica = new Map<string, Entry>();
    for (const e of ctx.rng.fork('replay').shuffle([...all, ...all])) {
      const current = replica.get(e.k);
      if (!current || newer(e, current)) replica.set(e.k, e);
    }
    return [...replica.values()].map(stamp).sort().join(',') !== this.digest();
  }

  private write(k: string, v: BoardValue): void {
    const prior = this.entries.get(k);
    const entry: Entry = { k, v, ts: Math.max(this.ctx.sim.now, (prior?.ts ?? 0) + 1), by: this.index };
    this.system.replaced.set(entry, prior ? stamp(prior) : null);
    this.entries.set(k, entry);
    this.versions.set(k, ++this.version);
    for (const peer of this.peers) this.push(peer);
  }

  /** Last write wins. The losing write is gone, with nothing kept to show it existed. */
  private merge(e: Entry): boolean {
    const current = this.entries.get(e.k);
    if (current && stamp(current) === stamp(e)) return false;
    if (current) this.noteContest(current, e);
    if (current && !newer(e, current)) return false;
    this.entries.set(e.k, e);
    this.versions.set(e.k, ++this.version);
    return true;
  }

  /** Two writes made without seeing each other, each naming a different team. */
  private noteContest(a: Entry, b: Entry): void {
    if (!a.k.startsWith('res/') && !a.k.startsWith('task/')) return;
    const concurrent = this.system.replaced.get(a) !== stamp(b) && this.system.replaced.get(b) !== stamp(a);
    if (!concurrent) return;
    const [x, y] = [claimant(a), claimant(b)];
    if (x === null || y === null || x === y || x === FREE || y === FREE) return;
    this.system.lostWrites.add(stamp(newer(a, b) ? b : a));
  }

  private push(peer: number): void {
    if (this.off) return;
    const have = this.peerHave.get(peer) ?? 0;
    const entries = [...this.entries.values()].filter((e) => (this.versions.get(e.k) ?? 0) > have);
    if (entries.length === 0) return;
    this.net.send(this.index, peer, { t: 'delta', upTo: this.version, entries } satisfies Msg);
  }

  private onMessage(from: number, msg: Msg): void {
    this.lastHeard.set(from, this.ctx.sim.now);
    if (msg.t === 'digest') {
      this.peerHave.set(from, msg.have);
      this.push(from);
      return;
    }
    let changed = false;
    for (const e of msg.entries) if (this.merge(e)) changed = true;
    this.seenUpTo.set(from, Math.max(this.seenUpTo.get(from) ?? 0, msg.upTo));
    if (changed) {
      this.afterMerge();
      for (const peer of this.peers) if (peer !== from) this.push(peer);
    }
  }

  /** A person whose card now shows someone else stops, and frees whatever they booked for it. */
  private afterMerge(): void {
    for (const task of this.worker.tasks()) {
      const state = cardOf(this.entries.get(`task/${task}`));
      if (!state || state.owner === this.index) continue;
      this.worker.drop(task);
      this.ctx.trace({ t: this.ctx.sim.now, kind: 'abandon', actor: this.index, task });
      for (const e of [...this.entries.values()]) {
        if (e.k.startsWith('res/') && bookingOf(e)?.holder === this.index && bookingOf(e)?.task === task) {
          this.write(e.k, { holder: FREE, task: '' });
        }
      }
    }
  }

  greet(peer: number): void {
    this.net.send(this.index, peer, { t: 'digest', have: this.seenUpTo.get(peer) ?? 0 } satisfies Msg);
  }

  private tick(): void {
    if (this.off) return;
    for (const peer of this.peers) this.greet(peer);
    while (this.worker.queued < MAX_CLAIMED && this.takeWork());
  }

  private takeWork(): boolean {
    const now = this.ctx.sim.now;
    const { coverAfterMs, coverMaxPriority } = this.ctx.scenario.world.fallback;
    const cards = [...this.entries.values()]
      .filter((e) => e.k.startsWith('task/'))
      .sort((a, b) => (cardOf(a) as Card).card.priority - (cardOf(b) as Card).card.priority || a.ts - b.ts);
    for (const entry of cards) {
      const state = cardOf(entry) as Card;
      const { card } = state;
      if (!card.requires.every((r) => this.capabilities.includes(r))) continue;
      const open = state.status === 'open';
      const coverable =
        state.status === 'claimed' &&
        state.owner !== this.index &&
        state.owner !== null &&
        card.priority <= coverMaxPriority &&
        now - entry.ts >= coverAfterMs &&
        now - (this.lastHeard.get(state.owner) ?? 0) >= coverAfterMs;
      if (!open && !coverable) continue;
      if (card.dependsOn.some((d) => cardOf(this.entries.get(`task/${d}`))?.status !== 'done')) {
        this.refuse(card.id, 'DEPENDENCY_UNMET');
        continue;
      }
      if ((card.reliesOn ?? []).some((key) => (this.entries.get(`obs/${key}`)?.v as Fact | undefined)?.observed === false)) {
        this.refuse(card.id, 'BLOCKED_BY_CONTINGENCY');
        continue;
      }
      const tokens = this.freeTokens(card);
      if (!tokens) {
        this.refuse(card.id, 'NO_RIGHT');
        continue;
      }
      this.claim(card, tokens, coverable);
      return true;
    }
    return false;
  }

  private freeTokens(card: TaskSpec): TokenId[] | null {
    const out: TokenId[] = [];
    for (const need of card.needs) {
      const spec = this.ctx.scenario.world.resources.find((r) => r.id === need.resource);
      const free = (spec?.tokens ?? [])
        .map((t) => t.id)
        .filter((id) => {
          const booking = bookingOf(this.entries.get(`res/${id}`));
          return !booking || booking.holder === FREE;
        });
      if (free.length < need.count) return null;
      out.push(...free.slice(0, need.count));
    }
    return out;
  }

  private claim(card: TaskSpec, tokens: TokenId[], cover: boolean): void {
    const now = this.ctx.sim.now;
    this.write(`task/${card.id}`, { card, status: 'claimed', owner: this.index });
    for (const token of tokens) {
      this.write(`res/${token}`, { holder: this.index, task: card.id });
      this.ctx.trace({ t: now, kind: 'commit', actor: this.index, task: card.id, token });
    }
    this.ctx.trace({ t: now, kind: 'assign', actor: this.index, task: card.id, via: cover ? 'cover' : 'plan' });
    this.worker.give(card.id, card.priority, this.ctx.durationOf(card.id));
  }

  private finish(task: TaskId): void {
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'complete', actor: this.index, task });
    this.finished.push(task);
    const state = cardOf(this.entries.get(`task/${task}`));
    if (state) this.write(`task/${task}`, { ...state, status: 'done', owner: this.index });
  }

  private refuse(task: TaskId, code: string): void {
    const key = `${task}:${code}`;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'refuse', actor: this.index, task, code });
  }
}
