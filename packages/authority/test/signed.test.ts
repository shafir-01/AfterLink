import { describe, expect, it } from 'vitest';
import { Author, EventLog, createEvent, generateKeys, verifyEvent, type KeyPair } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventBodies, MissionCapsule, TeamId } from '@afterlink/protocol';
import { canCommit, conservation, deriveTokens } from '../src/index.ts';
import { ACCESS, Device, ISSUER, capsule as fixture, derive, stateOf } from './helpers.ts';

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

function signedCommit(keys: KeyPair, mission: string, seq: number, prev: AnyEvent, tokens: string[], taskId: string, lamport: number) {
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

  it('disputes a key forked across a partition, the same way on every replica', () => {
    const m = mission();
    const left = m.log();
    const right = m.log();
    const warm = new Author(m.access, left).emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    right.ingest(warm);

    left.ingest(signedCommit(m.access, m.capsule.id, 2, warm, [CHAIR], 'left', warm.lamport + 1));
    right.ingest(signedCommit(m.access, m.capsule.id, 2, warm, [CHAIR], 'right', warm.lamport + 1));
    expect(m.derive(left).violations).toEqual([]);
    expect(m.derive(left).tokens[CHAIR]).toMatchObject({ state: 'committed', committedTo: 'left' });
    expect(m.derive(right).tokens[CHAIR]).toMatchObject({ state: 'committed', committedTo: 'right' });

    const merged = m.log();
    merged.ingestMany([...right.all(), ...left.all()]);
    sync(left, right);
    expect(left.forks()).toHaveLength(1);

    const view = m.derive(left);
    expect(m.derive(right)).toEqual(view);
    expect(m.derive(merged)).toEqual(view);
    expect(view.violations).toHaveLength(1);
    expect(view.violations[0]).toMatchObject({ kind: 'token-fork', severity: 'violation', tokenId: CHAIR });
    expect(view.tokens[CHAIR]).toMatchObject({ state: 'disputed', holder: null });
  });

  it('denies a backdated reclaim twice over: the log refuses it, and the ledger would too', () => {
    const m = mission();
    const log = m.log();
    const offer = new Author(m.access, log).emit('right.offered', { transfer: 'x', tokens: [CHAIR], to: m.medics.publicKey });
    const reclaim = signedCommit(m.access, m.capsule.id, 2, offer, [CHAIR], 'mine-after-all', 0);
    expect(verifyEvent(reclaim)).toEqual({ ok: true });
    expect(log.ingest(reclaim)).toBe('invalid');

    const { tokens, violations } = deriveTokens(m.capsule, [...log.all(), reclaim], m.custodians);
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: m.medics.publicKey });
    expect(violations[0]).toMatchObject({ kind: 'token-fork', tokenId: CHAIR });
    expect(violations[0]!.events).toEqual([offer.id, reclaim.id]);
  });

  it('survives junk bodies even if something other than the log hands them over', () => {
    const access = new Device(ACCESS);
    const issuer = new Device(ISSUER);
    const unchecked = (x: unknown) => x as never;
    access.emit('right.committed', unchecked({ tokens: 5, taskId: 't' }));
    access.emit('right.offered', unchecked({ transfer: 'x', tokens: null, to: 7 }));
    access.emit('right.accepted', unchecked({}));
    access.emit('task.released', unchecked({}));
    access.emit('task.created', unchecked({ spec: null }));
    issuer.emit('mission.issued', unchecked({}));
    issuer.emit('conflict.resolved', unchecked({ conflictId: 1, tokenHolder: 'nonsense' }));

    const derived = derive([...access.all(), ...issuer.all()]);
    expect(derived.tokens[CHAIR]).toMatchObject({ state: 'held', holder: ACCESS });
    expect(conservation(stateOf(derived)).every((r) => r.ok)).toBe(true);
  });

  it('takes a real genesis as the head of each chain, and a holder may spend without naming it', () => {
    const m = mission();
    const log = m.log();
    const genesis = new Author(m.issuer, log).emit('mission.issued', { capsule: m.capsule });
    expect(m.derive(log).tokens[CHAIR]!.chain).toEqual([genesis.id]);
    new Author(m.access, log).emit('right.committed', { tokens: [CHAIR], taskId: 'carry' });
    expect(m.derive(log).tokens[CHAIR]).toMatchObject({ state: 'committed', committedTo: 'carry' });
  });

  it('frees a disputed token only on a ruling signed with the real issuer key', () => {
    const m = mission();
    const log = m.log();
    const warm = new Author(m.access, log).emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    log.ingest(signedCommit(m.access, m.capsule.id, 2, warm, [CHAIR], 'left', 3));
    log.ingest(signedCommit(m.access, m.capsule.id, 2, warm, [CHAIR], 'right', 3));
    const conflict = m.derive(log).violations[0]!;
    const body = { conflictId: conflict.id, resolution: 'Checked.', keep: [], tokenHolder: { tokenId: CHAIR, holder: m.medics.publicKey } } as EventBodies['conflict.resolved'];

    new Author(m.supply, log).emit('conflict.resolved', body);
    expect(m.derive(log).tokens[CHAIR]).toMatchObject({ state: 'disputed' });

    new Author(m.issuer, log).emit('conflict.resolved', body);
    const state = stateOf(m.derive(log));
    expect(state.tokens[CHAIR]).toMatchObject({ state: 'held', holder: m.medics.publicKey });
    expect(canCommit({ ...state, actors: {} }, m.medics.publicKey, [CHAIR])).toEqual({ ok: true });
  });
});
