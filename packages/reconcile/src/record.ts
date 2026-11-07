import * as authority from '@afterlink/authority';
import type { ActorId, AnyEvent, EventId, MissionRecord, MissionState, PartitionEpisode, ResourceId, TaskId, TimelineEntry } from '@afterlink/protocol';
import { classify } from './classify.ts';
import { Ledger, makeCtx, type Ctx } from './ledger.ts';

export interface RecordEntry extends TimelineEntry {
  taskId?: TaskId;
  /** Exclusive resources this step asked for, committed or refused. */
  requests?: { resource: ResourceId; count: number }[];
}

export type RecordWithTimeline = Omit<MissionRecord, 'timeline'> & { timeline: RecordEntry[] };

const SAFETY_REFUSALS = new Set(['NO_RIGHT', 'TOKEN_IN_TRANSIT', 'STALE_KNOWLEDGE', 'HUMAN_APPROVAL_REQUIRED']);
const BLOCKED_STATES = new Set(['severed', 'closed']);

function resourceOf(token: string, state: MissionState, ctx: Ctx): ResourceId {
  const fromState = state.tokens?.[token]?.resource;
  if (fromState) return fromState;
  for (const r of ctx.capsule?.resources ?? []) if (r.tokens.some((t) => t.id === token)) return r.id;
  return token.split('#')[0]!;
}

function resourceName(id: ResourceId, ctx: Ctx): string {
  return (ctx.capsule?.resources.find((r) => r.id === id)?.name ?? id).toLowerCase();
}

function deriveEpisodes(ctx: Ctx): PartitionEpisode[] {
  const actors = new Set<ActorId>();
  for (const e of ctx.order) {
    actors.add(e.actor);
    if (e.type === 'link.changed') actors.add(e.body.peer);
  }
  const latest = new Map<string, string>();
  const down = (a: ActorId, b: ActorId) => BLOCKED_STATES.has(latest.get(`${a}>${b}`) ?? '') || BLOCKED_STATES.has(latest.get(`${b}>${a}`) ?? '');
  const groupsNow = (): ActorId[][] => {
    const list = [...actors].sort();
    const parent = new Map(list.map((a) => [a, a]));
    const find = (a: ActorId): ActorId => (parent.get(a) === a ? a : find(parent.get(a)!));
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) if (!down(list[i]!, list[j]!)) parent.set(find(list[i]!), find(list[j]!));
    const m = new Map<ActorId, ActorId[]>();
    for (const a of list) (m.get(find(a)) ?? m.set(find(a), []).get(find(a))!).push(a);
    return [...m.values()].sort((x, y) => (x[0]! < y[0]! ? -1 : 1));
  };

  const out: PartitionEpisode[] = [];
  let cur: { ep: PartitionEpisode; start: number; sig: string } | null = null;
  const close = (idx: number, wall: number) => {
    if (!cur) return;
    cur.ep.to = wall;
    tally(cur.ep, cur.start, idx);
    cur = null;
  };
  const tally = (ep: PartitionEpisode, from: number, to: number) => {
    for (let i = from + 1; i < to; i++) {
      const e = ctx.order[i]!;
      if (e.type === 'task.completed') ep.tasksDone++;
      if (e.type === 'task.claimed' || e.type === 'task.refused' || e.type === 'task.deferred' || e.type === 'task.covered') ep.decisions++;
      if (e.type === 'task.refused') ep.refusals++;
    }
  };
  ctx.order.forEach((e, idx) => {
    if (e.type !== 'link.changed') return;
    if (e.body.state === 'open' || BLOCKED_STATES.has(e.body.state)) latest.set(`${e.actor}>${e.body.peer}`, e.body.state);
    else return;
    const groups = groupsNow();
    const sig = JSON.stringify(groups);
    if (groups.length < 2) return close(idx, e.wall);
    if (cur && cur.sig === sig) return;
    close(idx, e.wall);
    const ep: PartitionEpisode = { id: `episode-${out.length + 1}`, from: e.wall, to: null, groups, tasksDone: 0, decisions: 0, refusals: 0 };
    out.push(ep);
    cur = { ep, start: idx, sig };
  });
  if (cur) tally((cur as { ep: PartitionEpisode; start: number }).ep, (cur as { start: number }).start, ctx.order.length);
  return out;
}

function conservationOf(state: MissionState): MissionRecord['conservation'] {
  const fn = (authority as unknown as { conservation?: (s: MissionState) => MissionRecord['conservation'] }).conservation;
  if (typeof fn === 'function') return fn(state);
  const by = new Map<ResourceId, MissionRecord['conservation'][number]>();
  for (const t of Object.values(state.tokens ?? {})) {
    const row = by.get(t.resource) ?? { resource: t.resource, issued: 0, committed: 0, held: 0, inTransit: 0, ok: true };
    row.issued++;
    if (t.state === 'committed') row.committed++;
    else if (t.state === 'held') row.held++;
    else row.inTransit++;
    by.set(t.resource, row);
  }
  return [...by.values()].map((r) => ({ ...r, ok: r.committed + r.held + r.inTransit === r.issued }));
}

export function buildMissionRecord(a: { events: AnyEvent[]; state: MissionState; hqSeen: EventId[]; episodes?: PartitionEpisode[] }): RecordWithTimeline {
  const ctx = makeCtx(a.events, a.state);
  const hq = new Set(a.hqSeen);
  const ledger = new Ledger(ctx, a.state);
  const episodes = a.episodes && a.episodes.length > 0 ? a.episodes : deriveEpisodes(ctx);

  const timeline: RecordEntry[] = [];
  const completedHidden = new Set<TaskId>();
  const safetyRefusals = new Set<string>();
  const transitRefusals = new Set<string>();
  const outcome = new Set<TaskId>();
  const known = new Set<TaskId>([...Object.keys(a.state.tasks ?? {})]);

  for (const e of ctx.order) {
    const T = ctx.teamName(e.actor);
    let label = '';
    let taskId: TaskId | undefined;
    let requests: RecordEntry['requests'];
    switch (e.type) {
      case 'mission.issued': label = `Mission issued: ${e.body.capsule.name}`; break;
      case 'actor.joined': label = `${e.body.name} joined ${ctx.teamLabel(e.body.team)}`; break;
      case 'task.created': taskId = e.body.spec.id; known.add(taskId); label = `New task: ${e.body.spec.title}`; break;
      case 'task.claimed': taskId = e.body.taskId; label = `${T} took ${ctx.titleOf(taskId)}`; break;
      case 'task.covered': taskId = e.body.taskId; label = `${T} started cover on ${ctx.titleOf(taskId)}`; break;
      case 'task.accepted': taskId = e.body.taskId; label = `${T} accepted ${ctx.titleOf(taskId)}`; break;
      case 'task.released': taskId = e.body.taskId; label = `${T} released ${ctx.titleOf(taskId)}`; break;
      case 'task.deferred': taskId = e.body.taskId; label = `${T} deferred ${ctx.titleOf(taskId)}: ${e.body.decision.reason}`; break;
      case 'task.completed':
        taskId = e.body.taskId;
        outcome.add(taskId);
        label = `${T} completed ${ctx.titleOf(taskId)}`;
        if (!hq.has(e.id)) completedHidden.add(taskId);
        break;
      case 'task.refused': {
        taskId = e.body.taskId;
        outcome.add(taskId);
        const d = e.body.decision;
        const spec = a.state.tasks?.[taskId]?.spec ?? ctx.capsule?.tasks.find((t) => t.id === taskId);
        const myTeam = ctx.teamOf(e.actor);
        const blocking = (spec?.needs ?? []).flatMap((n) => [...ledger.tokens.entries()].filter(([id, c]) => resourceOf(id, a.state, ctx) === n.resource && c.team !== myTeam).map(([, c]) => ({ n, c })))[0];
        if (d.refusal === 'NO_RIGHT' && blocking) label = `${T} refused: ${resourceName(blocking.n.resource, ctx)} held by ${ctx.teamLabel(blocking.c.team)}`;
        else if (d.refusal === 'TOKEN_IN_TRANSIT' && blocking) label = `${T} refused: ${resourceName(blocking.n.resource, ctx)} in transit to ${blocking.c.to ? ctx.teamName(blocking.c.to) : 'another team'}`;
        else label = `${T} refused ${ctx.titleOf(taskId)}: ${d.reason}`;
        if (d.refusal && SAFETY_REFUSALS.has(d.refusal)) safetyRefusals.add(`${e.actor}|${taskId}|${d.refusal}`);
        if (d.refusal === 'NO_RIGHT' || d.refusal === 'TOKEN_IN_TRANSIT') {
          transitRefusals.add(`${e.actor}|${taskId}|${d.refusal}`);
          requests = (spec?.needs ?? []).map((n) => ({ resource: n.resource, count: n.count }));
        }
        break;
      }
      case 'right.committed': {
        taskId = e.body.taskId;
        const counts = new Map<ResourceId, number>();
        for (const t of e.body.tokens) { const r = resourceOf(t, a.state, ctx); counts.set(r, (counts.get(r) ?? 0) + 1); }
        requests = [...counts].map(([resource, count]) => ({ resource, count }));
        label = `${T} committed ${e.body.tokens.join(', ')} to ${ctx.titleOf(taskId)}`;
        break;
      }
      case 'right.offered': label = `${T} offered ${e.body.tokens.join(', ')} to ${ctx.teamName(e.body.to)}`; break;
      case 'right.accepted': label = `${T} accepted a transfer of rights`; break;
      case 'right.declined': label = `${T} declined a transfer of rights`; break;
      case 'observation.recorded': label = `${T} observed ${e.body.observation.key} = ${JSON.stringify(e.body.observation.value)}`; break;
      case 'link.changed': label = `${T} ${e.body.state === 'open' ? 'connected to' : BLOCKED_STATES.has(e.body.state) ? 'lost contact with' : 'is connecting to'} ${ctx.teamName(e.body.peer)}`; break;
      case 'ferry.received': label = `${T} received a carried update with ${e.body.newEvents} new ${e.body.newEvents === 1 ? 'event' : 'events'}`; break;
      case 'conflict.resolved': label = `Conflict resolved: ${e.body.resolution}`; break;
    }
    const entry: RecordEntry = { at: e.wall, lamport: e.lamport, actor: e.actor, team: ctx.teamOf(e.actor) ?? '', event: e.id, type: e.type, label, hiddenFromHq: !hq.has(e.id) };
    if (taskId) entry.taskId = taskId;
    if (requests && requests.length) entry.requests = requests;
    timeline.push(entry);
    ledger.step(e);
  }

  const conflicts = classify(a.events, a.state);
  const conservation = conservationOf(a.state);
  const unknowns: string[] = [];
  for (const [id, t] of Object.entries(a.state.tasks ?? {})) {
    if (['completed', 'refused', 'cancelled'].includes(t.status)) outcome.add(id);
  }
  for (const id of [...known].sort()) if (!outcome.has(id)) unknowns.push(`No recorded outcome for ${ctx.titleOf(id)} (${a.state.tasks?.[id]?.status ?? 'status unknown'})`);
  for (const t of Object.values(a.state.tokens ?? {}))
    if (t.state === 'in-transit') unknowns.push(`${t.id} is in transit and no answer has been recorded; it stays unavailable until the recipient answers`);
  for (const ep of episodes) if (ep.to === null) unknowns.push(`${ep.id} has no recorded end`);

  return {
    mission: a.state.mission,
    events: ctx.order.length,
    actors: new Set(ctx.order.map((e) => e.actor)).size,
    episodes,
    doneWhileHqBlind: completedHidden.size,
    refusedUnsafe: safetyRefusals.size,
    duplicatesPrevented: transitRefusals.size,
    conflicts,
    conservation,
    timeline,
    unknowns,
  };
}
