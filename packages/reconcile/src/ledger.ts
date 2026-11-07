import type { ActorId, AnyEvent, EventId, MissionCapsule, MissionState, TaskId, TeamId, TokenId, TransferId } from '@afterlink/protocol';

export interface Ctx {
  order: AnyEvent[];
  capsule: MissionCapsule | null;
  teamOf(actor: ActorId): TeamId | undefined;
  teamName(actor: ActorId): string;
  teamLabel(team: TeamId | undefined): string;
  titleOf(task: TaskId): string;
}

export function orderEvents(events: AnyEvent[]): AnyEvent[] {
  const seen = new Set<EventId>();
  const out: AnyEvent[] = [];
  for (const e of events) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
  return out.sort((a, b) => a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function makeCtx(events: AnyEvent[], state: MissionState): Ctx {
  const order = orderEvents(events);
  let capsule = state.capsule;
  const teams = new Map<ActorId, TeamId>();
  const titles = new Map<TaskId, string>();
  for (const [id, a] of Object.entries(state.actors ?? {})) teams.set(id, a.team);
  for (const [id, t] of Object.entries(state.tasks ?? {})) titles.set(id, t.spec.title);
  for (const e of order) {
    if (e.type === 'mission.issued' && !capsule) capsule = e.body.capsule;
    if (e.type === 'actor.joined' && !teams.has(e.actor)) teams.set(e.actor, e.body.team);
    if (e.type === 'task.created' && !titles.has(e.body.spec.id)) titles.set(e.body.spec.id, e.body.spec.title);
  }
  for (const t of capsule?.tasks ?? []) if (!titles.has(t.id)) titles.set(t.id, t.title);
  const teamLabel = (team?: TeamId) => (team && capsule?.teams.find((x) => x.id === team)?.name) || team || 'Unknown team';
  return {
    order,
    capsule,
    teamOf: (a) => teams.get(a),
    teamLabel,
    teamName: (a) => teamLabel(teams.get(a)),
    titleOf: (t) => titles.get(t) ?? t,
  };
}

export interface TokenCell {
  team: TeamId;
  state: 'held' | 'in-transit' | 'committed';
  committedTo?: TaskId;
  committedBy?: ActorId;
  offeredBy?: ActorId;
  to?: ActorId;
  transfer?: TransferId;
  ref?: EventId;
}

export interface Breach {
  kind: 'token-fork' | 'unauthorised';
  token: TokenId;
  actor: ActorId;
  event: EventId;
  other?: EventId;
  reason: string;
}

export class Ledger {
  tokens = new Map<TokenId, TokenCell>();
  private transfers = new Map<TransferId, { tokens: TokenId[]; from: ActorId; to: ActorId }>();

  constructor(private ctx: Ctx, state: MissionState) {
    for (const r of ctx.capsule?.resources ?? []) for (const t of r.tokens) this.tokens.set(t.id, { team: t.holderTeam, state: 'held' });
    if (this.tokens.size === 0) for (const t of Object.values(state.tokens ?? {})) this.tokens.set(t.id, { team: t.holderTeam, state: 'held' });
  }

  step(e: AnyEvent): Breach[] {
    const out: Breach[] = [];
    const team = this.ctx.teamOf(e.actor);
    const name = this.ctx.teamLabel(team);
    const breach = (kind: Breach['kind'], token: TokenId, reason: string, other?: EventId) => out.push({ kind, token, actor: e.actor, event: e.id, other, reason });
    if (e.type === 'right.offered') {
      this.transfers.set(e.body.transfer, { tokens: e.body.tokens, from: e.actor, to: e.body.to });
      for (const id of e.body.tokens) {
        const c = this.tokens.get(id);
        if (!c) continue;
        if (c.state === 'held' && team === c.team) { c.state = 'in-transit'; c.offeredBy = e.actor; c.to = e.body.to; c.transfer = e.body.transfer; c.ref = e.id; }
        else if (c.state === 'in-transit' && c.offeredBy === e.actor) breach('token-fork', id, `${name} offered ${id} a second time while the first offer was unanswered`, c.ref);
        else if (c.state === 'committed') breach('token-fork', id, `${name} offered ${id} after it was committed to ${this.ctx.titleOf(c.committedTo ?? '')}`, c.ref);
        else if (team !== c.team) breach('unauthorised', id, `${name} offered ${id}, which belongs to ${this.ctx.teamLabel(c.team)}`, c.ref);
      }
    } else if (e.type === 'right.accepted' || e.type === 'right.declined') {
      const tr = this.transfers.get(e.body.transfer);
      if (!tr) return out;
      for (const id of tr.tokens) {
        const c = this.tokens.get(id);
        if (!c || c.state !== 'in-transit' || c.transfer !== e.body.transfer) continue;
        if (e.actor !== tr.to) { breach('unauthorised', id, `${name} answered a transfer addressed to ${this.ctx.teamName(tr.to)}`, c.ref); continue; }
        if (e.type === 'right.accepted') c.team = this.ctx.teamOf(tr.to) ?? c.team;
        c.state = 'held'; c.offeredBy = c.to = c.transfer = undefined; c.ref = e.id;
      }
    } else if (e.type === 'right.committed') {
      for (const id of e.body.tokens) {
        const c = this.tokens.get(id);
        if (!c) continue;
        if (c.state === 'held' && team === c.team) { c.state = 'committed'; c.committedTo = e.body.taskId; c.committedBy = e.actor; c.ref = e.id; }
        else if (c.state === 'committed') {
          if (c.committedTo !== e.body.taskId || c.committedBy !== e.actor)
            breach('token-fork', id, `${id} was committed twice: to ${this.ctx.titleOf(c.committedTo ?? '')} by ${this.ctx.teamName(c.committedBy ?? '')} and to ${this.ctx.titleOf(e.body.taskId)} by ${name}`, c.ref);
        } else if (c.state === 'in-transit' && c.offeredBy === e.actor) breach('token-fork', id, `${name} committed ${id} after offering it to ${this.ctx.teamName(c.to ?? '')}`, c.ref);
        else breach('unauthorised', id, `${name} committed ${id}, which ${c.state === 'in-transit' ? 'is in transit' : `belongs to ${this.ctx.teamLabel(c.team)}`}`, c.ref);
      }
    }
    return out;
  }
}
