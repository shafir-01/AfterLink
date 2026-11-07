import { deriveTokens } from '@afterlink/authority';
import { canonicalize, sha256 } from '@afterlink/protocol';
import type {
  ActorId,
  ActorRecord,
  AnyEvent,
  ConflictRecord,
  DecisionRecord,
  EventEnvelope,
  EventId,
  MissionCapsule,
  MissionState,
  Observation,
  ProvisionBundle,
  TaskId,
  TaskRecord,
  TaskSource,
  TaskSpec,
  TaskStatus,
  TeamId,
  TokenRecord,
} from '@afterlink/protocol';
import { custodiansOf, rosterIsGenuine, validateCapsule, validateTaskSpec } from './capsule.ts';

type Roster = ProvisionBundle['roster'];
type Clock = Map<ActorId, number>;

/** One event's position in history, enough to ask whether another actor had seen it. */
interface Mark {
  actor: ActorId;
  seq: number;
  event: EventId;
}

interface Seat extends Mark {
  accepted: boolean;
}

interface Completion extends Mark {
  evidence: string;
}

interface Work {
  record: TaskRecord;
  claims: Map<ActorId, Seat>;
  covers: Map<ActorId, Seat>;
  completions: Map<ActorId, Completion>;
  contested: Set<EventId>;
  idle: Extract<TaskStatus, 'open' | 'deferred' | 'refused'>;
}

/** Lower rank wins a concurrent claim. Identical on every replica. */
export function claimRank(taskId: TaskId, actor: ActorId): string {
  return sha256(taskId + actor);
}

/** The work is done, even if the record of it is in conflict. */
export function isTaskDone(task: Pick<TaskRecord, 'status' | 'evidence'>): boolean {
  return task.status === 'completed' || (task.status === 'conflicted' && task.evidence !== undefined);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deterministic topological order: an event always follows its causes, whatever clock it claims. */
function causalOrder(events: AnyEvent[]): AnyEvent[] {
  const byId = new Map<EventId, AnyEvent>();
  for (const e of events) byId.set(e.id, e);
  const sorted = [...byId.values()].sort(
    (a, b) => a.lamport - b.lamport || compareText(a.actor, b.actor) || a.seq - b.seq || compareText(a.id, b.id),
  );
  const placed = new Set<EventId>();
  const ordered: AnyEvent[] = [];
  for (const root of sorted) {
    const stack = [root];
    while (stack.length > 0) {
      const e = stack[stack.length - 1]!;
      if (placed.has(e.id)) {
        stack.pop();
        continue;
      }
      const causes = (e.prev ? [e.prev, ...e.parents] : e.parents).filter((id) => byId.has(id) && !placed.has(id));
      if (causes.length > 0) {
        for (const id of causes) stack.push(byId.get(id)!);
        continue;
      }
      placed.add(e.id);
      ordered.push(e);
      stack.pop();
    }
  }
  return ordered;
}

/** Per-event version vectors, so "had this actor seen that event?" is a lookup. */
function buildClocks(ordered: AnyEvent[]): Map<EventId, Clock> {
  const clocks = new Map<EventId, Clock>();
  for (const e of ordered) {
    const clock: Clock = new Map();
    for (const source of [e.prev, ...e.parents]) {
      if (source === null) continue;
      for (const [actor, seq] of clocks.get(source) ?? []) {
        if (seq > (clock.get(actor) ?? 0)) clock.set(actor, seq);
      }
    }
    clock.set(e.actor, Math.max(clock.get(e.actor) ?? 0, e.seq));
    clocks.set(e.id, clock);
  }
  return clocks;
}

const genesisChecks = new WeakMap<Roster, Map<EventId, boolean>>();

/** A genesis counts only if the roster's credentials chain to its issuer. Signature checks run once per roster. */
function isGenesis(e: EventEnvelope<'mission.issued'>, roster: Roster): boolean {
  const memo = genesisChecks.get(roster) ?? new Map<EventId, boolean>();
  genesisChecks.set(roster, memo);
  const cached = memo.get(e.id);
  if (cached !== undefined) return cached;
  const capsule = e.body?.capsule;
  const checked = validateCapsule(capsule);
  const ok = checked.ok && capsule.issuer === e.actor && capsule.id === e.mission && rosterIsGenuine(roster, capsule);
  memo.set(e.id, ok);
  return ok;
}

function seedActors(roster: Roster): Record<ActorId, ActorRecord> {
  const actors: Record<ActorId, ActorRecord> = {};
  for (const r of roster) actors[r.actor] = { id: r.actor, team: r.team, name: r.name, lastSeq: 0, lastSeenWall: 0 };
  return actors;
}

function newWork(spec: TaskSpec, source: TaskSource, createdBy: ActorId, at: number): Work {
  return {
    record: { spec, status: 'open', source, decisions: [], createdBy, updatedAt: at },
    claims: new Map(),
    covers: new Map(),
    completions: new Map(),
    contested: new Set(),
    idle: 'open',
  };
}

function ownerOf(work: Work): ActorId | undefined {
  const id = work.record.spec.id;
  let best: ActorId | undefined;
  for (const actor of work.claims.keys()) {
    if (best === undefined || compareText(claimRank(id, actor), claimRank(id, best)) < 0) best = actor;
  }
  return best;
}

/** With no live claim left, the lowest-ranked live cover carries the task. */
function promoteCover(work: Work): void {
  if (work.claims.size > 0 || work.covers.size === 0) return;
  const id = work.record.spec.id;
  const [actor, seat] = [...work.covers].sort((a, b) => compareText(claimRank(id, a[0]), claimRank(id, b[0])))[0]!;
  work.covers.delete(actor);
  work.claims.set(actor, seat);
}

function settle(work: Work): void {
  const owner = ownerOf(work);
  const record = work.record;
  if (owner === undefined) delete record.owner;
  else record.owner = owner;
  if (work.covers.size > 0) record.coveredBy = [...work.covers.keys()];
  else delete record.coveredBy;

  const primary = (owner !== undefined ? work.completions.get(owner) : undefined) ?? [...work.completions.values()][0];
  if (primary) record.evidence = primary.evidence;
  else delete record.evidence;

  const working = [...work.claims.values(), ...work.covers.values()];
  if (work.completions.size > 0) record.status = 'completed';
  else if (working.some((s) => s.accepted)) record.status = 'accepted';
  else if (working.length > 0) record.status = 'claimed';
  else record.status = work.idle;
}

class Fold {
  readonly tasks = new Map<TaskId, Work>();
  readonly refs = new Set<string>();
  readonly observations = new Map<string, Observation[]>();
  readonly rejected = new Map<string, ConflictRecord>();
  readonly resolutions = new Map<string, { resolution: string; keep: EventId[] }>();
  readonly actorTeam: Map<ActorId, TeamId>;
  readonly names: Map<ActorId, string>;
  readonly capabilities: Map<TeamId, Set<string>>;
  readonly committed = new Map<string, Map<string, number>>();

  constructor(
    readonly capsule: MissionCapsule,
    roster: Roster,
    readonly clocks: Map<EventId, Clock>,
    tokens: Record<string, TokenRecord>,
    admitted: AnyEvent[],
  ) {
    this.actorTeam = new Map(roster.map((r) => [r.actor, r.team]));
    this.names = new Map(roster.map((r) => [r.actor, r.name]));
    this.capabilities = new Map(capsule.teams.map((t) => [t.id, new Set(t.capabilities)]));
    for (const spec of capsule.tasks) {
      this.tasks.set(spec.id, newWork(spec, { kind: 'capsule' }, capsule.issuer, capsule.issuedAt));
    }
    for (const e of admitted) {
      if (e.type !== 'right.committed' || !Array.isArray(e.body.tokens)) continue;
      for (const tokenId of e.body.tokens) {
        const token = tokens[tokenId];
        if (token?.committedTo === undefined || token.committedTo !== e.body.taskId) continue;
        const key = `${e.actor}|${e.body.taskId}`;
        const held = this.committed.get(key) ?? new Map<string, number>();
        held.set(token.resource, (held.get(token.resource) ?? 0) + 1);
        this.committed.set(key, held);
      }
    }
  }

  private name(actor: ActorId): string {
    return this.names.get(actor) ?? 'An unknown device';
  }

  private saw(e: AnyEvent, mark: Mark): boolean {
    return (this.clocks.get(e.id)?.get(mark.actor) ?? 0) >= mark.seq;
  }

  private mark(e: AnyEvent): Mark {
    return { actor: e.actor, seq: e.seq, event: e.id };
  }

  private refuse(kind: 'unauthorised-action' | 'forged-event', e: AnyEvent, taskId: TaskId | undefined, summary: string): void {
    const id = `${kind}:${e.id}`;
    this.rejected.set(id, { id, severity: 'violation', kind, ...(typeof taskId === 'string' ? { taskId } : {}), events: [e.id], summary, resolved: false });
  }

  private stale(e: AnyEvent, taskId: TaskId, summary: string): void {
    const id = `stale-decision:${e.id}`;
    this.rejected.set(id, {
      id,
      severity: 'policy',
      kind: 'stale-decision',
      taskId,
      events: [e.id],
      summary,
      resolved: true,
      resolution: 'Kept in the record. It did not change the task.',
    });
  }

  private canDo(actor: ActorId, spec: TaskSpec): boolean {
    const team = this.actorTeam.get(actor);
    const caps = team === undefined ? undefined : this.capabilities.get(team);
    return caps !== undefined && spec.requires.every((c) => caps.has(c));
  }

  private holdsNeeds(actor: ActorId, spec: TaskSpec): boolean {
    const held = this.committed.get(`${actor}|${spec.id}`);
    return spec.needs.every((n) => (held?.get(n.resource) ?? 0) >= n.count);
  }

  private needsHuman(spec: TaskSpec, via: string): boolean {
    return via === 'auto' && this.capsule.fallback.humanApprovalKinds.includes(spec.kind);
  }

  private touch(work: Work, e: AnyEvent): void {
    work.record.updatedAt = Math.max(work.record.updatedAt, e.wall);
    settle(work);
  }

  /** Task for this event, or a rejection when the event names a task nobody created. */
  private work(e: AnyEvent, taskId: TaskId): Work | null {
    const work = this.tasks.get(taskId);
    if (!work) this.refuse('unauthorised-action', e, taskId, `${this.name(e.actor)} acted on a task that does not exist.`);
    return work ?? null;
  }

  private decisionIsOwn(e: AnyEvent, taskId: TaskId, decision: DecisionRecord): boolean {
    if (decision?.actor === e.actor && decision.taskId === taskId && typeof decision.reason === 'string' && Array.isArray(decision.inputs)) return true;
    this.refuse('forged-event', e, taskId, `${this.name(e.actor)} sent a decision that is not its own or cannot be read.`);
    return false;
  }

  apply(e: AnyEvent): void {
    switch (e.type) {
      case 'task.created':
        this.created(e);
        break;
      case 'task.claimed':
        this.claimed(e);
        break;
      case 'task.covered':
        this.covered(e);
        break;
      case 'task.accepted':
        this.accepted(e);
        break;
      case 'task.completed':
        this.completed(e);
        break;
      case 'task.released':
        this.released(e);
        break;
      case 'task.deferred':
      case 'task.refused':
        this.declined(e);
        break;
      case 'observation.recorded':
        this.observed(e);
        break;
      case 'conflict.resolved':
        if (typeof e.body.resolution === 'string' && Array.isArray(e.body.keep)) {
          this.resolutions.set(e.body.conflictId, { resolution: e.body.resolution, keep: e.body.keep });
        }
        break;
      default:
        break;
    }
  }

  private created(e: EventEnvelope<'task.created'>): void {
    const { spec, source } = e.body;
    const problems = validateTaskSpec(spec);
    if (typeof source?.kind !== 'string') problems.push('task source: missing');
    if (problems.length > 0) {
      this.refuse('unauthorised-action', e, undefined, `${this.name(e.actor)} sent a task that cannot be read: ${problems[0]}.`);
      return;
    }
    const existing = this.tasks.get(spec.id);
    if (existing) {
      if (!sameValue(existing.record.spec, spec)) {
        this.refuse('unauthorised-action', e, spec.id, `${this.name(e.actor)} reused the id of a different task.`);
      }
      return;
    }
    if (source.ref !== undefined && source.kind !== 'contingency') {
      const key = `${source.kind}:${source.ref}`;
      if (this.refs.has(key)) return;
      this.refs.add(key);
    }
    this.tasks.set(spec.id, newWork(spec, source, e.actor, e.wall));
  }

  /** Whether this claim or cover may take a seat, recording why not when it may not. */
  private mayTake(e: AnyEvent, work: Work): boolean {
    const { spec } = work.record;
    if (!this.canDo(e.actor, spec)) {
      this.refuse('unauthorised-action', e, spec.id, `${this.name(e.actor)} does not have the skills for "${spec.title}".`);
      return false;
    }
    if ([...work.completions.values()].some((c) => this.saw(e, c))) {
      this.refuse('unauthorised-action', e, spec.id, `${this.name(e.actor)} took "${spec.title}" after seeing it finished.`);
      return false;
    }
    return true;
  }

  private claimed(e: EventEnvelope<'task.claimed'>): void {
    const { taskId, decision } = e.body;
    const work = this.work(e, taskId);
    if (!work || !this.decisionIsOwn(e, taskId, decision)) return;
    if (work.claims.has(e.actor) || !this.mayTake(e, work)) return;
    const { spec } = work.record;
    const rivals = [...work.claims.values()];
    if (rivals.some((seat) => this.saw(e, seat))) {
      this.refuse('unauthorised-action', e, taskId, `${this.name(e.actor)} claimed "${spec.title}" knowing it was already taken.`);
      return;
    }
    if (rivals.length > 0) {
      work.contested.add(e.id);
      for (const seat of rivals) work.contested.add(seat.event);
    }
    work.covers.delete(e.actor);
    work.claims.set(e.actor, { ...this.mark(e), accepted: false });
    work.record.decisions.push(decision);
    this.touch(work, e);
  }

  private covered(e: EventEnvelope<'task.covered'>): void {
    const { taskId, decision } = e.body;
    const work = this.work(e, taskId);
    if (!work || !this.decisionIsOwn(e, taskId, decision)) return;
    if (work.claims.has(e.actor) || work.covers.has(e.actor) || !this.mayTake(e, work)) return;
    const { spec } = work.record;
    if (spec.priority > this.capsule.fallback.coverMaxPriority) {
      this.refuse('unauthorised-action', e, taskId, `"${spec.title}" is not urgent enough for ${this.name(e.actor)} to cover without a human.`);
      return;
    }
    const seat: Seat = { ...this.mark(e), accepted: false };
    if (work.claims.size === 0) work.claims.set(e.actor, seat);
    else work.covers.set(e.actor, seat);
    work.record.decisions.push(decision);
    this.touch(work, e);
  }

  /** The seat this actor may still act from, or null with the reason recorded. */
  private seatFor(e: AnyEvent, work: Work, verb: string): Seat | null {
    const { spec } = work.record;
    const seat = work.claims.get(e.actor) ?? work.covers.get(e.actor);
    if (!seat) {
      this.refuse('unauthorised-action', e, spec.id, `${this.name(e.actor)} ${verb} "${spec.title}" without holding it.`);
      return null;
    }
    const owner = ownerOf(work);
    const winner = owner === undefined ? undefined : work.claims.get(owner);
    if (work.claims.has(e.actor) && winner && owner !== e.actor && this.saw(e, winner)) {
      this.stale(e, spec.id, `${this.name(e.actor)} ${verb} "${spec.title}" after losing the claim to ${this.name(winner.actor)}.`);
      return null;
    }
    return seat;
  }

  /** Starting work is where authority bites: the rights must be committed and any human step taken. */
  private mayWork(e: EventEnvelope<'task.accepted'> | EventEnvelope<'task.completed'>, work: Work): boolean {
    const { spec } = work.record;
    if (this.needsHuman(spec, e.body.via)) {
      this.refuse('unauthorised-action', e, spec.id, `"${spec.title}" needs a person, not an automatic step.`);
      return false;
    }
    if (!this.holdsNeeds(e.actor, spec)) {
      this.refuse('unauthorised-action', e, spec.id, `${this.name(e.actor)} started "${spec.title}" without committing what it needs.`);
      return false;
    }
    return true;
  }

  private accepted(e: EventEnvelope<'task.accepted'>): void {
    const work = this.work(e, e.body.taskId);
    if (!work) return;
    const seat = this.seatFor(e, work, 'accepted');
    if (!seat || !this.mayWork(e, work)) return;
    seat.accepted = true;
    this.touch(work, e);
  }

  private completed(e: EventEnvelope<'task.completed'>): void {
    const work = this.work(e, e.body.taskId);
    if (!work) return;
    if (work.completions.has(e.actor)) return;
    if (typeof e.body.evidence !== 'string') {
      this.refuse('unauthorised-action', e, work.record.spec.id, `${this.name(e.actor)} finished "${work.record.spec.title}" with no readable evidence.`);
      return;
    }
    if (!this.seatFor(e, work, 'completed') || !this.mayWork(e, work)) return;
    work.completions.set(e.actor, { ...this.mark(e), evidence: e.body.evidence });
    this.touch(work, e);
  }

  private released(e: EventEnvelope<'task.released'>): void {
    const work = this.work(e, e.body.taskId);
    if (!work) return;
    if (!work.claims.has(e.actor) && !work.covers.has(e.actor)) {
      this.refuse('unauthorised-action', e, work.record.spec.id, `${this.name(e.actor)} released "${work.record.spec.title}" without holding it.`);
      return;
    }
    work.record.decisions.push({
      id: e.id,
      actor: e.actor,
      taskId: e.body.taskId,
      outcome: 'UNKNOWN',
      reason: typeof e.body.reason === 'string' ? e.body.reason : '',
      policy: 'task.released',
      reachable: [],
      horizon: {},
      inputs: [],
    });
    work.claims.delete(e.actor);
    work.covers.delete(e.actor);
    promoteCover(work);
    this.touch(work, e);
  }

  private declined(e: EventEnvelope<'task.deferred'> | EventEnvelope<'task.refused'>): void {
    const { taskId, decision } = e.body;
    const work = this.work(e, taskId);
    if (!work || !this.decisionIsOwn(e, taskId, decision)) return;
    work.record.decisions.push(decision);
    work.idle = e.type === 'task.refused' ? 'refused' : 'deferred';
    this.touch(work, e);
  }

  private observed(e: EventEnvelope<'observation.recorded'>): void {
    const { observation } = e.body;
    if (observation?.source !== e.actor) {
      this.refuse('forged-event', e, undefined, `${this.name(e.actor)} signed an observation in someone else's name.`);
      return;
    }
    if (typeof observation.key !== 'string' || !Number.isFinite(observation.observedAt) || !Number.isFinite(observation.validForMs)) {
      this.refuse('unauthorised-action', e, undefined, `${this.name(e.actor)} sent an observation that cannot be read.`);
      return;
    }
    const held = this.observations.get(observation.key);
    if (held) held.push(observation);
    else this.observations.set(observation.key, [observation]);
    for (const rule of this.capsule.contingencies) {
      if (rule.when.key !== observation.key || !sameValue(rule.when.equals, observation.value)) continue;
      for (const spec of rule.then.spawn ?? []) {
        if (!this.tasks.has(spec.id)) this.tasks.set(spec.id, newWork(spec, { kind: 'contingency', ref: `${rule.id}:${spec.id}` }, e.actor, e.wall));
      }
    }
  }

  conflicts(earlier: ConflictRecord[]): ConflictRecord[] {
    const all = [...earlier, ...this.rejected.values()];
    for (const work of this.tasks.values()) {
      const { spec } = work.record;
      if (work.contested.size > 0) {
        const owner = ownerOf(work);
        all.push({
          id: `double-claim:${spec.id}`,
          severity: 'policy',
          kind: 'double-claim',
          taskId: spec.id,
          events: [...work.contested].sort(compareText),
          summary: `Two teams claimed "${spec.title}" while out of contact.`,
          resolved: true,
          resolution: `${owner ? this.name(owner) : 'Nobody'} keeps it by the tie-break. Every claim stays in the record.`,
        });
      }
      if (work.completions.size > 1) {
        const finishers = [...work.completions.values()];
        all.push({
          id: `duplicate-effort:${spec.id}`,
          severity: 'policy',
          kind: 'duplicate-effort',
          taskId: spec.id,
          events: finishers.map((c) => c.event).sort(compareText),
          summary: `${finishers.map((c) => this.name(c.actor)).join(' and ')} both finished "${spec.title}".`,
          resolved: true,
          resolution: 'Both records kept.',
        });
      }
    }
    for (const conflict of all) {
      const answer = this.resolutions.get(conflict.id);
      if (!answer) continue;
      conflict.resolved = true;
      conflict.resolution = answer.resolution;
      const task = conflict.taskId === undefined ? undefined : this.tasks.get(conflict.taskId);
      const kept = task && [...task.completions.values()].find((c) => answer.keep.includes(c.event));
      if (task && kept) task.record.evidence = kept.evidence;
    }
    for (const conflict of all) {
      const task = conflict.taskId === undefined ? undefined : this.tasks.get(conflict.taskId);
      if (task && conflict.kind === 'token-fork' && !conflict.resolved) task.record.status = 'conflicted';
    }
    return all.sort((a, b) => compareText(a.id, b.id));
  }
}

function emptyState(mission: string, roster: Roster, eventCount: number): MissionState {
  return { mission, capsule: null, actors: seedActors(roster), tasks: {}, tokens: {}, observations: {}, conflicts: [], eventCount };
}

/** Pure: the same set of events gives the same state on every replica, in any arrival order. */
export function reduce(events: AnyEvent[], roster: Roster): MissionState {
  const ordered = causalOrder(events);
  const genesis = ordered.find((e): e is EventEnvelope<'mission.issued'> => e.type === 'mission.issued' && isGenesis(e, roster));
  if (!genesis) return emptyState(ordered[0]?.mission ?? '', roster, ordered.length);

  const capsule = genesis.body.capsule;
  const actors = seedActors(roster);
  const known = (actor: ActorId) => actor === capsule.issuer || actors[actor] !== undefined;

  const forged: ConflictRecord[] = [];
  const reject = (e: AnyEvent, summary: string) =>
    forged.push({ id: `forged-event:${e.id}`, severity: 'violation', kind: 'forged-event', events: [e.id], summary, resolved: false });

  const admitted: AnyEvent[] = [];
  for (const e of ordered) {
    if (e.id === genesis.id) admitted.push(e);
    else if (e.mission !== capsule.id) reject(e, 'Ignored an event from another mission.');
    else if (!known(e.actor)) reject(e, 'Ignored an event from a device that is not on the roster.');
    else if (e.type === 'mission.issued') reject(e, 'Ignored a second mission issue.');
    else if (e.type === 'actor.joined' && !joinMatches(e, roster)) reject(e, 'Ignored a join with a credential that does not match the roster.');
    else admitted.push(e);
  }

  const { tokens, violations } = deriveTokens(capsule, admitted, custodiansOf(roster));
  const fold = new Fold(capsule, roster, buildClocks(admitted), tokens, admitted);
  for (const e of admitted) {
    const record = actors[e.actor];
    if (record) {
      record.lastSeq = Math.max(record.lastSeq, e.seq);
      record.lastSeenWall = Math.max(record.lastSeenWall, e.wall);
    }
    fold.apply(e);
  }

  return {
    mission: capsule.id,
    capsule,
    actors,
    tasks: Object.fromEntries([...fold.tasks].map(([id, work]) => [id, work.record])),
    tokens,
    observations: Object.fromEntries(fold.observations),
    conflicts: fold.conflicts([...forged, ...violations]),
    eventCount: ordered.length,
  };
}

function joinMatches(e: EventEnvelope<'actor.joined'>, roster: Roster): boolean {
  const entry = roster.find((r) => r.actor === e.actor);
  return entry !== undefined && entry.team === e.body.team && entry.credential.sig === e.body.credential?.sig;
}
