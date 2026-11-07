import { describe, expect, it } from 'vitest';
import type { MissionState, Observation, TaskRecord, TaskSpec } from '@afterlink/protocol';
import { isFinished, isMine, transferIdFor, transferRequests, TRANSFER_REQUEST_KEY } from '../src/rules.ts';

const spec: TaskSpec = {
  id: 't1',
  kind: 'assist',
  title: 'Help',
  brief: 'Go',
  objective: 'o1',
  priority: 2,
  location: { x: 1, y: 2 },
  locationName: 'Gate',
  requires: [],
  needs: [{ resource: 'chair', count: 1 }],
  dependsOn: [],
  reversible: true,
};

const request = (value: Observation['value']): Observation => ({
  key: TRANSFER_REQUEST_KEY,
  value,
  subject: 't1',
  observedAt: 1,
  validForMs: 0,
  source: 'a',
});

const record = (p: Partial<TaskRecord>): TaskRecord => ({
  spec,
  status: 'open',
  source: { kind: 'human' },
  decisions: [],
  createdBy: 'a',
  updatedAt: 0,
  ...p,
});

describe('transfer requests', () => {
  const value = { taskId: 't1', resource: 'chair', count: 1, from: 'holder' };

  it('reads well formed requests and ignores anything else under the key', () => {
    const state = {
      observations: { [TRANSFER_REQUEST_KEY]: [request(value), request('noise'), request(null)] },
    } as unknown as MissionState;
    expect(transferRequests(state)).toEqual([{ by: 'a', ...value }]);
  });

  it('names the same transfer for the same request on every replica', () => {
    const r = { by: 'a', ...value };
    expect(transferIdFor(r)).toBe(transferIdFor({ ...r }));
    expect(transferIdFor(r)).not.toBe(transferIdFor({ ...r, taskId: 't2' }));
  });
});

describe('task reading', () => {
  it('treats done work as finished even when its record is in conflict', () => {
    expect(isFinished(record({ status: 'completed' }))).toBe(true);
    expect(isFinished(record({ status: 'cancelled' }))).toBe(true);
    expect(isFinished(record({ status: 'conflicted', evidence: 'done' }))).toBe(true);
    expect(isFinished(record({ status: 'conflicted' }))).toBe(false);
    expect(isFinished(record({ status: 'accepted' }))).toBe(false);
  });

  it('counts both owners and those covering as carrying the task', () => {
    expect(isMine(record({ owner: 'me' }), 'me')).toBe(true);
    expect(isMine(record({ owner: 'other', coveredBy: ['me'] }), 'me')).toBe(true);
    expect(isMine(record({ owner: 'other' }), 'me')).toBe(false);
  });
});
