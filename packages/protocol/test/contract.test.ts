import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  createEvent,
  EventLog,
  MAX_EVENT_BYTES,
  MAX_GENESIS_BYTES,
  MAX_PARENTS,
  verifyEvent,
  type AnyEvent,
  type DecisionRecord,
  type EventBodies,
  type EventType,
  type MissionCapsule,
  type TaskSpec,
} from '../src/index.ts';
import { MISSION, seededKeys } from './helpers.ts';

const keys = seededKeys(30);

const spec: TaskSpec = {
  id: 't',
  kind: 'first-aid',
  title: 'Title',
  brief: 'Brief',
  objective: 'o',
  priority: 1,
  location: { x: 1, y: 2 },
  locationName: 'Gate',
  requires: ['first-aid'],
  needs: [{ resource: 'chair', count: 1 }],
  dependsOn: [],
  reversible: true,
};

const decision: DecisionRecord = {
  id: 'd',
  actor: keys.publicKey,
  taskId: 't',
  outcome: 'ACCEPTED',
  reason: 'Why',
  policy: 'rule',
  reachable: [],
  horizon: { [keys.publicKey]: 3 },
  inputs: [{ key: 'k', ageMs: 5, state: 'confirmed' }],
};

const capsule: MissionCapsule = {
  v: 1,
  id: MISSION,
  version: 1,
  name: 'Name',
  objective: 'Objective',
  objectives: [{ id: 'o', title: 'Title', rank: 1 }],
  teams: [{ id: 'medics', name: 'Medics', capabilities: ['first-aid'], home: { x: 0, y: 0 } }],
  resources: [{ id: 'chair', name: 'Chair', tokens: [{ id: 'chair#1', holderTeam: 'medics' }] }],
  tasks: [spec],
  contingencies: [{ id: 'c', when: { key: 'k', equals: true }, then: { note: 'Note', spawn: [spec] } }],
  fallback: { coverAfterMs: 1000, coverMaxPriority: 2, humanApprovalKinds: [] },
  issuer: keys.publicKey,
  issuedAt: 1,
};

/** Keyed by EventType, so adding a type to the contract without covering it here fails to compile. */
const bodies: { [K in EventType]: EventBodies[K] } = {
  'mission.issued': { capsule },
  'actor.joined': {
    team: 'medics',
    name: 'Name',
    credential: { mission: MISSION, actor: keys.publicKey, team: 'medics', custodian: true, sig: 's' },
  },
  'task.created': { spec, source: { kind: 'human' } },
  'task.claimed': { taskId: 't', decision },
  'task.accepted': { taskId: 't', via: 'tap' },
  'task.completed': { taskId: 't', evidence: 'Done', via: 'voice' },
  'task.deferred': { taskId: 't', decision },
  'task.refused': { taskId: 't', decision: { ...decision, outcome: 'REFUSED', refusal: 'NO_RIGHT', next: ['ESCALATE'] } },
  'task.released': { taskId: 't', reason: 'Why' },
  'task.covered': { taskId: 't', decision },
  'right.committed': { tokens: ['chair#1'], taskId: 't' },
  'right.offered': { transfer: 'x', tokens: ['chair#1'], to: keys.publicKey },
  'right.accepted': { transfer: 'x' },
  'right.declined': { transfer: 'x' },
  'observation.recorded': {
    observation: { key: 'k', value: { any: ['json', null] }, subject: 's', observedAt: 1, validForMs: 0, source: keys.publicKey },
  },
  'link.changed': { peer: keys.publicKey, state: 'open', transport: 'webrtc' },
  'ferry.received': { packetId: 'p', from: keys.publicKey, events: 2, newEvents: 1 },
  'conflict.resolved': { conflictId: 'c', resolution: 'Kept', keep: [] },
};

const types = Object.keys(bodies) as EventType[];

function signed(type: string, body: unknown, parents: string[] = []): AnyEvent {
  return createEvent({
    keys,
    mission: MISSION,
    seq: 1,
    prev: null,
    parents,
    lamport: 1,
    wall: 1,
    type: type as 'task.released',
    body: body as never,
  }) as unknown as AnyEvent;
}

const refused = (e: AnyEvent) => {
  expect(verifyEvent(e).ok).toBe(false);
  expect(new EventLog(MISSION).ingest(e)).toBe('invalid');
};

describe('event types', () => {
  it.each(types)('accepts a well formed %s', (type) => {
    const e = signed(type, bodies[type]);
    expect(verifyEvent(e)).toEqual({ ok: true });
    expect(new EventLog(MISSION).ingest(e)).toBe('added');
  });

  it.each(['right.seized', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])('refuses the type %s', (type) => {
    refused(signed(type, { transfer: 'x' }));
  });
});

describe('event bodies', () => {
  const required = types.flatMap((type) => Object.keys(bodies[type]).map((field) => [type, field] as const));

  it.each(required)('%s requires %s', (type, field) => {
    const { [field as never]: _, ...rest } = bodies[type] as Record<string, unknown>;
    refused(signed(type, rest));
    refused(signed(type, { ...bodies[type], [field]: { junk: 5 } }));
  });

  it('checks nested fields that reducers read without looking', () => {
    const task = (patch: object) => signed('task.created', { spec: { ...spec, ...patch }, source: { kind: 'human' } });
    const claim = (patch: object) => signed('task.claimed', { taskId: 't', decision: { ...decision, ...patch } });
    const issued = (patch: object) => signed('mission.issued', { capsule: { ...capsule, ...patch } });
    for (const junk of [
      task({ needs: 5 }),
      task({ needs: [{ resource: 'chair' }] }),
      task({ requires: 'first-aid' }),
      task({ location: { x: 1 } }),
      task({ title: { a: 1 } }),
      claim({ inputs: null }),
      claim({ horizon: { a: 'high' } }),
      claim({ reachable: [1] }),
      claim({ tokens: 'chair#1' }),
      claim({ candidates: [{ actor: 'a' }] }),
      issued({ tasks: [{ id: 'x' }] }),
      issued({ resources: [{ id: 'r', name: 'n', tokens: 5 }] }),
      issued({ teams: null }),
      issued({ fallback: {} }),
      issued({ contingencies: [{ id: 'c', when: {}, then: { note: 'n' } }] }),
      signed('right.committed', { tokens: [1], taskId: 't' }),
      signed('right.committed', { tokens: null, taskId: 't' }),
      signed('conflict.resolved', { conflictId: 'c', resolution: 'r', keep: 'all' }),
      signed('task.created', { spec, source: { kind: 'human', ref: 5 } }),
    ]) {
      refused(junk);
    }
  });

  it('passes unknown extra fields, so additive contract changes keep working', () => {
    expect(verifyEvent(signed('task.claimed', { taskId: 't', decision, tokens: ['chair#1'] })).ok).toBe(true);
    const future = { ...spec, zone: 'north', deadlineMs: 5, reliesOn: ['k'] };
    expect(verifyEvent(signed('task.created', { spec: future, source: { kind: 'human', ref: 'r' } })).ok).toBe(true);
  });
});

describe('size limits', () => {
  const sized = (bytes: number) => {
    const unsigned = (reason: string) => {
      const { id, sig, ...rest } = signed('task.released', { taskId: 't', reason });
      return utf8Length(canonicalize(rest));
    };
    return signed('task.released', { taskId: 't', reason: 'x'.repeat(bytes - unsigned('')) });
  };
  const utf8Length = (text: string) => new TextEncoder().encode(text).length;

  it('accepts an event at the limit and refuses one byte more', () => {
    expect(verifyEvent(sized(MAX_EVENT_BYTES))).toEqual({ ok: true });
    refused(sized(MAX_EVENT_BYTES + 1));
  });

  it('measures bytes, not characters', () => {
    refused(signed('task.released', { taskId: 't', reason: 'é'.repeat(MAX_EVENT_BYTES / 2 + 1) }));
  });

  it('allows a large capsule, up to its own limit', () => {
    const tasks = (count: number) => Array.from({ length: count }, (_, i) => ({ ...spec, id: `t${i}` }));
    const size = (e: AnyEvent) => utf8Length(canonicalize(e));
    const big = signed('mission.issued', { capsule: { ...capsule, tasks: tasks(200) } });
    expect(size(big)).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(verifyEvent(big)).toEqual({ ok: true });
    refused(signed('mission.issued', { capsule: { ...capsule, tasks: tasks(1500) } }));
    expect(MAX_GENESIS_BYTES).toBeLessThan(size(signed('mission.issued', { capsule: { ...capsule, tasks: tasks(1500) } })));
  });

  it('bounds the parents list', () => {
    const parents = (count: number) => Array.from({ length: count }, (_, i) => `p${i}`);
    expect(verifyEvent(signed('right.accepted', { transfer: 'x' }, parents(MAX_PARENTS)))).toEqual({ ok: true });
    refused(signed('right.accepted', { transfer: 'x' }, parents(MAX_PARENTS + 1)));
  });

  it('refuses hostile nesting inside a free JSON field', () => {
    let value: unknown = 1;
    for (let i = 0; i < 40; i++) value = [value];
    const { id, sig, ...e } = signed('observation.recorded', bodies['observation.recorded']);
    const body = { observation: { ...bodies['observation.recorded'].observation, value } };
    expect(verifyEvent({ ...e, id, sig, body } as unknown as AnyEvent).ok).toBe(false);
  });
});
