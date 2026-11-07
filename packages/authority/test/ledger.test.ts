import { describe, expect, it } from 'vitest';
import type { AnyEvent, MissionState, TaskRecord } from '@afterlink/protocol';
import { canCommit, canOffer, canPerform, conservation, deriveTokens, findTokens, pendingTransfers } from '../src/index.ts';
import { causalOrder } from '../src/ledger.ts';
import {
  ACCESS,
  Device,
  FACILITIES,
  ISSUER,
  MEDICS,
  SUPPLY,
  capsule,
  crew,
  derive,
  exchange,
  stateOf,
  task,
  token,
} from './helpers.ts';

const CHAIR = 'evac-chair#1';

describe('issue', () => {
  it('starts every token with its team custodian', () => {
    const { tokens, violations } = derive([]);
    expect(Object.keys(tokens)).toHaveLength(6);
    expect(tokens[CHAIR]).toMatchObject({ holder: ACCESS, holderTeam: 'access', state: 'held', resource: 'evac-chair' });
    expect(tokens['cart#3']).toMatchObject({ holder: FACILITIES, holderTeam: 'facilities' });
    expect(violations).toEqual([]);
  });

  it('leaves a token with no holder when its team has no custodian', () => {
    const { tokens } = deriveTokens(capsule, [], { medics: MEDICS });
    expect(tokens[CHAIR]).toMatchObject({ holder: null, state: 'held' });
    expect(canCommit(stateOf({ tokens, violations: [] }), ACCESS, [CHAIR])).toMatchObject({ ok: false, code: 'NO_RIGHT' });
  });

  it('starts each chain at the issuing event', () => {
    const issuer = new Device(ISSUER);
    const genesis = issuer.emit('mission.issued', { capsule });
    expect(token(derive(issuer.all()), CHAIR).chain).toEqual([genesis.id]);
  });

  it('does not take a chain head from anyone but the issuer', () => {
    const impostor = new Device(ACCESS);
    impostor.emit('mission.issued', { capsule });
    expect(token(derive(impostor.all()), CHAIR).chain).toEqual([]);
  });
});

describe('commit', () => {
  it('lets the holder commit, once', () => {
    const access = new Device(ACCESS);
    const commit = access.commit([CHAIR], 'carry');
    const derived = access.derived();
    expect(token(derived, CHAIR)).toMatchObject({ state: 'committed', holder: ACCESS, committedTo: 'carry', chain: [commit.id] });
    expect(derived.violations).toEqual([]);
  });

  it('ignores a commit by someone who never held the token, and reports it', () => {
    const medics = new Device(MEDICS);
    const commit = medics.commit([CHAIR], 'grab');
    const { tokens, violations } = medics.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'held', holder: ACCESS });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'forged-event', severity: 'violation', tokenId: CHAIR, events: [commit.id], taskId: 'grab' });
  });

  it('rejects a token the mission never issued', () => {
    const access = new Device(ACCESS);
    const commit = access.commit(['evac-chair#2'], 'carry');
    const { tokens, violations } = access.derived();
    expect(tokens['evac-chair#2']).toBeUndefined();
    expect(violations[0]).toMatchObject({ kind: 'forged-event', tokenId: 'evac-chair#2', events: [commit.id] });
  });

  it('is all or nothing across the tokens in one event', () => {
    const medics = new Device(MEDICS);
    medics.commit(['aed#1', CHAIR], 'mixed');
    const { tokens } = medics.derived();
    expect(tokens['aed#1']).toMatchObject({ state: 'held', holder: MEDICS });
    expect(tokens[CHAIR]).toMatchObject({ state: 'held', holder: ACCESS });
  });

  it('counts a token named twice in one event once', () => {
    const access = new Device(ACCESS);
    const commit = access.commit([CHAIR, CHAIR], 'carry');
    expect(token(access.derived(), CHAIR).chain).toEqual([commit.id]);
  });
});

describe('transfer', () => {
  it('locks a token in transit and takes it from the sender', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const state = access.state();
    expect(state.tokens[CHAIR]).toMatchObject({ state: 'in-transit', holder: null, holderTeam: 'access', transfer: 'x', from: ACCESS, to: MEDICS });
    expect(findTokens(state, ACCESS, 'evac-chair', 1)).toEqual([]);
    expect(findTokens(state, MEDICS, 'evac-chair', 1)).toEqual([]);
  });

  it('moves the token only when the recipient accepts', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    const offer = access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    expect(pendingTransfers(medics!.state(), MEDICS)).toEqual([{ transfer: 'x', tokens: [CHAIR], from: ACCESS }]);
    const accept = medics!.accept('x');

    const held = token(medics!.derived(), CHAIR);
    expect(held).toMatchObject({ state: 'held', holder: MEDICS, holderTeam: 'medics', chain: [offer.id, accept.id] });
    expect(held).not.toHaveProperty('transfer');
    expect(held).not.toHaveProperty('to');
    expect(pendingTransfers(medics!.state(), MEDICS)).toEqual([]);
  });

  it('takes the holder team from a join event for a non-custodian recipient', () => {
    const volunteer = new Device('actor-volunteer');
    volunteer.emit('actor.joined', {
      team: 'supply',
      name: 'Kim',
      credential: { mission: capsule.id, actor: 'actor-volunteer', team: 'supply', custodian: false, sig: 'x' },
    });
    const access = new Device(ACCESS);
    access.offer([CHAIR], 'actor-volunteer', 'x');
    exchange(volunteer, access);
    volunteer.accept('x');
    expect(token(volunteer.derived(), CHAIR)).toMatchObject({ holder: 'actor-volunteer', holderTeam: 'supply' });
  });

  it('returns the token to the sender on decline', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.decline('x');
    exchange(access!, medics!);

    expect(token(access!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: ACCESS, holderTeam: 'access' });
    access!.commit([CHAIR], 'carry');
    expect(token(access!.derived(), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'carry' });
    expect(access!.derived().violations).toEqual([]);
  });

  it('moves every token of a multi-token offer together', () => {
    const { [SUPPLY]: supply, [MEDICS]: medics } = crew();
    supply!.offer(['cart#1', 'cart#2'], MEDICS, 'x');
    exchange(supply!, medics!);
    expect(pendingTransfers(medics!.state(), MEDICS)).toEqual([{ transfer: 'x', tokens: ['cart#1', 'cart#2'], from: SUPPLY }]);
    medics!.accept('x');
    expect(findTokens(medics!.state(), MEDICS, 'cart', 5)).toEqual(['cart#1', 'cart#2']);
  });

  it('never refunds a lost acknowledgement', () => {
    const { [ACCESS]: access, [MEDICS]: medics, [SUPPLY]: supply } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.accept('x');
    for (let i = 0; i < 20; i += 1) {
      supply!.emit('task.accepted', { taskId: `t${i}`, via: 'tap' });
      exchange(supply!, access!);
    }
    expect(token(access!.derived(), CHAIR)).toMatchObject({ state: 'in-transit', holder: null });
    expect(canCommit(access!.state(), ACCESS, [CHAIR])).toMatchObject({ ok: false, code: 'TOKEN_IN_TRANSIT' });
    expect(token(medics!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
  });

  it('treats a repeated identical answer as harmless', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    const first = medics!.accept('x');
    medics!.accept('x');
    const derived = medics!.derived();
    expect(derived.violations).toEqual([]);
    expect(token(derived, CHAIR).chain).toContain(first.id);
    expect(token(derived, CHAIR).chain).toHaveLength(2);
  });

  it('ignores an answer whose offer has not arrived yet', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    const accept = medics!.accept('x');
    const derived = derive([accept]);
    expect(token(derived, CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
    expect(derived.violations).toEqual([]);
  });

  it('lets a right travel through several hands', () => {
    const { [ACCESS]: access, [MEDICS]: medics, [SUPPLY]: supply } = crew();
    access!.offer([CHAIR], MEDICS, 'a');
    exchange(access!, medics!);
    medics!.accept('a');
    medics!.offer([CHAIR], SUPPLY, 'b');
    exchange(medics!, supply!);
    supply!.accept('b');
    supply!.offer([CHAIR], ACCESS, 'c');
    exchange(supply!, access!);
    access!.accept('c');
    access!.commit([CHAIR], 'carry');
    const derived = access!.derived();
    expect(token(derived, CHAIR)).toMatchObject({ state: 'committed', holder: ACCESS, committedTo: 'carry' });
    expect(token(derived, CHAIR).chain).toHaveLength(7);
    expect(derived.violations).toEqual([]);
  });
});

describe('the sender can never reclaim alone', () => {
  function offered() {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    return access;
  }

  it('rejects a commit after the offer as a fork', () => {
    const access = offered();
    const reclaim = access.commit([CHAIR], 'mine-after-all');
    const { tokens, violations } = access.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(violations[0]).toMatchObject({ kind: 'token-fork', tokenId: CHAIR, taskId: 'mine-after-all' });
    expect(violations[0]!.events[1]).toBe(reclaim.id);
  });

  it('rejects the sender declining its own offer', () => {
    const access = offered();
    access.decline('x');
    const { tokens, violations } = access.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit' });
    expect(violations[0]).toMatchObject({ kind: 'token-fork', tokenId: CHAIR });
  });

  it('rejects the sender accepting its own offer', () => {
    const access = offered();
    access.accept('x');
    expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'in-transit', to: MEDICS });
  });

  it('is not fooled by a backdated clock on the signer\'s own chain', () => {
    const access = offered();
    const reclaim = access.emit('right.committed', { tokens: [CHAIR], taskId: 'backdated' }, { lamport: 0 });
    const derived = access.derived();
    expect(token(derived, CHAIR)).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(derived.violations[0]).toMatchObject({ kind: 'token-fork' });
    expect(derived.violations[0]!.events).toContain(reclaim.id);
  });
});

describe('answers', () => {
  it('rejects a third party answering, and leaves the transfer open', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const supply = new Device(SUPPLY);
    supply.receive(access.all());
    const forged = supply.accept('x');
    const { tokens, violations } = supply.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(violations[0]).toMatchObject({ kind: 'forged-event', events: [forged.id] });
  });

  it('keeps the first of two opposite answers and reports the other', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    const yes = medics!.accept('x');
    const no = medics!.decline('x');
    const { tokens, violations } = medics!.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'held', holder: MEDICS });
    expect(violations[0]).toMatchObject({ kind: 'token-fork', events: [yes.id, no.id] });
  });
});

describe('transfer ids', () => {
  it('cannot be reused to hijack an open transfer', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const supply = new Device(SUPPLY);
    supply.receive(access.all());
    const hijack = supply.offer(['cart#1'], SUPPLY, 'x');
    const { tokens, violations } = supply.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(tokens['cart#1']).toMatchObject({ state: 'held', holder: SUPPLY });
    expect(violations.flatMap((v) => v.events)).toContain(hijack.id);
  });

  it('are single use even after the transfer closes', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.decline('x');
    exchange(access!, medics!);
    access!.offer([CHAIR], MEDICS, 'x');
    expect(token(access!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
    expect(access!.derived().violations).toHaveLength(1);
  });
});

describe('forks', () => {
  function forkedCommits() {
    const access = new Device(ACCESS);
    const twin = access.clone();
    const a = access.commit([CHAIR], 'a');
    const b = twin.commit([CHAIR], 'b');
    return { a, b, all: [...access.all(), ...twin.all()] as AnyEvent[] };
  }

  it('detects a concurrent commit by a forked holder and keeps the lowest id at equal lamport', () => {
    const { a, b, all } = forkedCommits();
    expect(a.lamport).toBe(b.lamport);
    const [winner, loser] = a.id < b.id ? [a, b] : [b, a];
    const { tokens, violations } = derive(all);
    expect(tokens[CHAIR]).toMatchObject({ state: 'committed', committedTo: winner.body.taskId, chain: [winner.id] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      severity: 'violation',
      kind: 'token-fork',
      tokenId: CHAIR,
      taskId: loser.body.taskId,
      events: [winner.id, loser.id],
      resolved: false,
    });
    expect(violations[0]!.summary).toBe('Access signed two moves of the evacuation chair. The first stands and the other has no effect.');
  });

  it('keeps the lowest lamport', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    const late = twin.commit([CHAIR], 'late');
    const early = access.commit([CHAIR], 'early');
    expect(early.lamport).toBeLessThan(late.lamport);
    const { tokens, violations } = derive([...twin.all(), ...access.all()]);
    expect(tokens[CHAIR]).toMatchObject({ committedTo: 'early' });
    expect(violations[0]!.events).toEqual([early.id, late.id]);
  });

  it('groups a third successor into the same record', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    const triplet = access.clone();
    access.commit([CHAIR], 'a');
    twin.commit([CHAIR], 'b');
    triplet.commit([CHAIR], 'c');
    const { violations } = derive([...access.all(), ...twin.all(), ...triplet.all()]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.events).toHaveLength(3);
  });

  it('voids everything built on the losing branch and folds it into the one record', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    const winner = access.commit([CHAIR], 'won');
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    const loser = twin.offer([CHAIR], MEDICS, 'x');
    const { [MEDICS]: medics, [SUPPLY]: supply } = crew();
    exchange(twin, medics!);
    const accept = medics!.accept('x');
    const onward = medics!.offer([CHAIR], SUPPLY, 'y');
    exchange(medics!, supply!);
    const accept2 = supply!.accept('y');
    const spent = supply!.commit([CHAIR], 'phantom');

    expect(token(supply!.derived(), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'phantom' });

    const merged = derive([...access.all(), ...supply!.all()]);
    expect(token(merged, CHAIR)).toMatchObject({ state: 'committed', holder: ACCESS, committedTo: 'won', chain: [winner.id] });
    expect(merged.violations).toHaveLength(1);
    expect(merged.violations[0]).toMatchObject({ kind: 'token-fork' });
    expect(merged.violations[0]!.events).toEqual([winner.id, loser.id, accept.id, onward.id, accept2.id, spent.id]);
  });

  it('does not accuse an honest recipient over a token that stayed clean in a voided offer', () => {
    const supply = new Device(SUPPLY);
    const twin = supply.clone();
    supply.commit(['cart#1'], 'won');
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    twin.offer(['cart#1', 'cart#2'], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(twin, medics);
    medics.accept('x');
    medics.commit(['cart#2'], 'phantom');

    const { tokens, violations } = derive([...supply.all(), ...medics.all()]);
    expect(tokens['cart#2']).toMatchObject({ state: 'held', holder: SUPPLY });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'token-fork', tokenId: 'cart#1' });
  });

  it('does not accuse the recipient of the losing twin when both twins picked one transfer id', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    const winner = access.offer([CHAIR], MEDICS, 'same-id');
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    const loser = twin.offer([CHAIR], SUPPLY, 'same-id');
    const supply = new Device(SUPPLY);
    exchange(twin, supply);
    const accept = supply.accept('same-id');
    const spent = supply.commit([CHAIR], 'phantom');

    const { tokens, violations } = derive([...access.all(), ...supply.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'token-fork', events: [winner.id, loser.id, accept.id, spent.id] });
  });

  it('lets the true recipient answer after a twin reused the transfer id', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    access.offer([CHAIR], MEDICS, 'same-id');
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    twin.offer([CHAIR], SUPPLY, 'same-id');
    const medics = new Device(MEDICS);
    exchange(access, medics);
    medics.accept('same-id');
    expect(token(derive([...medics.all(), ...twin.all()]), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
  });

  it('still reports a stranger accepting a voided offer', () => {
    const access = new Device(ACCESS);
    const twin = access.clone();
    access.commit([CHAIR], 'won');
    twin.emit('task.accepted', { taskId: 'warmup', via: 'tap' });
    twin.offer([CHAIR], MEDICS, 'x');
    const supply = new Device(SUPPLY);
    exchange(twin, supply);
    const stranger = supply.accept('x');
    const { violations } = derive([...access.all(), ...supply.all()]);
    expect(violations.find((v) => v.kind === 'forged-event')!.events).toEqual([stranger.id]);
  });
});

describe('replay and order', () => {
  it('ignores events from another mission', () => {
    const access = new Device(ACCESS);
    access.emit('right.committed', { tokens: [CHAIR], taskId: 'elsewhere' }, { mission: 'mission-2' });
    expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'held' });
    expect(access.derived().violations).toEqual([]);
  });

  it('applies a duplicated event once', () => {
    const access = new Device(ACCESS);
    const offer = access.offer([CHAIR], MEDICS, 'x');
    expect(derive([offer, offer, offer])).toEqual(derive([offer]));
  });

  it('follows causes before clocks', () => {
    const a = new Device(ACCESS);
    const first = a.emit('task.accepted', { taskId: 'one', via: 'tap' }, { lamport: 9 });
    const second = a.emit('task.accepted', { taskId: 'two', via: 'tap' }, { lamport: 1 });
    expect(causalOrder([second as AnyEvent, first as AnyEvent]).map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('orders concurrent events by lamport then id', () => {
    const a = new Device(ACCESS).emit('task.accepted', { taskId: 'a', via: 'tap' });
    const b = new Device(MEDICS).emit('task.accepted', { taskId: 'b', via: 'tap' });
    const c = new Device(SUPPLY).emit('task.accepted', { taskId: 'c', via: 'tap' }, { lamport: 0 });
    const ids = [a.id, b.id].sort();
    expect(causalOrder([a, b, c] as AnyEvent[]).map((e) => e.id)).toEqual([c.id, ...ids]);
  });
});

describe('canCommit', () => {
  const state = () => stateOf(derive([]));

  it('allows the holder', () => {
    expect(canCommit(state(), ACCESS, [CHAIR])).toEqual({ ok: true });
    expect(canOffer(state(), ACCESS, [CHAIR])).toEqual({ ok: true });
  });

  it('says plainly when the holder cannot be reached', () => {
    expect(canCommit(state(), MEDICS, [CHAIR], { reachable: [SUPPLY] })).toEqual({
      ok: false,
      code: 'NO_RIGHT',
      reason: 'The evacuation chair is held by Access, who you cannot reach.',
      next: ['WAIT_FOR_CONTACT', 'CARRY_UPDATE', 'SUBSTITUTE'],
    });
  });

  it('suggests a transfer when the holder can be reached', () => {
    expect(canCommit(state(), MEDICS, [CHAIR], { reachable: [ACCESS] })).toMatchObject({
      reason: 'The evacuation chair is held by Access. Ask them to transfer it.',
      next: ['REQUEST_TRANSFER'],
    });
  });

  it('names the holder without reachability', () => {
    expect(canCommit(state(), MEDICS, [CHAIR])).toMatchObject({ reason: 'The evacuation chair is held by Access.' });
  });

  it('keeps acronyms intact', () => {
    expect(canCommit(state(), ACCESS, ['aed#1'])).toMatchObject({ reason: 'The AED is held by Medics.' });
  });

  it('names the committed task', () => {
    const access = new Device(ACCESS);
    access.commit([CHAIR], 'carry');
    const record = { spec: { ...task('carry'), title: 'Carry guest to gate' } } as TaskRecord;
    const committed = stateOf(access.derived(), { carry: record });
    expect(canCommit(committed, ACCESS, [CHAIR])).toMatchObject({
      code: 'NO_RIGHT',
      reason: 'The evacuation chair is already committed to Carry guest to gate.',
    });
  });

  it('explains a transfer to each party', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const s = access.state();
    expect(canCommit(s, ACCESS, [CHAIR])).toMatchObject({
      code: 'TOKEN_IN_TRANSIT',
      reason: 'You offered the evacuation chair to Medics. It stays locked until they answer.',
    });
    expect(canCommit(s, MEDICS, [CHAIR])).toMatchObject({
      code: 'TOKEN_IN_TRANSIT',
      reason: 'The evacuation chair is on its way to you. Accept it first.',
    });
    expect(canCommit(s, SUPPLY, [CHAIR])).toMatchObject({
      code: 'TOKEN_IN_TRANSIT',
      reason: 'The evacuation chair is on its way to Medics.',
    });
  });

  it('refuses an unknown token and fails on the first problem in a list', () => {
    expect(canCommit(state(), ACCESS, ['ghost#1'])).toMatchObject({ code: 'NO_RIGHT' });
    expect(canCommit(state(), ACCESS, [CHAIR, 'aed#1'])).toMatchObject({ reason: 'The AED is held by Medics.' });
  });

  it('names a teammate rather than their team', () => {
    const s = state();
    s.actors['actor-kim'] = { id: 'actor-kim', team: 'access', name: 'Kim', lastSeq: 0, lastSeenWall: 0 };
    expect(canCommit(s, 'actor-kim', [CHAIR])).toMatchObject({ reason: 'The evacuation chair is held by Sam.' });
  });
});

describe('findTokens', () => {
  it('returns up to count tokens in stable order', () => {
    const s = stateOf(derive([]));
    expect(findTokens(s, SUPPLY, 'cart', 5)).toEqual(['cart#1', 'cart#2']);
    expect(findTokens(s, SUPPLY, 'cart', 1)).toEqual(['cart#1']);
    expect(findTokens(s, SUPPLY, 'cart', 0)).toEqual([]);
    expect(findTokens(s, MEDICS, 'cart', 1)).toEqual([]);
  });

  it('skips committed tokens', () => {
    const supply = new Device(SUPPLY);
    supply.commit(['cart#1'], 'haul');
    expect(findTokens(supply.state(), SUPPLY, 'cart', 2)).toEqual(['cart#2']);
  });
});

describe('canPerform', () => {
  const s = () => stateOf(derive([]));

  it('allows a team with every capability', () => {
    expect(canPerform(s(), MEDICS, task('t', ['first-aid']))).toEqual({ ok: true });
    expect(canPerform(s(), MEDICS, task('t'))).toEqual({ ok: true });
  });

  it('says what is missing', () => {
    expect(canPerform(s(), SUPPLY, task('t', ['first-aid', 'mobility']))).toEqual({
      ok: false,
      code: 'NO_CAPABILITY',
      reason: 'Supply cannot do this. It needs first aid and mobility.',
      next: ['SUBSTITUTE'],
    });
  });

  it('accepts a task record', () => {
    expect(canPerform(s(), MEDICS, { spec: task('t', ['repair']) } as TaskRecord)).toMatchObject({ ok: false });
  });

  it('refuses an actor outside the roster', () => {
    expect(canPerform(s(), 'actor-stranger', task('t'))).toMatchObject({ ok: false, code: 'NO_CAPABILITY' });
  });
});

describe('conservation', () => {
  const clean = () => stateOf(derive([]));
  const row = (s: MissionState, resource: string) => conservation(s).find((r) => r.resource === resource)!;

  it('balances a fresh mission', () => {
    expect(conservation(clean())).toEqual([
      { resource: 'evac-chair', issued: 1, committed: 0, held: 1, inTransit: 0, ok: true },
      { resource: 'aed', issued: 2, committed: 0, held: 2, inTransit: 0, ok: true },
      { resource: 'cart', issued: 3, committed: 0, held: 3, inTransit: 0, ok: true },
    ]);
  });

  it('counts each state', () => {
    const supply = new Device(SUPPLY);
    supply.commit(['cart#1'], 'haul');
    supply.offer(['cart#2'], MEDICS, 'x');
    expect(row(supply.state(), 'cart')).toEqual({ resource: 'cart', issued: 3, committed: 1, held: 1, inTransit: 1, ok: true });
  });

  it('fails when a right goes missing', () => {
    const s = clean();
    delete s.tokens['aed#1'];
    expect(row(s, 'aed').ok).toBe(false);
  });

  it('fails when a right is minted', () => {
    const s = clean();
    s.tokens['aed#3'] = { ...s.tokens['aed#1']!, id: 'aed#3' };
    expect(row(s, 'aed').ok).toBe(false);
  });

  it('fails when a missing right is swapped for a minted one', () => {
    const s = clean();
    s.tokens['aed#3'] = { ...s.tokens['aed#1']!, id: 'aed#3' };
    delete s.tokens['aed#1'];
    expect(row(s, 'aed')).toMatchObject({ held: 2, issued: 2, ok: false });
  });

  it('fails when a token claims two states at once', () => {
    const s = clean();
    s.tokens['aed#1'] = { ...s.tokens['aed#1']!, committedTo: 'carry' };
    expect(row(s, 'aed').ok).toBe(false);
  });

  it('fails when a token in transit still names a holder', () => {
    const s = clean();
    s.tokens['aed#1'] = { ...s.tokens['aed#1']!, state: 'in-transit', transfer: 'x' };
    expect(row(s, 'aed').ok).toBe(false);
  });

  it('reports a resource the capsule never issued', () => {
    const s = clean();
    s.tokens['drone#1'] = { ...s.tokens['aed#1']!, id: 'drone#1', resource: 'drone' };
    expect(row(s, 'drone')).toMatchObject({ issued: 0, held: 1, ok: false });
  });

  it('does not require the optional fields of a state, only forbids those of another', () => {
    const s = clean();
    s.tokens['aed#1'] = { ...s.tokens['aed#1']!, state: 'committed' };
    s.tokens['aed#2'] = { ...s.tokens['aed#2']!, state: 'in-transit', holder: null };
    expect(row(s, 'aed')).toMatchObject({ committed: 1, inTransit: 1, ok: true });
  });

  it('is empty before a capsule arrives', () => {
    expect(conservation({ ...clean(), capsule: null })).toEqual([]);
  });
});
