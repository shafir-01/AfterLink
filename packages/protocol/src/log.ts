import { MAX_PARENTS, verifyEvent } from './envelope.ts';
import type { ActorId, AnyEvent, EventId, MissionId, SyncSummary } from './types.ts';

/**
 * How far an event's lamport may exceed its dependencies. Authors use +1. Anything an actor
 * could reach by emitting more events anyway is allowed, so the bound only has to keep the
 * clock far from the end of the safe integer range.
 */
export const MAX_LAMPORT_JUMP = 1024;
/** Events held per actor while their dependencies are missing. Anti-entropy resends the rest. */
export const MAX_WAITING_PER_ACTOR = 1024;

export type IngestStatus = 'added' | 'duplicate' | 'gap' | 'invalid' | 'fork';

export interface IngestResult {
  /** Every event newly placed in the log, including released gap events and fork branches, in causal order. */
  added: AnyEvent[];
  duplicates: number;
  /** Input events not placed yet because a dependency is missing. */
  gaps: number;
  invalid: AnyEvent[];
  /** Input events that proved a fork. A fork with missing dependencies appears here before it appears in `added`. */
  forks: AnyEvent[];
}

/** Two or more signed events from one actor at one sequence number. */
export interface ForkRecord {
  actor: ActorId;
  seq: number;
  events: AnyEvent[];
}

/** A SyncSummary that also names the extra branch tips of forked actors. Absent when there are no forks. */
export interface LogSummary extends SyncSummary {
  branches?: Record<ActorId, EventId[]>;
}

export interface EventLogOptions {
  /** Who may write to this mission. Anyone else's event is invalid: never stored, never forwarded. */
  admit?: (actor: ActorId) => boolean;
}

const dependencies = (e: AnyEvent): EventId[] => (e.prev ? [e.prev, ...e.parents] : e.parents);

const slotKey = (e: AnyEvent): string => `${e.seq}:${e.actor}`;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts by lamport first. Placement guarantees lamports rise along every dependency, so this is a topological order. */
const compareEvents = (a: AnyEvent, b: AnyEvent): number =>
  a.lamport - b.lamport || compareText(a.actor, b.actor) || a.seq - b.seq || compareText(a.id, b.id);

/** Every tip a summary names for one actor. Summaries come off the wire, so nothing here is trusted. */
function remoteTips(remote: SyncSummary, actor: ActorId): EventId[] {
  const extra = (remote as LogSummary).branches?.[actor];
  return [remote.heads?.[actor]?.id, ...(Array.isArray(extra) ? extra : [])].filter((id) => typeof id === 'string');
}

/**
 * One replica of a mission history. An event is placed once its `prev` and `parents` are
 * present, and only then judged against them, so the placed set depends only on which events
 * were received, never on delivery order. Forked branches are kept side by side.
 */
export class EventLog {
  readonly mission: MissionId;
  private readonly admit: (actor: ActorId) => boolean;
  private readonly events = new Map<EventId, AnyEvent>();
  private readonly order: AnyEvent[] = [];
  private ordered = true;
  private readonly tips = new Set<EventId>();
  private readonly actorTips = new Map<ActorId, Set<EventId>>();
  private readonly waiting = new Map<EventId, AnyEvent>();
  private readonly waitingBy = new Map<ActorId, number>();
  private readonly waiters = new Map<EventId, Set<EventId>>();
  private readonly slots = new Map<string, AnyEvent[]>();
  private readonly forkedSlots = new Set<string>();
  private clock = 0;

  constructor(mission: MissionId, options: EventLogOptions = {}) {
    this.mission = mission;
    this.admit = options.admit ?? (() => true);
  }

  get size(): number {
    return this.events.size;
  }

  /** Events held back until a missing dependency arrives. */
  get pending(): number {
    return this.waiting.size;
  }

  has(id: EventId): boolean {
    return this.events.has(id);
  }

  get(id: EventId): AnyEvent | undefined {
    return this.events.get(id);
  }

  /** To learn which events a delivery released, use `ingestMany`. */
  ingest(e: AnyEvent): IngestStatus {
    return this.receive(e, [], []);
  }

  ingestMany(es: AnyEvent[]): IngestResult {
    const result: IngestResult = { added: [], duplicates: 0, gaps: 0, invalid: [], forks: [] };
    const unplaced = new Set<EventId>();
    for (const e of es) {
      const status = this.receive(e, result.added, result.invalid);
      if (status === 'duplicate') result.duplicates++;
      else if (status === 'invalid') result.invalid.push(e);
      else if (status === 'fork') result.forks.push(e);
      if (status === 'gap' || status === 'fork') unplaced.add(e.id);
    }
    for (const e of result.added) unplaced.delete(e.id);
    for (const e of result.invalid) if (e) unplaced.delete(e.id);
    result.gaps = unplaced.size;
    return result;
  }

  /** Topological order. Ties break on (lamport, actor, seq), then id between fork branches. */
  all(): AnyEvent[] {
    if (!this.ordered) {
      this.order.sort(compareEvents);
      this.ordered = true;
    }
    return this.order.slice();
  }

  byActor(actor: ActorId): AnyEvent[] {
    return this.all().filter((e) => e.actor === actor);
  }

  /**
   * Events nothing else in the log depends on: the causal frontier, ready to use as `parents`.
   * Keeps the newest MAX_PARENTS, so a flood of fork tips cannot make honest events oversized.
   */
  heads(): EventId[] {
    const tips = [...this.tips].map((id) => this.events.get(id)!);
    return tips
      .sort((a, b) => compareEvents(b, a))
      .slice(0, MAX_PARENTS)
      .map((e) => e.id)
      .sort();
  }

  /** The actor's highest event. Between fork branches the lowest id wins, on every replica. */
  head(actor: ActorId): { seq: number; id: EventId } | undefined {
    const [top] = this.branchTips(actor);
    return top && { seq: top.seq, id: top.id };
  }

  /**
   * True when the remote names an event of this actor that this log has not placed. An actor
   * seeing this about itself has lost history, and signing now would fork its own chain.
   * Summaries are unsigned, so treat it as a reason to wait for the events, not as proof.
   */
  behind(actor: ActorId, remote: SyncSummary): boolean {
    return remoteTips(remote, actor).some((id) => !this.events.has(id));
  }

  lamport(): number {
    return this.clock;
  }

  forks(): ForkRecord[] {
    return [...this.forkedSlots]
      .map((key) => {
        const events = [...this.slots.get(key)!].sort((a, b) => compareText(a.id, b.id));
        return { actor: events[0]!.actor, seq: events[0]!.seq, events };
      })
      .sort((a, b) => compareText(a.actor, b.actor) || a.seq - b.seq);
  }

  summary(): LogSummary {
    const heads: SyncSummary['heads'] = {};
    const branches: Record<ActorId, EventId[]> = {};
    for (const actor of [...this.actorTips.keys()].sort()) {
      const [top, ...rest] = this.branchTips(actor);
      heads[actor] = { seq: top!.seq, id: top!.id };
      if (rest.length) branches[actor] = rest.map((e) => e.id);
    }
    const forked = this.lowestForks();
    const summary: LogSummary = { mission: this.mission, heads };
    if (Object.keys(branches).length) summary.branches = branches;
    if (Object.keys(forked).length) summary.forked = forked;
    return summary;
  }

  /**
   * Events the remote cannot be shown to hold, compared by id, in causal order. While no fork
   * is involved the result, and any prefix of it, applies with no gaps. An unknown remote head
   * with a higher seq means the remote is ahead, unless we hold a fork it has not reported.
   * An unknown head at or below our seq proves a fork. Either way the whole actor log is
   * offered, because the common ancestor cannot be seen from a summary and the receiver drops
   * what it already holds. A remote that looks ahead may in fact sit on an unreported fork, so
   * an event can arrive before a dependency there, and it waits until a holder is met. Fork
   * proofs that cannot be placed yet trail the delta, so an equivocation spreads even when
   * part of the branch is being withheld.
   */
  missingFor(remote: SyncSummary): AnyEvent[] {
    if (remote?.mission !== this.mission) return [];
    const held = new Set<EventId>();
    const ahead = new Set<ActorId>();
    const proven = remote.forked ?? {};
    const forked = this.lowestForks();
    for (const [actor, head] of Object.entries(remote.heads ?? {})) {
      const known = remoteTips(remote, actor).filter((id) => this.events.has(id));
      const higher = head?.seq > (this.head(actor)?.seq ?? 0);
      if (known.length === 0 && higher && (forked[actor] === undefined || proven[actor] !== undefined)) {
        ahead.add(actor);
      }
      for (const tip of known) {
        let id: EventId | null = tip;
        while (id && !held.has(id)) {
          held.add(id);
          id = this.events.get(id)!.prev;
        }
      }
    }
    const placed = this.all().filter((e) => !held.has(e.id) && !ahead.has(e.actor));
    const proofs = this.forks()
      .flatMap((fork) => fork.events)
      .filter((e) => this.waiting.has(e.id) && !(proven[e.actor]! <= e.seq));
    return [...placed, ...proofs];
  }

  private receive(e: AnyEvent, added: AnyEvent[], invalid: AnyEvent[]): IngestStatus {
    if (e?.mission !== this.mission || !this.admit(e.actor) || !verifyEvent(e).ok) return 'invalid';
    if (this.events.has(e.id)) return 'duplicate';
    if (this.waiting.has(e.id)) return 'gap';
    const missing = dependencies(e).filter((id) => !this.events.has(id));
    if (missing.length === 0) {
      if (!this.fits(e)) return 'invalid';
      const forked = this.takeSlot(e);
      this.place(e, added, invalid);
      return forked ? 'fork' : 'added';
    }
    const held = this.waitingBy.get(e.actor) ?? 0;
    if (held >= MAX_WAITING_PER_ACTOR) return 'gap';
    this.waitingBy.set(e.actor, held + 1);
    this.waiting.set(e.id, e);
    for (const id of missing) {
      const blocked = this.waiters.get(id) ?? new Set<EventId>();
      this.waiters.set(id, blocked.add(e.id));
    }
    return this.takeSlot(e) ? 'fork' : 'gap';
  }

  /**
   * Needs every dependency placed. `prev` must be this actor's previous seq, and lamport must
   * rise past all dependencies, so a clock cannot backdate an event or run away with the mission.
   */
  private fits(e: AnyEvent): boolean {
    const deps = dependencies(e).map((id) => this.events.get(id)!);
    const prev = deps[0];
    if (e.prev && (prev!.actor !== e.actor || prev!.seq !== e.seq - 1)) return false;
    if (deps.length === 0) return e.lamport <= MAX_LAMPORT_JUMP;
    const floor = Math.max(...deps.map((dep) => dep.lamport));
    return e.lamport > floor && e.lamport <= floor + MAX_LAMPORT_JUMP;
  }

  private takeSlot(e: AnyEvent): boolean {
    const key = slotKey(e);
    const slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, [e]);
      return false;
    }
    slot.push(e);
    this.forkedSlots.add(key);
    return true;
  }

  private leaveSlot(e: AnyEvent): void {
    const key = slotKey(e);
    const slot = this.slots.get(key)!.filter((other) => other.id !== e.id);
    if (slot.length) this.slots.set(key, slot);
    else this.slots.delete(key);
    if (slot.length < 2) this.forkedSlots.delete(key);
  }

  private release(e: AnyEvent): void {
    this.waiting.delete(e.id);
    this.waitingBy.set(e.actor, this.waitingBy.get(e.actor)! - 1);
  }

  private place(first: AnyEvent, added: AnyEvent[], invalid: AnyEvent[]): void {
    const ready = [first];
    while (ready.length) {
      const e = ready.pop()!;
      this.commit(e);
      added.push(e);
      const blocked = this.waiters.get(e.id);
      if (!blocked) continue;
      this.waiters.delete(e.id);
      for (const id of blocked) {
        const next = this.waiting.get(id);
        if (!next || !dependencies(next).every((dep) => this.events.has(dep))) continue;
        this.release(next);
        if (this.fits(next)) {
          ready.push(next);
        } else {
          this.leaveSlot(next);
          invalid.push(next);
        }
      }
    }
  }

  private commit(e: AnyEvent): void {
    for (const dep of dependencies(e)) this.tips.delete(dep);
    this.clock = Math.max(this.clock, e.lamport);
    this.events.set(e.id, e);
    this.order.push(e);
    this.ordered = false;
    this.tips.add(e.id);
    const own = this.actorTips.get(e.actor) ?? new Set<EventId>();
    if (e.prev) own.delete(e.prev);
    this.actorTips.set(e.actor, own.add(e.id));
  }

  private branchTips(actor: ActorId): AnyEvent[] {
    return [...(this.actorTips.get(actor) ?? [])]
      .map((id) => this.events.get(id)!)
      .sort((a, b) => b.seq - a.seq || compareText(a.id, b.id));
  }

  private lowestForks(): Record<ActorId, number> {
    const lowest: Record<ActorId, number> = {};
    for (const fork of this.forks()) lowest[fork.actor] ??= fork.seq;
    return lowest;
  }
}
