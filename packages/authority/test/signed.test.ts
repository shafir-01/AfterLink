import { describe, expect, it } from 'vitest';
import { Author, EventLog, createEvent, generateKeys, verifyEvent, type KeyPair } from '@afterlink/protocol';
import type { ActorId, AnyEvent, MissionCapsule, TeamId } from '@afterlink/protocol';
import { canCommit, conservation, deriveTokens } from '../src/index.ts';
import { capsule as fixture, stateOf } from './helpers.ts';

const CHAIR = 'evac-chair#1';

/** Real keys and signatures, carried through a real EventLog on each replica. */
function mission() {
  const issuer = generateKeys();
  const access = generateKeys();
  const medics = generateKeys();
  const supply = generateKeys();
  const capsule: MissionCapsule = { ...fixture, issuer: issuer.publicKey };
  const custodians: Record<TeamId, ActorId> = {
    access: access.publicKey,
    medics: medics.publicKey,
    supply: supply.publicKey,
  };
  const log = () => new EventLog(capsule.id);
  const derive = (l: EventLog) => deriveTokens(capsule, l.all(), custodians);
  return { issuer, access, medics, supply, capsule, custodians, log, derive };
}

function sync(...logs: EventLog[]): void {
  const all = logs.flatMap((l) => l.all());
  for (const l of logs) l.ingestMany(all);
}

function twinEvent(keys: KeyPair, mission: string, seq: number, prev: AnyEvent, tokens: string[], taskId: string, lamport: number) {
  return createEvent({
    keys,
    mission,
    seq,
    prev: prev.id,
    parents: [],
    lamport,
    wall: 0,
    type: 'right.committed',
    body: { tokens, taskId },
  });
}

describe('through the real log', () => {
  it('walks a transfer across signed replicas', () => {
    const m = mission();
    const accessLog = m.log();
    const medicsLog = m.log();
    new Author(m.access, accessLog).emit('right.offered', { transfer: 'x', tokens: [CHAIR], to: m.medics.publicKey });
    sync(accessLog, medicsLog);
    new Author(m.medics, medicsLog).emit('right.accepted', { transfer: 'x' });

    expect(m.derive(accessLog).tokens[CHAIR]).toMatchObject({ state: 'in-transit', holder: null });
    expect(m.derive(medicsLog).tokens[CHAIR]).toMatchObject({ state: 'held', holder: m.medics.publicKey });
    sync(accessLog, medicsLog);
    expect(m.derive(accessLog)).toEqual(m.derive(medicsLog));
    expect(m.derive(accessLog).tokens[CHAIR]).toMatchObject({ state: 'held', holder: m.medics.publicKey, holderTeam: 'medics' });
  });

  it('reports a key forked across a partition the same way on every replica', () => {
    const m = mission();
    const left = m.log();
    const right = m.log();
    const author = new Author(m.access, left);
    const warm = author.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    right.ingest(warm);

    left.ingest(twinEvent(m.access, m.capsule.id, 2, warm, [CHAIR], 'left', warm.lamport + 1));
    right.ingest(twinEvent(m.access, m.capsule.id, 2, warm, [CHAIR], 'right', warm.lamport + 1));
    expect(m.derive(left).violations).toEqual([]);
    expect(m.derive(right).violations).toEqual([]);

    const merged = m.log();
    merged.ingestMany([...right.all(), ...left.all()]);
    sync(left, right);
    expect(left.forks()).toHaveLength(1);

    const view = m.derive(left);
    expect(m.derive(right)).toEqual(view);
    expect(m.derive(merged)).toEqual(view);
    expect(view.violations).toHaveLength(1);
    expect(view.violations[0]).toMatchObject({ kind: 'token-fork', severity: 'violation', tokenId: CHAIR });
    expect(view.tokens[CHAIR]!.state).toBe('committed');
    expect(view.tokens[CHAIR]!.chain).toEqual([view.violations[0]!.events[0]]);
  });

  it('denies a backdated reclaim even though the log accepts the event', () => {
    const m = mission();
    const log = m.log();
    const offer = new Author(m.access, log).emit('right.offered', { transfer: 'x', tokens: [CHAIR], to: m.medics.publicKey });
    const reclaim = twinEvent(m.access, m.capsule.id, 2, offer, [CHAIR], 'mine-after-all', 0);
    expect(verifyEvent(reclaim)).toEqual({ ok: true });
    expect(log.ingest(reclaim)).toBe('added');

    const { tokens, violations } = m.derive(log);
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: m.medics.publicKey });
    expect(violations[0]).toMatchObject({ kind: 'token-fork', tokenId: CHAIR });
    expect(violations[0]!.events).toEqual([offer.id, reclaim.id]);
  });

  it('survives malformed bodies that signatures alone do not rule out', () => {
    const m = mission();
    const log = m.log();
    const author = new Author(m.access, log);
    const issuer = new Author(m.issuer, log);
    const unchecked = (x: unknown) => x as never;
    author.emit('right.committed', unchecked({ tokens: 5, taskId: 't' }));
    author.emit('right.offered', unchecked({ transfer: 'x', tokens: null, to: 7 }));
    author.emit('right.accepted', unchecked({}));
    issuer.emit('mission.issued', unchecked({}));

    const derived = m.derive(log);
    expect(derived.tokens[CHAIR]).toMatchObject({ state: 'held', holder: m.access.publicKey });
    expect(conservation(stateOf(derived)).every((r) => r.ok)).toBe(true);
  });

  it('takes a real genesis as the head of each chain', () => {
    const m = mission();
    const log = m.log();
    const genesis = new Author(m.issuer, log).emit('mission.issued', { capsule: m.capsule });
    expect(m.derive(log).tokens[CHAIR]!.chain).toEqual([genesis.id]);
    expect(canCommit(stateOf(m.derive(log)), m.access.publicKey, [CHAIR])).toMatchObject({ ok: false });
  });
});
