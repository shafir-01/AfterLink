import { describe, expect, it } from 'vitest';
import type { AnyEvent, DecisionRecord, EventBodies, EventType, MissionCapsule, MissionState, TaskSpec } from '@afterlink/protocol';
import { buildMissionRecord, classify, counterfactual, whoKnewWhat } from '../src/index.ts';

const M = 'medics-dev', A = 'access-dev', S = 'supply-dev';
const spec = (id: string, title: string, needs: TaskSpec['needs'] = []): TaskSpec => ({
  id, kind: 'k', title, brief: '', objective: 'o', priority: 2, location: { x: 0, y: 0 }, locationName: '', requires: [], needs, dependsOn: [], reversible: true,
});
const specs = [spec('t1', 'Water to Stage 2'), spec('t2', 'Move chair', [{ resource: 'chair', count: 1 }]), spec('t3', 'Carry patient', [{ resource: 'chair', count: 1 }]), spec('t4', 'Gate check'), spec('t5', 'Sweep lot')];
const capsule = {
  v: 1, id: 'm1', version: 1, name: 'Field Day', objective: '', objectives: [], issuer: 'org', issuedAt: 0, contingencies: [],
  fallback: { coverAfterMs: 1, coverMaxPriority: 1, humanApprovalKinds: [] },
  teams: [{ id: 'medics', name: 'Medics', capabilities: [], home: { x: 0, y: 0 } }, { id: 'access', name: 'Access', capabilities: [], home: { x: 0, y: 0 } }, { id: 'supply', name: 'Supply', capabilities: [], home: { x: 0, y: 0 } }],
  resources: [{ id: 'chair', name: 'Evacuation chair', tokens: [{ id: 'chair#1', holderTeam: 'supply' }] }],
  tasks: specs,
} as MissionCapsule;

const seqs: Record<string, number> = {};
let n = 0;
function ev<T extends EventType>(actor: string, lamport: number, type: T, body: EventBodies[T], parents: string[] = [], mission = 'm1'): AnyEvent {
  const seq = (seqs[actor] = (seqs[actor] ?? 0) + 1);
  return { v: 1, id: `e${++n}`, mission, actor, seq, prev: seq > 1 ? `${actor}#${seq - 1}` : null, parents, lamport, wall: lamport * 100, type, body, sig: 's' } as unknown as AnyEvent;
}
const decision = (actor: string, taskId: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: 'd', actor, taskId, outcome: 'REFUSED', reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [], ...over,
});
const state = (over: Partial<MissionState> = {}): MissionState => ({
  mission: 'm1', capsule,
  actors: { [M]: { id: M, team: 'medics', name: 'm', lastSeq: 0, lastSeenWall: 0 }, [A]: { id: A, team: 'access', name: 'a', lastSeq: 0, lastSeenWall: 0 }, [S]: { id: S, team: 'supply', name: 's', lastSeq: 0, lastSeenWall: 0 } },
  tasks: {}, tokens: {}, observations: {}, conflicts: [], eventCount: 0, ...over,
});
const link = (actor: string, peer: string, s: 'open' | 'severed', l: number) => ev(actor, l, 'link.changed', { peer, state: s, transport: 'memory' });

function story() {
  for (const k of Object.keys(seqs)) delete seqs[k];
  const created = ev(M, 1, 'task.created', { spec: specs[0]!, source: { kind: 'capsule' } });
  const created2 = ev(M, 2, 'task.created', { spec: specs[1]!, source: { kind: 'capsule' } });
  const cut = [link(M, S, 'severed', 5), link(M, A, 'severed', 5), link(S, M, 'severed', 5), link(A, M, 'severed', 5)];
  const done = ev(M, 6, 'task.completed', { taskId: 't1', evidence: 'ok', via: 'tap' });
  const refused = ev(M, 7, 'task.refused', { taskId: 't2', decision: decision(M, 't2', { refusal: 'NO_RIGHT' }) });
  const commit = ev(S, 7, 'right.committed', { tokens: ['chair#1'], taskId: 't3' });
  const heal = [link(M, S, 'open', 10), link(M, A, 'open', 10), link(S, M, 'open', 10), link(A, M, 'open', 10)];
  return { created, created2, cut, done, refused, commit, heal, all: [created, created2, ...cut, done, refused, commit, ...heal] };
}

describe('classify', () => {
  it('returns nothing for a clean history', () => {
    const s = story();
    expect(classify(s.all, state())).toEqual([]);
  });

  it('flags double claims as policy and keeps both sides', () => {
    const c1 = ev(M, 1, 'task.claimed', { taskId: 't4', decision: decision(M, 't4') });
    const c2 = ev(A, 1, 'task.claimed', { taskId: 't4', decision: decision(A, 't4') });
    const r = classify([c1, c2], state());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'double-claim', severity: 'policy', resolved: true, taskId: 't4' });
    expect(r[0]!.events.sort()).toEqual([c1.id, c2.id].sort());
    expect(r[0]!.summary).toContain('Medics and Access both claimed Gate check');
  });

  it('flags duplicate effort when two teams complete the same task', () => {
    const d1 = ev(M, 1, 'task.completed', { taskId: 't4', evidence: '', via: 'tap' });
    const d2 = ev(A, 2, 'task.completed', { taskId: 't4', evidence: '', via: 'tap' });
    const r = classify([d1, d2], state());
    expect(r.map((c) => [c.kind, c.severity])).toEqual([['duplicate-effort', 'policy']]);
  });

  it('flags stale decisions as policy', () => {
    const c = ev(M, 1, 'task.claimed', { taskId: 't4', decision: decision(M, 't4', { inputs: [{ key: 'gate.open', ageMs: 9000, state: 'stale' }] }) });
    const r = classify([c], state());
    expect(r[0]).toMatchObject({ kind: 'stale-decision', severity: 'policy' });
  });

  it('flags a token committed twice as a violation naming both events', () => {
    const c1 = ev(S, 1, 'right.committed', { tokens: ['chair#1'], taskId: 't2' });
    const c2 = ev(S, 2, 'right.committed', { tokens: ['chair#1'], taskId: 't3' });
    const r = classify([c1, c2], state());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'token-fork', severity: 'violation', tokenId: 'chair#1', resolved: false });
    expect(r[0]!.events).toEqual([c1.id, c2.id]);
  });

  it('flags reclaiming a token after offering it', () => {
    const o = ev(S, 1, 'right.offered', { transfer: 'x1', tokens: ['chair#1'], to: A });
    const c = ev(S, 2, 'right.committed', { tokens: ['chair#1'], taskId: 't2' });
    expect(classify([o, c], state())[0]).toMatchObject({ kind: 'token-fork', severity: 'violation' });
  });

  it('allows a completed transfer followed by a commit by the new holder', () => {
    const o = ev(S, 1, 'right.offered', { transfer: 'x1', tokens: ['chair#1'], to: A });
    const acc = ev(A, 2, 'right.accepted', { transfer: 'x1' });
    const c = ev(A, 3, 'right.committed', { tokens: ['chair#1'], taskId: 't2' });
    expect(classify([o, acc, c], state())).toEqual([]);
  });

  it('flags an unauthorised commit as a violation', () => {
    const c = ev(M, 1, 'right.committed', { tokens: ['chair#1'], taskId: 't2' });
    const r = classify([c], state());
    expect(r[0]).toMatchObject({ severity: 'violation', tokenId: 'chair#1' });
    expect(r[0]!.summary).toContain('Unauthorised action');
  });

  it('flags events from another mission or an unknown actor as forged', () => {
    const other = ev(M, 1, 'task.completed', { taskId: 't1', evidence: '', via: 'tap' }, [], 'other');
    const stranger = ev('mallory', 2, 'task.completed', { taskId: 't1', evidence: '', via: 'tap' });
    const r = classify([other, stranger], state());
    expect(r.map((c) => c.kind)).toEqual(['forged-event', 'forged-event']);
    expect(r.every((c) => c.severity === 'violation')).toBe(true);
  });

  it('flags two different events at the same position as forged', () => {
    const a = ev(M, 1, 'task.completed', { taskId: 't1', evidence: 'a', via: 'tap' });
    const b = { ...a, id: 'other-id', body: { taskId: 't1', evidence: 'b', via: 'tap' } } as AnyEvent;
    const r = classify([a, b], state());
    expect(r[0]).toMatchObject({ kind: 'forged-event', severity: 'violation' });
    expect(r[0]!.events).toEqual([a.id, 'other-id']);
  });

  it('marks a conflict resolved when a resolution event names it', () => {
    const d1 = ev(M, 1, 'task.claimed', { taskId: 't4', decision: decision(M, 't4') });
    const d2 = ev(A, 1, 'task.claimed', { taskId: 't4', decision: decision(A, 't4') });
    const res = ev(M, 2, 'conflict.resolved', { conflictId: 'double-claim:t4', resolution: 'Access keeps it', keep: [d2.id] });
    expect(classify([d1, d2, res], state())[0]).toMatchObject({ resolved: true, resolution: 'Access keeps it' });
  });
});

describe('buildMissionRecord', () => {
  it('derives the partition episode from link events and counts work inside it', () => {
    const s = story();
    const rec = buildMissionRecord({ events: s.all, state: state(), hqSeen: [s.created.id, s.created2.id], episodes: [] });
    expect(rec.episodes).toHaveLength(1);
    const ep = rec.episodes[0]!;
    expect(ep.groups).toEqual([[A, S], [M]]);
    expect(ep.from).toBe(500);
    expect(ep.to).toBe(1000);
    expect(ep.tasksDone).toBe(1);
    expect(ep.refusals).toBe(1);
    expect(ep.decisions).toBe(1);
  });

  it('computes derived counts from events only', () => {
    const s = story();
    const rec = buildMissionRecord({ events: s.all, state: state(), hqSeen: [s.created.id], episodes: [] });
    expect(rec.doneWhileHqBlind).toBe(1);
    expect(rec.refusedUnsafe).toBe(1);
    expect(rec.duplicatesPrevented).toBe(1);
    expect(rec.events).toBe(s.all.length);
    expect(rec.actors).toBe(3);
    const seen = buildMissionRecord({ events: s.all, state: state(), hqSeen: s.all.map((e) => e.id), episodes: [] });
    expect(seen.doneWhileHqBlind).toBe(0);
    expect(seen.timeline.every((t) => !t.hiddenFromHq)).toBe(true);
  });

  it('labels the timeline in plain words', () => {
    const s = story();
    const rec = buildMissionRecord({ events: s.all, state: state(), hqSeen: [], episodes: [] });
    const labels = rec.timeline.map((t) => t.label);
    expect(labels).toContain('Medics completed Water to Stage 2');
    expect(labels).toContain('Medics refused: evacuation chair held by Supply');
    expect(labels).toContain('Supply committed chair#1 to Carry patient');
    expect(labels).toContain('Medics lost contact with Supply');
    const done = rec.timeline.find((t) => t.type === 'task.completed')!;
    expect(done).toMatchObject({ team: 'medics', hiddenFromHq: true, lamport: 6 });
  });

  it('lists explicit unknowns for tasks without outcome and tokens in transit', () => {
    const s = story();
    const st = state({
      tasks: { t5: { spec: specs[4]!, status: 'claimed', source: { kind: 'capsule' }, decisions: [], createdBy: M, updatedAt: 0 } },
      tokens: { 'chair#1': { id: 'chair#1', resource: 'chair', holder: null, holderTeam: 'supply', state: 'in-transit', chain: [] } },
    });
    const rec = buildMissionRecord({ events: s.all, state: st, hqSeen: [], episodes: [] });
    expect(rec.unknowns.some((u) => u.includes('Sweep lot'))).toBe(true);
    expect(rec.unknowns.some((u) => u.includes('chair#1 is in transit'))).toBe(true);
    expect(rec.unknowns.some((u) => u.includes('Water to Stage 2'))).toBe(false);
  });

  it('reports an open partition as unknown and keeps supplied episodes untouched', () => {
    const s = story();
    const open = buildMissionRecord({ events: [s.created, ...s.cut], state: state(), hqSeen: [], episodes: [] });
    expect(open.episodes[0]!.to).toBeNull();
    expect(open.unknowns.some((u) => u.includes('no recorded end'))).toBe(true);
    const ep = { id: 'x', from: 1, to: 2, groups: [[M], [A]], tasksDone: 9, decisions: 8, refusals: 7 };
    expect(buildMissionRecord({ events: s.all, state: state(), hqSeen: [], episodes: [ep] }).episodes).toEqual([ep]);
  });

  it('computes conservation from state when authority has none', () => {
    const s = story();
    const st = state({ tokens: { 'chair#1': { id: 'chair#1', resource: 'chair', holder: S, holderTeam: 'supply', state: 'committed', chain: [] } } });
    const rec = buildMissionRecord({ events: s.all, state: st, hqSeen: [], episodes: [] });
    expect(rec.conservation).toEqual([{ resource: 'chair', issued: 1, committed: 1, held: 0, inTransit: 0, ok: true }]);
  });
});

describe('counterfactual', () => {
  it('counts only work whose every step HQ saw, and LWW double bookings across groups', () => {
    const s = story();
    const st = state({ tokens: { 'chair#1': { id: 'chair#1', resource: 'chair', holder: S, holderTeam: 'supply', state: 'committed', chain: [] } } });
    const rec = buildMissionRecord({ events: s.all, state: st, hqSeen: [s.created.id, s.created2.id], episodes: [] });
    const cf = counterfactual(rec);
    expect(cf.centralOnlyCompleted).toBe(0);
    expect(cf.lastWriteWinsDoubleBookings).toBe(1);

    const visible = ev(A, 20, 'task.completed', { taskId: 't5', evidence: '', via: 'tap' });
    const seenAll = buildMissionRecord({ events: [...s.all, visible], state: st, hqSeen: [...s.all, visible].map((e) => e.id), episodes: [] });
    expect(counterfactual(seenAll).centralOnlyCompleted).toBe(2);
  });

  it('reports zero double bookings when requests come from one side only', () => {
    for (const k of Object.keys(seqs)) delete seqs[k];
    const cut = [link(M, S, 'severed', 5), link(M, A, 'severed', 5)];
    const c = ev(S, 7, 'right.committed', { tokens: ['chair#1'], taskId: 't3' });
    const r = ev(A, 8, 'task.refused', { taskId: 't2', decision: decision(A, 't2', { refusal: 'NO_RIGHT' }) });
    const rec = buildMissionRecord({ events: [...cut, c, r], state: state(), hqSeen: [], episodes: [] });
    expect(rec.episodes[0]!.groups).toEqual([[A, S], [M]]);
    expect(counterfactual(rec).lastWriteWinsDoubleBookings).toBe(0);
  });
});

describe('whoKnewWhat', () => {
  it('returns causal knowledge at a Lamport time and what was unseen', () => {
    for (const k of Object.keys(seqs)) delete seqs[k];
    const a1 = ev(A, 1, 'task.created', { spec: specs[3]!, source: { kind: 'capsule' } });
    const m1 = ev(M, 2, 'task.completed', { taskId: 't1', evidence: '', via: 'tap' });
    const s1 = ev(S, 3, 'task.completed', { taskId: 't4', evidence: '', via: 'tap' });
    const a2 = ev(A, 4, 'task.accepted', { taskId: 't4', via: 'tap' }, [s1.id]);
    const w = whoKnewWhat([a1, m1, s1, a2], A, 4);
    expect(w.known).toEqual([a1.id, s1.id, a2.id]);
    expect(w.unseen).toEqual([m1.id]);
    expect(w.completedKnown).toEqual(['t4']);
    expect(w.completedUnseen).toEqual(['t1']);
    expect(w.horizon).toEqual({ [A]: 2, [S]: 1 });
    expect(whoKnewWhat([a1, m1, s1, a2], A, 1).known).toEqual([a1.id]);
  });
});
