import type {
  ActorId,
  Capability,
  ContingencyRule,
  DecisionRecord,
  MissionCapsule,
  MissionState,
  Point,
  ResourceId,
  ResourceSpec,
  TaskRecord,
  TeamId,
  TeamSpec,
  TokenId,
} from '@afterlink/protocol';
import { knowledgeState, leadReport, newestInDate, sameValue } from './knowledge.ts';

export interface PlanInput {
  self: ActorId;
  state: MissionState;
  reachable: ActorId[];
  now: number;
  horizon: Record<ActorId, number>;
  lastHeard: Record<ActorId, number>;
}

export type Input = DecisionRecord['inputs'][number];

export interface Fact extends Input {
  subject: string;
}

export interface Member {
  id: ActorId;
  team: TeamSpec;
  load: number;
  at: Point;
  hash: number;
}

export interface TransferAsk {
  from: ActorId;
  resource: ResourceId;
  count: number;
}

/** Tasks one actor carries at once. The rest stay open for whoever frees up or arrives. */
export const MAX_ACTIVE = 3;

/** A deadline below this is a duration from the start of the task, not a wall-clock time. */
const EPOCH_FLOOR = 1e11;

const ACTIVE = new Set(['claimed', 'accepted']);
const UNOWNED = new Set(['open', 'deferred', 'refused']);

export function isActive(task: TaskRecord): boolean {
  return !!task.owner && (ACTIVE.has(task.status) || task.status === 'conflicted');
}

/** Refused and deferred are one actor's verdict at one moment, so the work stays on the table. */
export function isUnowned(task: TaskRecord): boolean {
  return UNOWNED.has(task.status) || (!task.owner && (ACTIVE.has(task.status) || task.status === 'conflicted'));
}

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** FNV-1a. Small and identical on every engine, for tie-breaks rather than security. */
export function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Stable pseudo-random rank of a task and actor pairing. Spreads ties instead of favouring one actor. */
export function tieBreak(taskHash: number, actorHash: number, span: number): number {
  let h = Math.imul(taskHash ^ actorHash, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) % span;
}

export function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.round(Math.sqrt(dx * dx + dy * dy));
}

export function deadlineAt(task: TaskRecord, capsule: MissionCapsule): number | undefined {
  const d = task.spec.deadlineMs;
  if (d === undefined) return undefined;
  if (d >= EPOCH_FLOOR) return d;
  return (task.source.kind === 'capsule' ? capsule.issuedAt : task.updatedAt) + d;
}

function spentKey(task: TaskRecord['spec']['id'], resource: ResourceId, actor: ActorId): string {
  return `${task}|${resource}|${actor}`;
}

/** Unspent rights by holder. Earmarks and reservations during one plan draw this down. */
export class TokenPool {
  private readonly free = new Map<ActorId, Map<ResourceId, TokenId[]>>();
  private readonly groupFree = new Map<ResourceId, number>();
  private readonly moving = new Set<ResourceId>();
  private readonly spent = new Map<string, number>();

  constructor(state: MissionState, private readonly group: readonly ActorId[]) {
    const inGroup = new Set(group);
    for (const id of Object.keys(state.tokens).sort(byText)) {
      const token = state.tokens[id]!;
      if (token.state === 'in-transit') this.moving.add(token.resource);
      if (token.state === 'committed' && token.committedTo && token.holder) {
        const key = spentKey(token.committedTo, token.resource, token.holder);
        this.spent.set(key, (this.spent.get(key) ?? 0) + 1);
      }
      if (token.state !== 'held' || !token.holder) continue;
      let shelf = this.free.get(token.holder);
      if (!shelf) this.free.set(token.holder, (shelf = new Map()));
      const list = shelf.get(token.resource);
      if (list) list.push(id);
      else shelf.set(token.resource, [id]);
      if (inGroup.has(token.holder)) this.groupFree.set(token.resource, (this.groupFree.get(token.resource) ?? 0) + 1);
    }
  }

  count(actor: ActorId, resource: ResourceId): number {
    return this.free.get(actor)?.get(resource)?.length ?? 0;
  }

  /** Free rights of a class among everyone in contact. */
  inContact(resource: ResourceId): number {
    return this.groupFree.get(resource) ?? 0;
  }

  isMoving(resource: ResourceId): boolean {
    return this.moving.has(resource);
  }

  /** A holder out of contact who still has this right free. */
  holderOutOfContact(resource: ResourceId): ActorId | undefined {
    const inGroup = new Set(this.group);
    const holders = [...this.free.keys()].filter((a) => !inGroup.has(a) && this.count(a, resource) > 0);
    return holders.sort(byText)[0];
  }

  /**
   * Rights are spent when work starts, not when it is claimed, so a claimed task keeps what it
   * still needs spoken for. Holders out of contact are left alone: their rights are out of reach
   * anyway, and a refusal should still say who holds them.
   */
  earmark(actor: ActorId, task: TaskRecord): void {
    if (!this.group.includes(actor)) return;
    for (const { resource, count } of task.spec.needs) {
      this.take(actor, resource, Math.max(0, count - (this.spent.get(spentKey(task.spec.id, resource, actor)) ?? 0)));
    }
  }

  /** Which classes each holder can still spend. */
  holdings(): Map<ActorId, Set<ResourceId>> {
    const out = new Map<ActorId, Set<ResourceId>>();
    for (const [actor, shelf] of this.free) {
      out.set(actor, new Set([...shelf].filter(([, list]) => list.length > 0).map(([resource]) => resource)));
    }
    return out;
  }

  /** Takes rights for one task: the actor's own first, then asks peers in contact for the shortfall. */
  reserve(actor: ActorId, needs: ReadonlyMap<ResourceId, number>): { tokens: TokenId[]; asks: TransferAsk[] } {
    const tokens: TokenId[] = [];
    const asks: TransferAsk[] = [];
    for (const [resource, count] of needs) {
      const own = this.take(actor, resource, count);
      tokens.push(...own);
      let missing = count - own.length;
      for (const peer of this.group) {
        if (!missing) break;
        if (peer === actor) continue;
        const got = this.take(peer, resource, missing);
        if (!got.length) continue;
        asks.push({ from: peer, resource, count: got.length });
        missing -= got.length;
      }
    }
    return { tokens, asks };
  }

  private take(actor: ActorId, resource: ResourceId, count: number): TokenId[] {
    const list = this.free.get(actor)?.get(resource);
    if (!list) return [];
    const taken = list.splice(0, count);
    if (this.group.includes(actor)) this.groupFree.set(resource, this.inContact(resource) - taken.length);
    return taken;
  }
}

/** Everything one tick needs, derived once from this actor's own state and nothing else. */
export interface View {
  input: PlanInput;
  capsule: MissionCapsule;
  /** This actor and every peer in contact, in one canonical order. */
  group: Member[];
  members: Map<ActorId, Member>;
  me: Member;
  /** Every peer the link layer reports, known to this view or not, for the record. */
  peers: ActorId[];
  /** Every known actor with a place on a team, in contact or not. */
  everyone: { id: ActorId; team: TeamSpec }[];
  teams: Map<TeamId, TeamSpec>;
  skills: Map<TeamId, Set<Capability>>;
  resources: Map<ResourceId, ResourceSpec>;
  /** Canonical order: most important first. */
  tasks: TaskRecord[];
  blockedKinds: Map<string, ContingencyRule>;
  facts: Map<string, Fact>;
  pool: TokenPool;
  /** Who could spend which resource classes before this plan reserved anything. */
  holdings: Map<ActorId, Set<ResourceId>>;
}

function rankOrder(capsule: MissionCapsule, tasks: TaskRecord[]): TaskRecord[] {
  const ranks = new Map(capsule.objectives.map((o) => [o.id, o.rank]));
  const keyed = tasks.map((task) => ({
    task,
    rank: ranks.get(task.spec.objective) ?? Infinity,
    deadline: deadlineAt(task, capsule) ?? Infinity,
  }));
  keyed.sort(
    (a, b) =>
      a.task.spec.priority - b.task.spec.priority ||
      (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) ||
      (a.deadline === b.deadline ? 0 : a.deadline < b.deadline ? -1 : 1) ||
      byText(a.task.spec.id, b.task.spec.id),
  );
  return keyed.map((k) => k.task);
}

function blockedKinds(capsule: MissionCapsule, state: MissionState, now: number): Map<string, ContingencyRule> {
  const out = new Map<string, ContingencyRule>();
  for (const rule of capsule.contingencies) {
    if (!rule.then.blockKinds?.length) continue;
    const current = newestInDate(state.observations[rule.when.key] ?? [], now);
    if (!current || !sameValue(current.value, rule.when.equals)) continue;
    for (const kind of rule.then.blockKinds) if (!out.has(kind)) out.set(kind, rule);
  }
  return out;
}

export function readView(input: PlanInput): View | null {
  const { self, state, reachable, now } = input;
  const capsule = state.capsule;
  if (!capsule) return null;

  const teams = new Map(capsule.teams.map((t) => [t.id, t]));
  const everyone = Object.values(state.actors)
    .flatMap((a) => {
      const team = teams.get(a.team);
      return team ? [{ id: a.id, team }] : [];
    })
    .sort((a, b) => byText(a.id, b.id));
  const known = new Map(everyone.map((e) => [e.id, e.team]));
  if (!known.has(self)) return null;

  const ids = [...new Set([self, ...reachable])].filter((id) => known.has(id)).sort(byText);
  const group: Member[] = ids.map((id) => {
    const team = known.get(id)!;
    return { id, team, load: 0, at: team.home, hash: hashText(id) };
  });
  const members = new Map(group.map((m) => [m.id, m]));

  const tasks = rankOrder(capsule, Object.values(state.tasks));
  const pool = new TokenPool(state, ids);
  const lastAt = new Map<ActorId, number>();
  for (const task of tasks) {
    const active = isActive(task);
    if (!active && task.status !== 'completed') continue;
    for (const id of [...(task.owner ? [task.owner] : []), ...(task.coveredBy ?? [])]) {
      if (active) pool.earmark(id, task);
      const m = members.get(id);
      if (!m) continue;
      if (active) m.load++;
      if (task.updatedAt > (lastAt.get(id) ?? -Infinity)) {
        lastAt.set(id, task.updatedAt);
        m.at = task.spec.location;
      }
    }
  }

  return {
    input,
    capsule,
    group,
    members,
    me: members.get(self)!,
    peers: [...new Set(reachable)].filter((id) => id !== self).sort(byText),
    everyone,
    teams,
    skills: new Map(capsule.teams.map((t) => [t.id, new Set(t.capabilities)])),
    resources: new Map(capsule.resources.map((r) => [r.id, r])),
    tasks,
    blockedKinds: blockedKinds(capsule, state, now),
    facts: new Map(),
    pool,
    holdings: pool.holdings(),
  };
}

/** What this actor knows about a key right now, with its age and standing. */
export function factFor(view: View, key: string): Fact {
  const held = view.facts.get(key);
  if (held) return held;
  const { state, now } = view.input;
  const reports = state.observations[key] ?? [];
  const lead = leadReport(reports, now);
  const fact: Fact = lead
    ? {
        key,
        ageMs: Math.max(0, now - lead.observedAt),
        state: knowledgeState(lead, now, reports, view.group.map((m) => m.id)),
        subject: lead.subject || key,
      }
    : { key, ageMs: -1, state: 'pending', subject: key };
  view.facts.set(key, fact);
  return fact;
}

/** The last time this actor heard from a peer, by link or else by its newest event. */
export function heardAt(view: View, actor: ActorId): number {
  const { lastHeard, state } = view.input;
  return lastHeard[actor] ?? state.actors[actor]?.lastSeenWall ?? 0;
}

/** Contact with a peer as a decision input, for records that turn on who can be reached. */
export function contactInput(view: View, actor: ActorId): Input {
  const team = view.everyone.find((e) => e.id === actor)?.team.id ?? actor;
  return {
    key: `contact.${team}`,
    ageMs: Math.max(0, view.input.now - heardAt(view, actor)),
    state: view.members.has(actor) ? 'confirmed' : 'unreachable',
  };
}

export function teamName(view: View, actor: ActorId): string {
  return view.everyone.find((e) => e.id === actor)?.team.name ?? 'Another team';
}

export function resourceName(view: View, resource: ResourceId): string {
  return view.resources.get(resource)?.name ?? resource;
}

export function latestBy(task: TaskRecord, actor: ActorId): DecisionRecord | undefined {
  for (let i = task.decisions.length - 1; i >= 0; i--) {
    if (task.decisions[i]!.actor === actor) return task.decisions[i];
  }
  return undefined;
}

/** Whoever lets go of a task stays out of it until they take it back by hand. */
export function hasDeclined(task: TaskRecord, actor: ActorId): boolean {
  for (let i = task.decisions.length - 1; i >= 0; i--) {
    const d = task.decisions[i]!;
    if (d.actor !== actor) continue;
    if (d.policy === 'task.released') return true;
    if (d.outcome === 'ACCEPTED') return false;
  }
  return false;
}

