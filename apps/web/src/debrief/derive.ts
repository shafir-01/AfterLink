import type { AnyEvent, EventId, MissionRecord, MissionState, PartitionEpisode, TeamId, TimelineEntry } from '@afterlink/protocol';
import * as reconcile from '@afterlink/reconcile';
import * as mission from '@afterlink/mission';

export interface Roster { actorTeam: Record<string, TeamId>; teamName: Record<TeamId, string>; resourceName: Record<string, string>; teams: TeamId[] }

export function rosterOf(events: AnyEvent[]): Roster {
  const actorTeam: Record<string, TeamId> = {};
  const teamName: Record<TeamId, string> = {};
  const resourceName: Record<string, string> = {};
  const teams: TeamId[] = [];
  for (const e of events) {
    if (e.type === 'actor.joined') actorTeam[e.actor] = e.body.team;
    if (e.type === 'mission.issued') {
      for (const t of e.body.capsule.teams) { teamName[t.id] = t.name; if (!teams.includes(t.id)) teams.push(t.id); }
      for (const r of e.body.capsule.resources) resourceName[r.id] = r.name;
    }
  }
  for (const t of Object.values(actorTeam)) if (!teams.includes(t)) teams.push(t);
  return { actorTeam, teamName, resourceName, teams };
}

export type Derived =
  | { ok: true; record: MissionRecord; roster: Roster }
  | { ok: false; reason: string; roster: Roster };

export function derive(events: AnyEvent[], hqSeen: EventId[], episodes: PartitionEpisode[]): Derived {
  const roster = rosterOf(events);
  const build = (reconcile as Record<string, unknown>).buildMissionRecord as undefined | ((a: unknown) => MissionRecord);
  const reduce = (mission as Record<string, unknown>).reduce as undefined | ((e: AnyEvent[], r: unknown) => MissionState);
  if (!build || !reduce) return { ok: false, reason: 'The reconstruction engine is not available in this build.', roster };
  try {
    const rosterList = events.filter((e) => e.type === 'actor.joined').map((e) => {
      const b = (e as Extract<AnyEvent, { type: 'actor.joined' }>).body;
      return { actor: e.actor, team: b.team, name: b.name, custodian: b.credential.custodian, credential: b.credential };
    });
    const state = reduce(events, rosterList);
    return { ok: true, record: build({ events, state, hqSeen, episodes }), roster };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'Reconstruction failed.', roster };
  }
}

export interface Knowledge { team: TeamId; known: number; own: number; learned: number; missingFrom: TeamId[] }

/** For each team: the events it could have known at time `at`, taking only its own events and everything they causally cite. */
export function whoKnewWhat(events: AnyEvent[], roster: Roster, at: number): Knowledge[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const teamOf = (e: AnyEvent) => roster.actorTeam[e.actor];
  const upto = events.filter((e) => e.wall <= at);
  return roster.teams.map((team) => {
    const known = new Set<EventId>();
    const stack = upto.filter((e) => teamOf(e) === team).map((e) => e.id);
    while (stack.length) {
      const id = stack.pop()!;
      if (known.has(id)) continue;
      const ev = byId.get(id);
      if (!ev || ev.wall > at) continue;
      known.add(id);
      if (ev.prev) stack.push(ev.prev);
      for (const p of ev.parents) stack.push(p);
    }
    let own = 0;
    const seenTeams = new Set<TeamId>();
    for (const id of known) { const t = teamOf(byId.get(id)!); if (t === team) own++; else if (t) seenTeams.add(t); }
    const activeOthers = new Set(upto.map(teamOf).filter((t) => t && t !== team));
    return { team, known: known.size, own, learned: known.size - own, missingFrom: [...activeOthers].filter((t) => !seenTeams.has(t)) };
  });
}

export function plural(n: number, one: string, many: string) { return `${n} ${n === 1 ? one : many}`; }

export function headline(r: MissionRecord): string {
  const done = r.doneWhileHqBlind, ref = r.refusedUnsafe;
  if (!done && !ref) return r.episodes.length ? 'Headquarters was blind, and no work happened in that gap.' : 'Headquarters saw everything.';
  const parts = [];
  if (done) parts.push(`finished ${plural(done, 'task', 'tasks')}`);
  if (ref) parts.push(`refused ${plural(ref, 'unsafe promise', 'unsafe promises')}`);
  return `While headquarters was blind, your teams ${parts.join(' and ')}.`;
}

export function conservationWords(c: MissionRecord['conservation'][number], name: string): { text: string; ok: boolean } {
  if (!c.ok) return { text: `${name}: promised more than exists`, ok: false };
  if (c.committed === 0) return { text: `${name}: not promised`, ok: true };
  if (c.committed === 1) return { text: `${name}: promised once`, ok: true };
  return { text: `${name}: ${c.committed} of ${c.issued} promised, none twice`, ok: true };
}

export function clock(ms: number) {
  return new Date(ms).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export type { TimelineEntry };
