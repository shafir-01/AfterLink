import type { ActorId, AnyEvent, EventId, LinkInfo, LogSummary, SyncSummary, TaskId, WireMessage } from '@afterlink/protocol';
import { every } from './clock.ts';
import { FRAME_PAYLOAD_BYTES } from './frames.ts';
import type { Mesh } from './mesh.ts';

/** The part of EventLog that anti-entropy depends on. */
export interface SyncLog {
  summary(): SyncSummary;
  missingFor(remote: SyncSummary): AnyEvent[];
  has(id: EventId): boolean;
  ingestMany(events: AnyEvent[]): {
    added: AnyEvent[];
    duplicates: number;
    gaps: number;
    invalid: AnyEvent[];
    forks: AnyEvent[];
  };
  all(): AnyEvent[];
}

export interface SyncOptions {
  /** Period of the background exchange that repairs anything lost. */
  intervalMs?: number;
  /** Batch bounds. The default byte bound keeps a batch inside one frame. An oversized event still travels alone. */
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  /** A batch unanswered for this long may be sent again. */
  ackTimeoutMs?: number;
  /** Delay that coalesces telling peers about newly learned events. */
  gossipMs?: number;
  /** Shortest gap between summaries sent only to ask a peer for what it has and we lack. */
  askGapMs?: number;
  /** Events a peer sent that failed verification, or that prove an actor signed two successors. */
  onSuspect?: (suspect: { invalid: AnyEvent[]; forks: AnyEvent[] }, from: ActorId) => void;
}

export interface SyncStats {
  summariesSent: number;
  batchesSent: number;
  eventsSent: number;
  eventsAdded: number;
  duplicatesReceived: number;
  forksReceived: number;
  batchesRefused: number;
}

export interface SyncHandle {
  /** Call after local events: pushes them to peers without waiting for the next exchange. */
  nudge(): void;
  stop(): void;
  stats(): SyncStats;
}

interface PeerSync {
  /** Highest heads and every branch tip this peer has told us about since the link opened. */
  known: LogSummary | null;
  /** When the unanswered batch to this peer was sent. One batch per peer is in flight at a time. */
  batchAt: number | null;
  /** When we last sent this peer a summary. */
  summaryAt: number;
  /**
   * Events sent in this pass that the peer has not yet shown it holds. A delta can start with events
   * the peer has but cannot be proved to have, as after a fork, so each batch must move past the last.
   */
  offered: Set<EventId>;
  /** No new pass starts before this time. */
  holdUntil: number;
  /** Wait before the next pass, doubled while the peer shows nothing new. */
  passWaitMs: number;
}

const TASK_PRIORITY_DEFAULT = 2;
/** A peer sending more than this in one message is not following the protocol. */
const MAX_INBOUND_EVENTS = 512;
/** Longest wait between passes offering a peer events it never shows. */
const MAX_PASS_WAIT_MS = 60_000;

const tipsOf = (s: LogSummary, actor: ActorId): EventId[] => {
  const head = s.heads[actor];
  return head ? [head.id, ...(s.branches?.[actor] ?? [])] : [];
};

/** Keeps only well formed entries, so a hostile summary can cost extra events but nothing else. */
function parseSummary(raw: unknown, mission: string): LogSummary | null {
  const s = raw as Partial<LogSummary> | null;
  if (s?.mission !== mission || typeof s.heads !== 'object' || s.heads === null) return null;
  const clean: LogSummary = { mission, heads: {} };
  for (const [actor, head] of Object.entries(s.heads)) {
    if (!Number.isSafeInteger(head?.seq) || typeof head?.id !== 'string') continue;
    clean.heads[actor] = { seq: head.seq, id: head.id };
    const extra = s.branches?.[actor];
    if (Array.isArray(extra)) {
      (clean.branches ??= {})[actor] = extra.filter((id): id is EventId => typeof id === 'string');
    }
  }
  return clean;
}

/** Lower sends sooner. Rights and urgent tasks outrank observations; link chatter goes last. */
export function eventRank(e: AnyEvent, taskPriority: (id: TaskId) => number): number {
  switch (e.type) {
    case 'mission.issued':
    case 'actor.joined':
      return 0;
    case 'right.committed':
    case 'right.offered':
    case 'right.accepted':
    case 'right.declined':
    case 'conflict.resolved':
      return 1;
    case 'task.created':
      return 1 + e.body.spec.priority;
    case 'task.claimed':
    case 'task.accepted':
    case 'task.completed':
    case 'task.deferred':
    case 'task.refused':
    case 'task.released':
    case 'task.covered':
      return 1 + taskPriority(e.body.taskId);
    case 'observation.recorded':
      return 5;
    default:
      return 6;
  }
}

/**
 * Orders a delta so urgent events go first, each preceded by whatever it causally needs.
 * An event sent ahead of its predecessors could only wait in the receiver's gap buffer.
 */
export function prioritise(delta: AnyEvent[], rank: (e: AnyEvent) => number): AnyEvent[] {
  const byId = new Map<EventId, AnyEvent>(delta.map((e) => [e.id, e]));
  const targets = delta
    .map((e, order) => ({ e, order, rank: rank(e) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
  const visited = new Set<EventId>();
  const out: AnyEvent[] = [];
  for (const { e: target } of targets) {
    if (visited.has(target.id)) continue;
    visited.add(target.id);
    const stack: { e: AnyEvent; expanded: boolean }[] = [{ e: target, expanded: false }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.expanded) {
        stack.pop();
        out.push(top.e);
        continue;
      }
      top.expanded = true;
      const needs = top.e.prev ? [top.e.prev, ...top.e.parents] : top.e.parents;
      for (const id of needs) {
        const dep = byId.get(id);
        if (dep && !visited.has(id)) {
          visited.add(id);
          stack.push({ e: dep, expanded: false });
        }
      }
    }
  }
  return out;
}

/** Anti-entropy over the mesh. Self-clocked: a peer's summary acknowledges a batch and asks for the next. */
export function attachSync(
  mesh: Mesh,
  log: SyncLog,
  onNew: (events: AnyEvent[], from: ActorId) => void,
  o: SyncOptions = {},
): SyncHandle {
  const { clock } = mesh;
  const intervalMs = o.intervalMs ?? 3000;
  const maxBatchEvents = o.maxBatchEvents ?? 64;
  const maxBatchBytes = o.maxBatchBytes ?? FRAME_PAYLOAD_BYTES;
  const ackTimeoutMs = o.ackTimeoutMs ?? 1500;
  const gossipMs = o.gossipMs ?? 50;
  const askGapMs = o.askGapMs ?? 250;
  const peers = new Map<ActorId, PeerSync>();
  const taskPriorities = new Map<TaskId, number>();
  const { mission } = log.summary();
  const stats: SyncStats = {
    summariesSent: 0,
    batchesSent: 0,
    eventsSent: 0,
    eventsAdded: 0,
    duplicatesReceived: 0,
    forksReceived: 0,
    batchesRefused: 0,
  };
  let flushTimer: unknown = null;
  let gossipTimer: unknown = null;
  let lastAddedAt = -Infinity;

  const noteTasks = (events: AnyEvent[]) => {
    for (const e of events) {
      if (e.type === 'task.created') taskPriorities.set(e.body.spec.id, e.body.spec.priority);
    }
  };
  const rank = (e: AnyEvent) => eventRank(e, (id) => taskPriorities.get(id) ?? TASK_PRIORITY_DEFAULT);

  const sendSummary = (peer: ActorId) => {
    const state = peers.get(peer);
    if (state && mesh.send(peer, { t: 'summary', summary: log.summary() })) {
      state.summaryAt = clock.now();
      stats.summariesSent++;
    }
  };

  const push = (peer: ActorId, state: PeerSync) => {
    if (!state.known) return;
    const now = clock.now();
    if (now < state.holdUntil) return;
    if (state.batchAt !== null && now - state.batchAt < ackTimeoutMs) return;
    const delta = log.missingFor(state.known);
    // An unanswered batch may have been lost, so the pass restarts from what the peer has shown.
    if (state.batchAt !== null) state.offered.clear();
    state.batchAt = null;
    if (delta.length === 0) {
      state.offered.clear();
      return;
    }
    const fresh = delta.filter((e) => !state.offered.has(e.id));
    if (fresh.length === 0) {
      state.offered.clear();
      state.holdUntil = now + state.passWaitMs;
      state.passWaitMs = Math.min(state.passWaitMs * 2, MAX_PASS_WAIT_MS);
      return;
    }
    noteTasks(fresh);
    const ordered = prioritise(fresh, rank);
    const batch: AnyEvent[] = [];
    let bytes = 0;
    for (const e of ordered) {
      bytes += JSON.stringify(e).length;
      if (batch.length > 0 && (batch.length >= maxBatchEvents || bytes > maxBatchBytes)) break;
      batch.push(e);
    }
    if (mesh.send(peer, { t: 'events', events: batch, final: batch.length === ordered.length })) {
      state.batchAt = now;
      for (const e of batch) state.offered.add(e.id);
      stats.batchesSent++;
      stats.eventsSent += batch.length;
    }
  };

  /**
   * Records what the peer holds and reports whether that is news. Tips are compared by event id:
   * two branches at one sequence number are different histories, not the same position.
   */
  const learn = (state: PeerSync, remote: LogSummary): boolean => {
    const first = !state.known;
    const known = (state.known ??= { mission, heads: {} });
    const branches = (known.branches ??= {});
    let news = first;
    for (const [actor, head] of Object.entries(remote.heads)) {
      const current = known.heads[actor];
      if (current && head.seq < current.seq) continue;
      const held = new Set(tipsOf(known, actor));
      if (tipsOf(remote, actor).some((tip) => !held.has(tip))) news = true;
      known.heads[actor] = head;
      const tips = remote.branches?.[actor];
      if (tips) branches[actor] = tips;
      else delete branches[actor];
    }
    return news;
  };

  /** True when the peer names an event we do not hold, whatever its sequence number. */
  const holdsWhatWeLack = (remote: LogSummary): boolean =>
    Object.keys(remote.heads).some((actor) => tipsOf(remote, actor).some((tip) => !log.has(tip)));

  const onSummary = (peer: ActorId, state: PeerSync, raw: unknown) => {
    const remote = parseSummary(raw, mission);
    if (!remote) return;
    if (learn(state, remote)) {
      state.holdUntil = 0;
      state.passWaitMs = ackTimeoutMs;
    }
    state.batchAt = null;
    push(peer, state);
    if (holdsWhatWeLack(remote) && clock.now() - state.summaryAt >= askGapMs) sendSummary(peer);
  };

  const onEvents = (peer: ActorId, events: AnyEvent[], final: boolean) => {
    if (!Array.isArray(events)) return;
    if (events.length > MAX_INBOUND_EVENTS) {
      stats.batchesRefused++;
      return;
    }
    const result = log.ingestMany(events);
    stats.duplicatesReceived += result.duplicates;
    stats.forksReceived += result.forks.length;
    if (result.invalid.length > 0 || result.forks.length > 0) {
      o.onSuspect?.({ invalid: result.invalid, forks: result.forks }, peer);
    }
    if (result.added.length > 0) {
      stats.eventsAdded += result.added.length;
      noteTasks(result.added);
      onNew(result.added, peer);
      scheduleGossip(peer);
    }
    // Pure duplicates earn no answer while another peer is delivering: this sender pauses and the
    // one making progress carries on, so a reconnect does not become parallel floods. With nobody
    // delivering, the answer lets a sender walk past events we hold towards what we lack.
    const now = clock.now();
    if (result.added.length > 0) lastAddedAt = now;
    const useful = result.added.length > 0 || result.gaps > 0;
    if (useful || (!final && now - lastAddedAt >= askGapMs)) sendSummary(peer);
  };

  const scheduleGossip = (except: ActorId) => {
    if (gossipTimer !== null) return;
    gossipTimer = clock.setTimeout(() => {
      gossipTimer = null;
      for (const peer of peers.keys()) {
        if (peer !== except) sendSummary(peer);
      }
    }, gossipMs);
  };

  const flush = () => {
    flushTimer = null;
    for (const [peer, state] of peers) {
      if (state.known) push(peer, state);
      else sendSummary(peer);
    }
  };

  const linkOpened = (peer: ActorId) => {
    peers.set(peer, {
      known: null,
      batchAt: null,
      summaryAt: -Infinity,
      offered: new Set(),
      holdUntil: 0,
      passWaitMs: ackTimeoutMs,
    });
    sendSummary(peer);
  };

  const offMessage = mesh.onMessage((peer: ActorId, msg: WireMessage) => {
    const state = peers.get(peer);
    if (!state) return;
    if (msg.t === 'summary') onSummary(peer, state, msg.summary);
    else if (msg.t === 'events') onEvents(peer, msg.events, msg.final);
  });

  const offLink = mesh.onLinkChange((info: LinkInfo) => {
    if (info.state === 'open') linkOpened(info.peer);
    else peers.delete(info.peer);
  });

  const stopTick = every(clock, intervalMs, () => {
    for (const [peer, state] of peers) {
      sendSummary(peer);
      push(peer, state);
    }
  });

  noteTasks(log.all());
  for (const info of mesh.links()) {
    if (info.state === 'open') linkOpened(info.peer);
  }

  return {
    nudge() {
      if (flushTimer === null) flushTimer = clock.setTimeout(flush, 0);
    },
    stop() {
      offMessage();
      offLink();
      stopTick();
      clock.clearTimeout(flushTimer);
      clock.clearTimeout(gossipTimer);
      peers.clear();
    },
    stats: () => ({ ...stats }),
  };
}
