import { describe, expect, it } from 'vitest';
import { createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, DecisionRecord, MissionRecord } from '@afterlink/protocol';
import { reduce } from '@afterlink/mission';
import { buildMissionRecord } from '@afterlink/reconcile';
import { conservationWords, derive, headline } from '../../apps/web/src/debrief/derive.ts';
import { buildWorld, type Keys, type World } from './explorer.ts';

function makeLog(world: World) {
  const events: AnyEvent[] = [world.genesis];
  const heads = new Map<string, AnyEvent>();
  const sign = (k: Keys, type: AnyEvent['type'], body: unknown, wall = 2000): AnyEvent => {
    const prev = heads.get(k.publicKey);
    const lamport = Math.max(...events.map((e) => e.lamport)) + 1;
    const e = createEvent({
      keys: k,
      mission: world.capsule.id,
      seq: (prev?.seq ?? 0) + 1,
      prev: prev?.id ?? null,
      parents: [world.genesis.id],
      lamport,
      wall,
      type,
      body: body as never,
    }) as AnyEvent;
    events.push(e);
    heads.set(k.publicKey, e);
    return e;
  };
  return { events, sign };
}

const refusal = (actor: string, taskId: string, code: 'NO_RIGHT' | 'STALE_KNOWLEDGE'): DecisionRecord => ({
  id: `${actor}${taskId}`, actor, taskId, outcome: 'REFUSED', refusal: code, reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [],
});

function joined(world: World, sign: (k: Keys, t: AnyEvent['type'], b: unknown) => AnyEvent) {
  world.keys.forEach((k, i) => {
    const r = world.roster[i]!;
    sign(k, 'actor.joined', { team: r.team, name: r.name, credential: r.credential });
  });
}

describe('the debrief says only what the record supports', () => {
  it('a refusal HQ watched live is not reported as a refusal while HQ was blind', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    sign(world.keys[0]!, 'task.refused', { taskId: 'job-a', decision: refusal(world.keys[0]!.publicKey, 'job-a', 'NO_RIGHT') });
    const state = reduce(events, world.roster);
    const record = buildMissionRecord({ events, state, hqSeen: events.map((e) => e.id) });
    expect(headline(record as unknown as MissionRecord)).not.toMatch(/blind/i);
  });

  it('a refusal with no competing use of the token is not a prevented duplicate', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    sign(world.keys[1]!, 'task.refused', { taskId: 'job-a', decision: refusal(world.keys[1]!.publicKey, 'job-a', 'NO_RIGHT') });
    const state = reduce(events, world.roster);
    const record = buildMissionRecord({ events, state, hqSeen: [] });
    expect(record.duplicatesPrevented).toBe(0);
  });

  it('the same refusal repeated by two teams is not counted as two prevented duplicates of one token', () => {
    const world = buildWorld(3, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    sign(world.keys[0]!, 'right.committed', { tokens: ['kit#0'], taskId: 'job-b' });
    sign(world.keys[1]!, 'task.refused', { taskId: 'job-a', decision: refusal(world.keys[1]!.publicKey, 'job-a', 'NO_RIGHT') });
    sign(world.keys[2]!, 'task.refused', { taskId: 'job-a', decision: refusal(world.keys[2]!.publicKey, 'job-a', 'NO_RIGHT') });
    const state = reduce(events, world.roster);
    const record = buildMissionRecord({ events, state, hqSeen: [] });
    expect(record.duplicatesPrevented).toBeLessThanOrEqual(1);
  });

  it('"promised once" is never printed beside a real double commit', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    const offer = sign(world.keys[0]!, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: world.keys[1]!.publicKey });
    sign(world.keys[1]!, 'right.accepted', { transfer: 'x' });
    sign(world.keys[1]!, 'right.committed', { tokens: ['kit#0'], taskId: 'job-b' });
    const fork = createEvent({ keys: world.keys[0]!, mission: world.capsule.id, seq: offer.seq, prev: offer.prev, parents: [world.genesis.id], lamport: offer.lamport, wall: 1, type: 'right.committed', body: { tokens: ['kit#0'], taskId: 'job-a' } }) as AnyEvent;
    events.push(fork);
    const state = reduce(events, world.roster);
    const record = buildMissionRecord({ events, state, hqSeen: [] });
    expect(record.conflicts.some((c) => c.severity === 'violation')).toBe(true);
    const row = record.conservation.find((c) => c.resource === 'kit')!;
    expect(conservationWords(row, 'Kit').text).not.toMatch(/once|none twice/);
  });

  it('an episode counts only work that was really inside it', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    const state = reduce(events, world.roster);
    const record = buildMissionRecord({ events, state, hqSeen: events.map((e) => e.id) });
    expect(record.doneWhileHqBlind).toBe(0);
    expect(record.episodes).toEqual([]);
  });
});

describe('the debrief survives a hostile or incomplete history', () => {
  it('a forged join from a stranger does not blank the debrief', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    sign(world.keys[0]!, 'task.claimed', { taskId: 'job-a', decision: { id: 'd', actor: world.keys[0]!.publicKey, taskId: 'job-a', outcome: 'ACCEPTED', reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [] } });
    sign(world.keys[0]!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
    const stranger = generateKeys();
    events.push(createEvent({ keys: stranger, mission: world.capsule.id, seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'actor.joined', body: { team: 'team0', name: 'Fake', credential: world.roster[0]!.credential } }) as AnyEvent);
    const d = derive(events, [], []);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.record.doneWhileHqBlind).toBe(1);
      expect(d.record.conservation.length).toBeGreaterThan(0);
    }
  });

  it('a team whose join never arrived does not blank the debrief', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    sign(world.keys[0]!, 'actor.joined', { team: world.roster[0]!.team, name: world.roster[0]!.name, credential: world.roster[0]!.credential });
    sign(world.keys[0]!, 'task.claimed', { taskId: 'job-a', decision: { id: 'd', actor: world.keys[0]!.publicKey, taskId: 'job-a', outcome: 'ACCEPTED', reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [] } });
    sign(world.keys[0]!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
    const d = derive(events, [], []);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.record.doneWhileHqBlind).toBe(1);
      expect(d.record.conservation.length).toBeGreaterThan(0);
    }
  });

  it('a device that joined twice does not blank the debrief', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = makeLog(world);
    joined(world, sign);
    sign(world.keys[0]!, 'task.claimed', { taskId: 'job-a', decision: { id: 'd', actor: world.keys[0]!.publicKey, taskId: 'job-a', outcome: 'ACCEPTED', reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [] } });
    sign(world.keys[0]!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
    const r = world.roster[0]!;
    events.push(createEvent({ keys: world.keys[0]!, mission: world.capsule.id, seq: 1, prev: null, parents: [], lamport: 2, wall: 5, type: 'actor.joined', body: { team: r.team, name: r.name, credential: r.credential } }) as AnyEvent);
    const d = derive(events, [], []);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.record.doneWhileHqBlind).toBe(1);
      expect(d.record.conservation.length).toBeGreaterThan(0);
    }
  });
});
