import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '@afterlink/protocol';
import {
  ACCESS,
  FACILITIES,
  FOUR,
  MEDIC,
  NOW,
  SUPPLY,
  applyActions,
  capsule,
  ofType,
  report,
  spec,
  taskRecord,
  tick,
  token,
  world,
} from './world.ts';

describe('assignment', () => {
  it('explains the claim in one plain sentence', () => {
    const state = world({
      tasks: [taskRecord(spec('faint', { location: { x: 12, y: 12 }, requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }))],
      tokens: [token('aed#1', MEDIC)],
    });
    const [claim] = ofType(tick(state, { self: MEDIC }), 'claim');
    expect(claim?.tokens).toEqual(['aed#1']);
    expect(claim?.decision.outcome).toBe('ACCEPTED');
    expect(claim?.decision.reason).toBe('Assigned to Medics: only team here with first aid, and you hold the AED.');
  });

  it('picks the closest capable team and says so', () => {
    const state = world({ tasks: [taskRecord(spec('haul', { location: { x: 80, y: 85 }, requires: ['haul'] }))] });
    expect(ofType(tick(state, { self: SUPPLY }), 'claim')).toEqual([]);
    expect(ofType(tick(state, { self: FACILITIES }), 'claim')[0]?.decision.reason).toBe('Assigned to Facilities: closest team with haul.');
  });

  it('measures distance from the last task, not from home', () => {
    const state = world({
      tasks: [
        taskRecord(spec('done', { location: { x: 85, y: 85 } }), { status: 'completed', owner: SUPPLY, updatedAt: NOW - 1_000 }),
        taskRecord(spec('next', { location: { x: 80, y: 80 }, requires: ['haul'] })),
      ],
    });
    expect(ofType(tick(state, { self: FACILITIES }), 'claim')).toEqual([]);
    expect(ofType(tick(state, { self: SUPPLY }), 'claim').map((c) => c.taskId)).toEqual(['next']);
  });

  it('weighs work already in hand against a shorter walk', () => {
    const home = { x: 10, y: 90 };
    const busy = [1, 2].map((n) => taskRecord(spec(`busy${n}`, { location: home }), { status: 'accepted', owner: SUPPLY }));
    const state = world({ tasks: [...busy, taskRecord(spec('next', { location: { x: 45, y: 90 }, requires: ['haul'] }))] });
    expect(ofType(tick(state, { self: SUPPLY }), 'claim')).toEqual([]);
    expect(ofType(tick(state, { self: FACILITIES }), 'claim')[0]?.decision.reason).toBe('Assigned to Facilities: least busy team with haul.');
  });

  it('spreads work by load before distance wins it all', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => taskRecord(spec(id, { location: { x: 11, y: 89 }, requires: ['haul'] })));
    const state = world({ tasks });
    expect(ofType(tick(state, { self: SUPPLY }), 'claim').length).toBeGreaterThan(0);
    expect(ofType(tick(state, { self: FACILITIES }), 'claim').length).toBeGreaterThan(0);
  });

  it('takes priority 1 over a nearer priority 3 when there is room for one', () => {
    const tasks = [
      taskRecord(spec('near', { priority: 3, location: { x: 10, y: 10 } })),
      taskRecord(spec('far', { priority: 1, location: { x: 100, y: 100 } })),
    ];
    const busy = [1, 2].map((n) => taskRecord(spec(`busy${n}`), { status: 'accepted', owner: MEDIC }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [...tasks, ...busy] });
    expect(ofType(tick(state, { self: MEDIC }), 'claim').map((c) => c.taskId)).toEqual(['far']);
  });

  it('prefers a tighter deadline at equal priority', () => {
    const tasks = [
      taskRecord(spec('later', { deadlineMs: NOW + 3_600_000 })),
      taskRecord(spec('soon', { deadlineMs: NOW + 30_000 })),
    ];
    const busy = [1, 2].map((n) => taskRecord(spec(`busy${n}`), { status: 'accepted', owner: MEDIC }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [...tasks, ...busy] });
    expect(ofType(tick(state, { self: MEDIC }), 'claim').map((c) => c.taskId)).toEqual(['soon']);
  });

  it('never hands an actor more than it can carry', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => taskRecord(spec(`t${i}`)));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks });
    expect(ofType(tick(state, { self: MEDIC }), 'claim')).toHaveLength(3);
  });

  it('records the candidates it compared, best first, with the ruled out last', () => {
    const state = world({ tasks: [taskRecord(spec('haul', { location: { x: 80, y: 85 }, requires: ['haul'] }))] });
    const candidates = ofType(tick(state, { self: FACILITIES }), 'claim')[0]?.decision.candidates ?? [];
    expect(candidates.map((c) => c.team)).toEqual(['facilities', 'supply', expect.any(String), expect.any(String)]);
    expect(candidates[0]!.score).toBeLessThan(candidates[1]!.score);
    expect(candidates[3]).toMatchObject({ score: -1, note: expect.stringContaining('no haul') });
  });

  it('snapshots what the actor knew', () => {
    const state = world({
      tasks: [taskRecord(spec('t', { reliesOn: ['gate.north'] }))],
      observations: [report('gate.north', true, ACCESS, 5_000)],
    });
    const decision = ofType(tick(state, { self: MEDIC, reachable: [ACCESS, MEDIC] }), 'claim')[0]?.decision;
    expect(decision).toMatchObject({
      actor: MEDIC,
      reachable: [ACCESS],
      horizon: { [MEDIC]: 7 },
      inputs: [{ key: 'gate.north', ageMs: 5_000, state: 'local' }],
      policy: 'planner.min-cost-assignment',
    });
  });
});

describe('rights', () => {
  const chairTask = () =>
    taskRecord(spec('carry', { priority: 1, location: { x: 12, y: 12 }, requires: ['first-aid'], needs: [{ resource: 'evac-chair', count: 1 }], reversible: false }));

  it('asks a holder in contact, and refuses until the right arrives', () => {
    const state = world({ tasks: [chairTask()], tokens: [token('evac-chair#1', ACCESS)] });
    const actions = tick(state, { self: MEDIC });
    expect(ofType(actions, 'claim')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision).toMatchObject({ outcome: 'REFUSED', refusal: 'NO_RIGHT', next: ['REQUEST_TRANSFER'] });
    expect(ofType(actions, 'request-transfer')[0]).toMatchObject({ resource: 'evac-chair', from: ACCESS, count: 1, taskId: 'carry' });
    expect(ofType(actions, 'refuse')[0]?.decision.reason).toBe('Cannot start yet: Access holds the evacuation chair, so you have asked for it.');
  });

  it('refuses without a request when the holder is out of reach', () => {
    const state = world({ tasks: [chairTask()], tokens: [token('evac-chair#1', ACCESS)] });
    const actions = tick(state, { self: MEDIC, reachable: [SUPPLY], lastHeard: { [ACCESS]: NOW - 120_000 } });
    expect(ofType(actions, 'request-transfer')).toEqual([]);
    const decision = ofType(actions, 'refuse')[0]?.decision;
    expect(decision).toMatchObject({ refusal: 'NO_RIGHT', reason: 'Cannot start: Access holds the evacuation chair and cannot be reached.' });
    expect(decision?.next).toEqual(expect.arrayContaining(['CARRY_UPDATE', 'WAIT_FOR_CONTACT', 'SUBSTITUTE']));
    expect(decision?.inputs).toContainEqual({ key: 'contact.access', ageMs: 120_000, state: 'unreachable' });
  });

  it('keeps SUBSTITUTE for work that cannot wait', () => {
    const relaxed = taskRecord(spec('later', { priority: 3, requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({ tasks: [relaxed], tokens: [token('aed#1', ACCESS)] });
    expect(ofType(tick(state, { self: MEDIC, reachable: [] }), 'refuse')[0]?.decision.next).toEqual(['CARRY_UPDATE', 'WAIT_FOR_CONTACT']);
  });

  it('reports a right in transit with its own code', () => {
    const state = world({ tasks: [chairTask()], tokens: [token('evac-chair#1', null, { state: 'in-transit', transfer: 'x' })] });
    expect(ofType(tick(state, { self: MEDIC }), 'refuse')[0]?.decision).toMatchObject({ refusal: 'TOKEN_IN_TRANSIT', next: ['WAIT_FOR_CONTACT', 'CARRY_UPDATE'] });
  });

  it('points to a substitute when every right is spent', () => {
    const state = world({ tasks: [chairTask()], tokens: [token('evac-chair#1', ACCESS, { state: 'committed', committedTo: 'other' })] });
    expect(ofType(tick(state, { self: MEDIC }), 'refuse')[0]?.decision).toMatchObject({ refusal: 'NO_RIGHT', next: ['SUBSTITUTE', 'ESCALATE'] });
  });

  it('routes the task to the capable team holding the right rather than asking for a transfer', () => {
    const task = taskRecord(spec('t', { location: { x: 11, y: 89 }, requires: ['haul'], needs: [{ resource: 'cart', count: 1 }] }));
    const state = world({ tasks: [task], tokens: [token('cart#1', FACILITIES)] });
    expect(ofType(tick(state, { self: SUPPLY }), 'claim')).toEqual([]);
    expect(ofType(tick(state, { self: FACILITIES }), 'claim')[0]?.tokens).toEqual(['cart#1']);
  });

  it('gives one right to the more urgent of two tasks and refuses the other', () => {
    const tasks = [
      taskRecord(spec('p1', { priority: 1, needs: [{ resource: 'aed', count: 1 }] })),
      taskRecord(spec('p2', { priority: 2, needs: [{ resource: 'aed', count: 1 }] })),
    ];
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks, tokens: [token('aed#1', MEDIC)] });
    const actions = tick(state, { self: MEDIC });
    expect(ofType(actions, 'claim').map((c) => c.taskId)).toEqual(['p1']);
    expect(ofType(actions, 'refuse').map((r) => r.taskId)).toEqual(['p2']);
  });

  it('does not promise a claimed right twice before it is spent', () => {
    const first = taskRecord(spec('first', { needs: [{ resource: 'aed', count: 1 }] }));
    const second = taskRecord(spec('second', { priority: 3, needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [first], tokens: [token('aed#1', MEDIC)] });
    const claimed = applyActions(state, MEDIC, tick(state, { self: MEDIC }));
    claimed.tasks.second = second;
    expect(claimed.tokens['aed#1']?.state).toBe('held');
    const actions = tick(claimed, { self: MEDIC });
    expect(ofType(actions, 'claim')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision.refusal).toBe('NO_RIGHT');
  });

  it('frees the earmark once the right is committed to that work', () => {
    const first = taskRecord(spec('first', { needs: [{ resource: 'aed', count: 1 }] }), { status: 'accepted', owner: MEDIC });
    const second = taskRecord(spec('second', { needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({
      actors: { [MEDIC]: 'medics' },
      tasks: [first, second],
      tokens: [token('aed#1', MEDIC, { state: 'committed', committedTo: 'first' }), token('aed#2', MEDIC)],
    });
    expect(ofType(tick(state, { self: MEDIC }), 'claim')[0]?.tokens).toEqual(['aed#2']);
  });

  it('asks the same holder whatever order the link layer lists its peers in', () => {
    const task = taskRecord(spec('t', { requires: ['first-aid'], needs: [{ resource: 'cart', count: 1 }] }));
    const state = world({ tasks: [task], tokens: [token('cart#1', SUPPLY), token('cart#2', FACILITIES)] });
    const asked = (reachable: string[]) => ofType(tick(state, { self: MEDIC, reachable }), 'request-transfer').map((a) => a.from);
    expect(asked([SUPPLY, FACILITIES])).toEqual(asked([FACILITIES, SUPPLY]));
  });

  it('never counts a right held by someone out of contact', () => {
    const task = taskRecord(spec('t', { requires: ['haul'], needs: [{ resource: 'cart', count: 2 }] }));
    const state = world({ tasks: [task], tokens: [token('cart#1', SUPPLY), token('cart#2', FACILITIES)] });
    const actions = tick(state, { self: SUPPLY, reachable: [MEDIC] });
    expect(ofType(actions, 'claim')).toEqual([]);
    expect(ofType(actions, 'request-transfer')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision.refusal).toBe('NO_RIGHT');
  });
});

describe('gates', () => {
  it('defers on an unmet dependency, then claims once it finishes', () => {
    const dep = taskRecord(spec('dep'), { status: 'accepted', owner: ACCESS });
    const task = taskRecord(spec('t', { dependsOn: ['dep'], requires: ['first-aid'] }));
    const state = world({ tasks: [dep, task] });
    const [defer] = ofType(tick(state, { self: MEDIC }), 'defer');
    expect(defer?.decision).toMatchObject({ outcome: 'DEFERRED', refusal: 'DEPENDENCY_UNMET', policy: 'task.dependsOn', reason: 'Waiting: "Task dep" has to finish first.' });

    const deferred = applyActions(state, MEDIC, [defer!]);
    deferred.tasks.dep = { ...deferred.tasks.dep!, status: 'completed' };
    expect(ofType(tick(deferred, { self: MEDIC }), 'claim').map((c) => c.taskId)).toEqual(['t']);
  });

  it('points across the gap when the dependency owner is cut off', () => {
    const dep = taskRecord(spec('dep'), { status: 'accepted', owner: ACCESS });
    const task = taskRecord(spec('t', { dependsOn: ['dep'], requires: ['first-aid'] }));
    const state = world({ tasks: [dep, task] });
    expect(ofType(tick(state, { self: MEDIC, reachable: [SUPPLY] }), 'defer')[0]?.decision.next).toEqual(['CARRY_UPDATE', 'WAIT_FOR_CONTACT']);
  });

  it('defers on a dependency this view has never heard of', () => {
    const state = world({ tasks: [taskRecord(spec('t', { dependsOn: ['unknown'] }))] });
    const decisions = FOUR.flatMap((self) => ofType(tick(state, { self }), 'defer'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision.reason).toBe('Waiting: this depends on work you have not heard about yet.');
  });

  it('refuses irreversible work on stale knowledge', () => {
    const task = taskRecord(spec('t', { reversible: false, reliesOn: ['gate.north'] }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [task], observations: [report('gate.north', true, MEDIC, 240_000, 60_000, 'the north gate')] });
    const actions = tick(state, { self: MEDIC });
    expect(ofType(actions, 'claim')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision).toMatchObject({
      refusal: 'STALE_KNOWLEDGE',
      policy: 'task.reversible',
      reason: 'Cannot start: this cannot be undone and the report on the north gate is 4 minutes old.',
      inputs: [{ key: 'gate.north', ageMs: 240_000, state: 'stale' }],
    });
  });

  it('allows reversible work on the same stale knowledge, and says what it is betting on', () => {
    const task = taskRecord(spec('t', { reversible: true, reliesOn: ['gate.north'] }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [task], observations: [report('gate.north', true, MEDIC, 240_000, 60_000, 'the north gate')] });
    const [claim] = ofType(tick(state, { self: MEDIC }), 'claim');
    expect(claim?.decision.policy).toBe('task.reversible');
    expect(claim?.decision.reason).toBe('Assigned to Medics: only team here, and this can be undone if the word on the north gate is out of date.');
  });

  it('keeps the plain sentence when reversible work relies on a fact nobody has reported yet', () => {
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [taskRecord(spec('t', { reliesOn: ['gate.north.open'] }))] });
    const [claim] = ofType(tick(state, { self: MEDIC }), 'claim');
    expect(claim?.decision.reason).toBe('Assigned to Medics: only team here.');
    expect(claim?.decision.inputs).toEqual([{ key: 'gate.north.open', ageMs: -1, state: 'pending' }]);
  });

  it('refuses irreversible work with no report at all, and when reports disagree', () => {
    const task = taskRecord(spec('t', { reversible: false, reliesOn: ['gate.north'] }));
    const empty = world({ actors: { [MEDIC]: 'medics' }, tasks: [task] });
    expect(ofType(tick(empty, { self: MEDIC }), 'refuse')[0]?.decision.reason).toBe('Cannot start: this cannot be undone and nobody has reported on gate.north yet.');

    const disputed = world({
      actors: { [MEDIC]: 'medics', [ACCESS]: 'access' },
      tasks: [task],
      observations: [report('gate.north', true, MEDIC, 2_000), report('gate.north', false, ACCESS, 1_000)],
    });
    const reasons = [MEDIC, ACCESS].flatMap((self) => ofType(tick(disputed, { self }), 'refuse').map((r) => r.decision.reason));
    expect(reasons).toEqual(['Cannot start: this cannot be undone and reports on gate.north disagree.']);
  });

  it('allows irreversible work on fresh knowledge', () => {
    const task = taskRecord(spec('t', { reversible: false, reliesOn: ['gate.north'] }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [task], observations: [report('gate.north', true, MEDIC, 10_000, 60_000)] });
    expect(ofType(tick(state, { self: MEDIC }), 'claim').map((c) => c.taskId)).toEqual(['t']);
  });

  it('asks for a person on kinds the capsule reserves, even with every right in hand', () => {
    const task = taskRecord(spec('close', { kind: 'site-closure', needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [task], tokens: [token('aed#1', MEDIC)] });
    const actions = tick(state, { self: MEDIC });
    expect(ofType(actions, 'claim')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision).toMatchObject({ refusal: 'HUMAN_APPROVAL_REQUIRED', next: ['ESCALATE'], policy: 'fallback.humanApprovalKinds' });
  });

  it('does not ask for rights that unapproved work may never use', () => {
    const task = taskRecord(spec('close', { kind: 'site-closure', requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({ tasks: [task], tokens: [token('aed#1', ACCESS)] });
    expect(ofType(tick(state, { self: MEDIC }), 'request-transfer')).toEqual([]);
  });

  it('blocks a kind while the observation holds, and clears when it lapses or changes', () => {
    const rule = { id: 'north-closed', when: { key: 'gate.north', equals: false }, then: { blockKinds: ['north-route'], note: 'North gate closed' } };
    const task = taskRecord(spec('t', { kind: 'north-route' }));
    const base = { capsule: capsule({ contingencies: [rule] }), actors: { [MEDIC]: 'medics' }, tasks: [task] };

    const closed = world({ ...base, observations: [report('gate.north', false, ACCESS, 1_000, 60_000)] });
    expect(ofType(tick(closed, { self: MEDIC }), 'refuse')[0]?.decision).toMatchObject({
      refusal: 'BLOCKED_BY_CONTINGENCY',
      policy: 'contingency.north-closed',
      reason: 'Blocked: North gate closed.',
      inputs: [{ key: 'gate.north', state: 'local' }],
    });

    const lapsed = world({ ...base, observations: [report('gate.north', false, ACCESS, 120_000, 60_000)] });
    expect(ofType(tick(lapsed, { self: MEDIC }), 'claim')).toHaveLength(1);

    const reopened = world({ ...base, observations: [report('gate.north', false, ACCESS, 5_000), report('gate.north', true, ACCESS, 1_000)] });
    expect(ofType(tick(reopened, { self: MEDIC }), 'claim')).toHaveLength(1);
  });

  it('refuses when nobody here has the skill, and says who to reach', () => {
    const task = taskRecord(spec('t', { requires: ['first-aid'] }));
    const state = world({ tasks: [task] });
    const [refusal] = ofType(tick(state, { self: ACCESS, reachable: [FACILITIES] }), 'refuse').concat(ofType(tick(state, { self: FACILITIES, reachable: [ACCESS] }), 'refuse'));
    expect(refusal?.decision).toMatchObject({ refusal: 'NO_CAPABILITY', next: ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'], reason: 'Cannot start: no team here has first aid.' });
  });

  it('escalates a skill no team in the mission has', () => {
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [taskRecord(spec('t', { requires: ['welding'] }))] });
    expect(ofType(tick(state, { self: MEDIC }), 'refuse')[0]?.decision.next).toEqual(['ESCALATE']);
  });
});

describe('cover', () => {
  const claimed = (priority: 1 | 2 | 3) =>
    taskRecord(spec('water', { priority, location: { x: 85, y: 85 }, requires: ['haul'] }), { status: 'claimed', owner: SUPPLY });

  it('covers once the owner has been out of contact long enough and the priority qualifies', () => {
    const state = world({ tasks: [claimed(1)] });
    const heard = { [SUPPLY]: NOW - 9_000 };
    const [cover] = ofType(tick(state, { self: FACILITIES, reachable: [MEDIC, ACCESS], lastHeard: heard }), 'cover');
    expect(cover?.decision).toMatchObject({
      outcome: 'ACCEPTED',
      policy: 'fallback.coverAfterMs',
      reason: 'Covering for Supply: no contact for 9 seconds, and this is priority 1 work.',
    });
    expect(cover?.decision.inputs).toContainEqual({ key: 'contact.supply', ageMs: 9_000, state: 'unreachable' });
  });

  it('waits out the cover window', () => {
    const state = world({ tasks: [claimed(1)] });
    expect(tick(state, { self: FACILITIES, reachable: [MEDIC, ACCESS], lastHeard: { [SUPPLY]: NOW - 7_000 } })).toEqual([]);
  });

  it('leaves work below the priority bar to a human', () => {
    const state = world({ tasks: [claimed(2)] });
    expect(tick(state, { self: FACILITIES, reachable: [MEDIC, ACCESS], lastHeard: { [SUPPLY]: NOW - 60_000 } })).toEqual([]);
  });

  it('does not cover an owner who is still in contact', () => {
    const state = world({ tasks: [claimed(1)] });
    expect(tick(state, { self: FACILITIES, lastHeard: { [SUPPLY]: NOW - 60_000 } })).toEqual([]);
  });

  it('covers once per group, and only again if the coverer vanishes too', () => {
    const state = world({ tasks: [claimed(1)] });
    const heard = { [SUPPLY]: NOW - 9_000, [FACILITIES]: NOW };
    const reachable = [MEDIC, ACCESS, FACILITIES];
    const coverActions = tick(state, { self: FACILITIES, reachable, lastHeard: heard });
    const covered = applyActions(state, FACILITIES, coverActions);
    expect(tick(covered, { self: FACILITIES, reachable, lastHeard: heard })).toEqual([]);
    expect(tick(covered, { self: MEDIC, reachable, lastHeard: heard })).toEqual([]);
  });

  it('commits its own rights to cover, never the absent owner\'s', () => {
    const task = taskRecord(spec('water', { priority: 1, requires: ['haul'], needs: [{ resource: 'cart', count: 1 }] }), { status: 'accepted', owner: SUPPLY });
    const state = world({ tasks: [task], tokens: [token('cart#1', SUPPLY, { state: 'committed', committedTo: 'water' }), token('cart#2', FACILITIES)] });
    const [cover] = ofType(tick(state, { self: FACILITIES, reachable: [MEDIC], lastHeard: { [SUPPLY]: NOW - 9_000 } }), 'cover');
    expect(cover?.tokens).toEqual(['cart#2']);
  });

  it('records why a task could not be covered', () => {
    const task = taskRecord(spec('water', { priority: 1, requires: ['haul'], needs: [{ resource: 'cart', count: 1 }] }), { status: 'accepted', owner: SUPPLY });
    const state = world({ tasks: [task], tokens: [token('cart#1', SUPPLY, { state: 'committed', committedTo: 'water' })] });
    const actions = tick(state, { self: FACILITIES, reachable: [MEDIC], lastHeard: { [SUPPLY]: NOW - 9_000 } });
    expect(ofType(actions, 'cover')).toEqual([]);
    expect(ofType(actions, 'refuse')[0]?.decision.refusal).toBe('NO_RIGHT');
  });
});

describe('races and release', () => {
  const claimDecision = (actor: string): DecisionRecord => ({
    id: `d-${actor}`,
    actor,
    taskId: 't',
    outcome: 'ACCEPTED',
    reason: '',
    policy: 'planner.min-cost-assignment',
    reachable: [],
    horizon: {},
    inputs: [],
  });
  const releaseMarker = (actor: string): DecisionRecord => ({ ...claimDecision(actor), id: 'r', outcome: 'UNKNOWN', policy: 'task.released' });

  it('releases a claim that lost the race, once', () => {
    const task = taskRecord(spec('t'), { status: 'claimed', owner: ACCESS, decisions: [claimDecision(MEDIC), claimDecision(ACCESS)] });
    const state = world({ tasks: [task] });
    const actions = tick(state, { self: MEDIC });
    expect(actions.map((a) => a.type)).toEqual(['release']);
    expect(ofType(actions, 'release')[0]?.reason).toBe('Access took this task first, so you can leave it to them.');
    expect(tick(applyActions(state, MEDIC, actions), { self: MEDIC })).toEqual([]);
  });

  it('leaves the winner alone', () => {
    const task = taskRecord(spec('t'), { status: 'claimed', owner: ACCESS, decisions: [claimDecision(MEDIC), claimDecision(ACCESS)] });
    expect(tick(world({ tasks: [task] }), { self: ACCESS })).toEqual([]);
  });

  it('does not treat cover as a lost claim', () => {
    const task = taskRecord(spec('t'), { status: 'claimed', owner: ACCESS, coveredBy: [MEDIC], decisions: [claimDecision(ACCESS), claimDecision(MEDIC)] });
    expect(tick(world({ tasks: [task] }), { self: MEDIC })).toEqual([]);
  });

  it('never hands a task back to someone who let it go', () => {
    const task = taskRecord(spec('t', { requires: ['haul'] }), { decisions: [claimDecision(SUPPLY), releaseMarker(SUPPLY)] });
    const state = world({ tasks: [task] });
    expect(ofType(tick(state, { self: SUPPLY }), 'claim')).toEqual([]);
    expect(ofType(tick(state, { self: FACILITIES }), 'claim').map((c) => c.taskId)).toEqual(['t']);
  });

  it('says so when everyone here has let it go', () => {
    const task = taskRecord(spec('t', { requires: ['stock'] }), { decisions: [releaseMarker(SUPPLY)] });
    const state = world({ tasks: [task] });
    expect(ofType(tick(state, { self: SUPPLY }), 'refuse')[0]?.decision).toMatchObject({ refusal: 'NO_CAPABILITY', next: ['ESCALATE'], reason: 'Cannot start: everyone here who could do this has declined it.' });
  });
});

describe('refusal idempotence', () => {
  it('says a refusal once, and again only when the situation changes', () => {
    const task = taskRecord(spec('t', { priority: 3, requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }));
    const state = world({ tasks: [task], tokens: [token('aed#1', ACCESS)] });
    const cut = { self: MEDIC, reachable: [SUPPLY] };
    const first = tick(state, cut);
    expect(ofType(first, 'refuse')).toHaveLength(1);

    const once = applyActions(state, MEDIC, first);
    expect(tick(once, cut)).toEqual([]);
    expect(tick(once, { ...cut, now: NOW + 60_000 })).toEqual([]);

    const healed = tick(once, { self: MEDIC });
    expect(ofType(healed, 'refuse')[0]?.decision.next).toEqual(['REQUEST_TRANSFER']);
    expect(ofType(healed, 'request-transfer')).toHaveLength(1);
    expect(tick(applyActions(once, MEDIC, healed), { self: MEDIC })).toEqual([]);
  });

  it('does not ping-pong between peers whose views differ', () => {
    const task = taskRecord(spec('t', { requires: ['haul'], needs: [{ resource: 'aed', count: 1 }] }));
    let state = world({ tasks: [task], tokens: [token('aed#1', MEDIC)] });
    const sees = { self: SUPPLY, reachable: [FACILITIES, MEDIC] };
    const blind = { self: FACILITIES, reachable: [SUPPLY] };
    let refusals = 0;
    for (let round = 0; round < 6; round++) {
      for (const view of [sees, blind]) {
        const actions = tick(state, view);
        refusals += ofType(actions, 'refuse').length;
        state = applyActions(state, view.self, actions);
      }
    }
    expect(refusals).toBeLessThanOrEqual(2);
  });
});

describe('edges', () => {
  it('does nothing before the mission is known, or for a device not on the roster', () => {
    expect(tick({ ...world({}), capsule: null }, { self: MEDIC })).toEqual([]);
    expect(tick(world({ tasks: [taskRecord(spec('t'))] }), { self: 'stranger' })).toEqual([]);
  });

  it('ignores unknown peers in the assignment but records them as reachable', () => {
    const state = world({ actors: { [MEDIC]: 'medics' }, tasks: [taskRecord(spec('t'))] });
    const [claim] = ofType(tick(state, { self: MEDIC, reachable: ['stranger'] }), 'claim');
    expect(claim?.decision.reachable).toEqual(['stranger']);
  });

  it('skips finished work', () => {
    const tasks = [taskRecord(spec('a'), { status: 'completed', owner: MEDIC }), taskRecord(spec('b'), { status: 'cancelled' })];
    expect(tick(world({ tasks }), { self: MEDIC })).toEqual([]);
  });
});
