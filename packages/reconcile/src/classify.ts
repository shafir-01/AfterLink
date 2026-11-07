import * as proto from '@afterlink/protocol';
import type { AnyEvent, ConflictRecord, EventId, MissionState } from '@afterlink/protocol';
import { Ledger, makeCtx } from './ledger.ts';

type Draft = ConflictRecord & { lines: string[] };

export function classify(events: AnyEvent[], state: MissionState): ConflictRecord[] {
  const ctx = makeCtx(events, state);
  const out = new Map<string, Draft>();
  const add = (id: string, base: Omit<ConflictRecord, 'id' | 'events' | 'summary'>, ev: EventId[], line: string) => {
    const cur = out.get(id);
    if (cur) {
      for (const x of ev) if (!cur.events.includes(x)) cur.events.push(x);
      if (!cur.lines.includes(line)) cur.lines.push(line);
    } else out.set(id, { ...base, id, events: [...new Set(ev)], lines: [line], summary: '' });
  };

  const verify = (proto as unknown as { verifyEvent?: (e: AnyEvent) => { ok: boolean; reason?: string } }).verifyEvent;
  const known = new Set(Object.keys(state.actors ?? {}));
  if (ctx.capsule) known.add(ctx.capsule.issuer);
  const bySeq = new Map<string, AnyEvent>();
  const rejected = new Set<EventId>();
  for (const e of ctx.order) {
    const forged = (reason: string) => { rejected.add(e.id); add(`forged-event:${e.id}`, { severity: 'violation', kind: 'forged-event', resolved: false }, [e.id], `${ctx.teamName(e.actor)}: ${reason}`); };
    if (state.mission && e.mission !== state.mission) forged('event belongs to a different mission');
    else if (typeof verify === 'function') {
      let r: { ok: boolean; reason?: string };
      try { r = verify(e); } catch { r = { ok: false, reason: 'unreadable event' }; }
      if (!r.ok) forged(`signature check failed (${r.reason ?? 'invalid'})`);
    }
    if (known.size > 0 && e.type !== 'mission.issued' && !known.has(e.actor)) forged('event from an actor that was never provisioned');
    const key = `${e.actor}#${e.seq}`;
    const prior = bySeq.get(key);
    if (prior && prior.id !== e.id) add(`forged-event:${key}`, { severity: 'violation', kind: 'forged-event', resolved: false }, [prior.id, e.id], `${ctx.teamName(e.actor)} signed two different events at position ${e.seq}`);
    else bySeq.set(key, e);
  }

  const ledger = new Ledger(ctx, state);
  for (const e of ctx.order) {
    if (rejected.has(e.id)) continue;
    for (const b of ledger.step(e)) {
      const ev = b.other ? [b.other, b.event] : [b.event];
      if (b.kind === 'token-fork') add(`token-fork:${b.token}`, { severity: 'violation', kind: 'token-fork', tokenId: b.token, resolved: false }, ev, b.reason);
      else add(`forged-event:unauthorised:${b.actor}:${b.token}`, { severity: 'violation', kind: 'forged-event', tokenId: b.token, resolved: false }, ev, `Unauthorised action: ${b.reason}`);
    }
  }

  const byTask = new Map<string, AnyEvent[]>();
  for (const e of ctx.order) {
    if (rejected.has(e.id)) continue;
    const t = (e.body as { taskId?: string }).taskId;
    if (t && e.type.startsWith('task.')) {
      if (!byTask.has(t)) byTask.set(t, []);
      byTask.get(t)!.push(e);
    }
  }
  for (const [taskId, evs] of byTask) {
    const title = ctx.titleOf(taskId);
    const claims = evs.filter((e) => e.type === 'task.claimed');
    if (new Set(claims.map((e) => e.actor)).size > 1) {
      const owner = state.tasks?.[taskId]?.owner;
      add(`double-claim:${taskId}`, { severity: 'policy', kind: 'double-claim', taskId, resolved: true, resolution: `Deterministic tie-break${owner ? `: ${ctx.teamName(owner)} keeps ${title}` : ''}` }, claims.map((e) => e.id),
        `${[...new Set(claims.map((e) => ctx.teamName(e.actor)))].join(' and ')} both claimed ${title}`);
    }
    const workers = evs.filter((e) => e.type === 'task.completed' || e.type === 'task.accepted' || e.type === 'task.covered');
    if (new Set(workers.map((e) => e.actor)).size > 1) {
      add(`duplicate-effort:${taskId}`, { severity: 'policy', kind: 'duplicate-effort', taskId, resolved: true, resolution: 'Both records kept; the earliest completion is the account of record' }, workers.map((e) => e.id),
        `${[...new Set(workers.map((e) => ctx.teamName(e.actor)))].join(' and ')} both worked on ${title}`);
    }
    for (const e of claims) {
      if (e.type !== 'task.claimed') continue;
      const bad = e.body.decision.inputs.filter((i) => i.state === 'stale' || i.state === 'contradicted');
      if (bad.length) add(`stale-decision:${e.id}`, { severity: 'policy', kind: 'stale-decision', taskId, resolved: true, resolution: 'Decision kept with its knowledge record; later facts are shown beside it' }, [e.id],
        `${ctx.teamName(e.actor)} took ${title} relying on ${bad.map((i) => `${i.key} (${i.state})`).join(', ')}`);
    }
  }

  const resolved = new Map<string, { resolution: string }>();
  for (const e of ctx.order) if (e.type === 'conflict.resolved') resolved.set(e.body.conflictId, { resolution: e.body.resolution });

  return [...out.values()].map(({ lines, ...c }) => {
    const rec: ConflictRecord = { ...c, summary: lines.join('; ') };
    const r = resolved.get(c.id);
    if (r) { rec.resolved = true; rec.resolution = r.resolution; }
    return rec;
  });
}
