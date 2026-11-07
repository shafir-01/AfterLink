import { describe, expect, it } from 'vitest';
import type { MissionCapsule, MissionState, Observation, TaskRecord, TaskSpec } from '@afterlink/protocol';
import {
  activeRules,
  externalTaskId,
  heldValue,
  isTaskSpec,
  reservedFor,
  spawnerFor,
  transferIdFor,
  transferRequests,
  TRANSFER_REQUEST_KEY,
} from '../src/rules.ts';

const spec: TaskSpec = {
  id: 't1',
  kind: 'assist',
  title: 'Help',
  brief: 'Go',
  objective: 'o1',
  priority: 2,
  location: { x: 1, y: 2 },
  locationName: 'Gate',
  requires: ['first-aid'],
  needs: [{ resource: 'chair', count: 1 }],
  dependsOn: [],
  reversible: true,
};

const obs = (key: string, value: Observation['value'], observedAt: number, validForMs = 0, source = 'a'): Observation => ({
  key,
  value,
  subject: key,
  observedAt,
  validForMs,
  source,
});

const stateWith = (p: Partial<MissionState>): MissionState => ({
  mission: 'm',
  capsule: null,
  actors: {},
  tasks: {},
  tokens: {},
  observations: {},
  conflicts: [],
  eventCount: 0,
  ...p,
});

describe('external specs', () => {
  it('accepts a whole spec', () => {
    expect(isTaskSpec(spec)).toBe(true);
  });

  it.each([
    ['null', null],
    ['no id', { ...spec, id: undefined }],
    ['bad priority', { ...spec, priority: 4 }],
    ['bad location', { ...spec, location: { x: 'a', y: 2 } }],
    ['bad needs', { ...spec, needs: [{ resource: 'chair', count: 0 }] }],
    ['bad requires', { ...spec, requires: [1] }],
    ['missing reversible', { ...spec, reversible: undefined }],
  ])('refuses %s', (_n, v) => {
    expect(isTaskSpec(v)).toBe(false);
  });

  it('maps one reference to one task id', () => {
    expect(externalTaskId('form-7')).toBe(externalTaskId('form-7'));
    expect(externalTaskId('form-7')).not.toBe(externalTaskId('form-8'));
  });
});

describe('transfer requests', () => {
  const value = { taskId: 't1', resource: 'chair', count: 1, from: 'holder' };

  it('reads well formed requests and ignores anything else under the key', () => {
    const state = stateWith({
      observations: {
        [TRANSFER_REQUEST_KEY]: [obs(TRANSFER_REQUEST_KEY, value, 1), obs(TRANSFER_REQUEST_KEY, 'noise', 2), obs(TRANSFER_REQUEST_KEY, null, 3)],
      },
    });
    expect(transferRequests(state)).toEqual([{ by: 'a', ...value }]);
  });

  it('names the same transfer for the same request on every replica', () => {
    const r = { by: 'a', ...value };
    expect(transferIdFor(r)).toBe(transferIdFor({ ...r }));
    expect(transferIdFor(r)).not.toBe(transferIdFor({ ...r, taskId: 't2' }));
  });
});

describe('reserved rights', () => {
  const task = (status: TaskRecord['status'], owner: string, coveredBy?: string[]): TaskRecord => ({
    spec,
    status,
    source: { kind: 'human' },
    owner,
    coveredBy,
    decisions: [],
    createdBy: 'a',
    updatedAt: 0,
  });

  it('counts only active work of this actor that is not yet committed', () => {
    expect(reservedFor(stateWith({ tasks: { t1: task('claimed', 'me') } }), 'me', 'chair')).toBe(1);
    expect(reservedFor(stateWith({ tasks: { t1: task('claimed', 'other') } }), 'me', 'chair')).toBe(0);
    expect(reservedFor(stateWith({ tasks: { t1: task('completed', 'me') } }), 'me', 'chair')).toBe(0);
    expect(reservedFor(stateWith({ tasks: { t1: task('accepted', 'other', ['me']) } }), 'me', 'chair')).toBe(1);
    const committed = stateWith({
      tasks: { t1: task('accepted', 'me') },
      tokens: { 'chair#1': { id: 'chair#1', resource: 'chair', holder: 'me', holderTeam: 'x', state: 'committed', committedTo: 't1', chain: [] } },
    });
    expect(reservedFor(committed, 'me', 'chair')).toBe(0);
  });
});

describe('contingencies', () => {
  const capsule = {
    contingencies: [{ id: 'r1', when: { key: 'gate.open', equals: false }, then: { note: 'Gate closed' } }],
  } as unknown as MissionCapsule;

  it('fires on the newest held value, not on any historic one', () => {
    const closed = stateWith({ capsule, observations: { 'gate.open': [obs('gate.open', false, 10)] } });
    expect(activeRules(closed, 20).map((r) => r.id)).toEqual(['r1']);
    const reopened = stateWith({ capsule, observations: { 'gate.open': [obs('gate.open', false, 10), obs('gate.open', true, 15)] } });
    expect(activeRules(reopened, 20)).toEqual([]);
  });

  it('ignores an expired observation', () => {
    const state = stateWith({ capsule, observations: { 'gate.open': [obs('gate.open', false, 10, 5)] } });
    expect(heldValue(state, 'gate.open', 14)).toBe(false);
    expect(heldValue(state, 'gate.open', 16)).toBeUndefined();
    expect(activeRules(state, 16)).toEqual([]);
  });

  it('breaks a same-instant tie the same way regardless of arrival order', () => {
    const one = obs('k', 1, 10, 0, 'a');
    const two = obs('k', 2, 10, 0, 'b');
    const v = (list: Observation[]) => heldValue(stateWith({ observations: { k: list } }), 'k', 10);
    expect(v([one, two])).toBe(v([two, one]));
  });

  it('picks one spawner per group regardless of membership order', () => {
    expect(spawnerFor('r1', ['a', 'b', 'c'])).toBe(spawnerFor('r1', ['c', 'a', 'b']));
    expect(spawnerFor('r1', [])).toBeUndefined();
  });
});
