import { describe, expect, it } from 'vitest';
import type { AnyEvent, EventBodies, MissionState, TaskRecord } from '@afterlink/protocol';
import {
  auditRights,
  canCommit,
  canOffer,
  canPerform,
  conservation,
  deriveTokens,
  findTokens,
  pendingTransfers,
  type LedgerToken,
} from '../src/index.ts';
import { causalOrder } from '../src/causal.ts';
import {
  ACCESS,
  Device,
  FACILITIES,
  ISSUER,
  MEDICS,
  SUPPLY,
  capsule,
  crew,
  custodians,
  derive,
  exchange,
  stateOf,
  task,
  token,
} from './helpers.ts';

const CHAIR = 'evac-chair#1';

/** Two devices on one key, split at the next sequence number. */
function forked(actor = ACCESS) {
  const original = new Device(actor);
  return { original, twin: original.clone() };
}

const ruling = (conflictId: string, tokenId: string, holder: string) =>
  ({ conflictId, resolution: 'Checked in person.', keep: [], tokenHolder: { tokenId, holder } }) as EventBodies['conflict.resolved'];

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

  it('takes custodians from a signed genesis over the argument, so replicas cannot differ', () => {
    const issuer = new Device(ISSUER);
    issuer.emit('mission.issued', { capsule, custodians } as EventBodies['mission.issued']);
    const swapped = { ...custodians, access: MEDICS, medics: ACCESS };
    expect(deriveTokens(capsule, issuer.all(), swapped).tokens[CHAIR]).toMatchObject({ holder: ACCESS });
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

  it('refuses a holder whose team cannot do the task', () => {
    const access = new Device(ACCESS);
    const commit = access.commit([CHAIR], 'needs-first-aid');
    const { tokens, violations } = access.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'held', holder: ACCESS });
    expect(violations[0]).toMatchObject({ kind: 'forged-event', events: [commit.id] });
  });

  it('honours a capable holder, also for a task created during the mission', () => {
    const medics = new Device(MEDICS);
    medics.commit(['aed#1'], 'needs-first-aid');
    medics.emit('task.created', { spec: task('later', ['first-aid']), source: { kind: 'human' } });
    medics.commit(['aed#2'], 'later');
    expect(medics.derived().violations).toEqual([]);
    expect(token(medics.derived(), 'aed#2')).toMatchObject({ committedTo: 'later' });
  });
});

describe('malformed rights events', () => {
  const unchecked = (x: unknown) => x as never;

  for (const [name, tokens] of [
    ['an empty list', []],
    ['a token named twice', [CHAIR, CHAIR]],
    ['a number', 5],
    ['null', null],
    ['a list of numbers', [1]],
  ] as const) {
    it(`reports ${name} and changes nothing`, () => {
      const access = new Device(ACCESS);
      const e = access.emit('right.committed', unchecked({ tokens, taskId: 'carry' }));
      const { tokens: after, violations } = access.derived();
      expect(after[CHAIR]).toMatchObject({ state: 'held', holder: ACCESS });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ kind: 'forged-event', severity: 'violation', events: [e.id] });
    });
  }

  it('reports a commitment with no task', () => {
    const access = new Device(ACCESS);
    access.emit('right.committed', unchecked({ tokens: [CHAIR] }));
    expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'held' });
    expect(access.derived().violations).toHaveLength(1);
  });

  it('reports an offer with no transfer id', () => {
    const access = new Device(ACCESS);
    access.emit('right.offered', unchecked({ tokens: [CHAIR], to: MEDICS }));
    expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'held' });
    expect(access.derived().violations).toHaveLength(1);
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
      supply!.note(`t${i}`);
      exchange(supply!, access!);
    }
    expect(token(access!.derived(), CHAIR)).toMatchObject({ state: 'in-transit', holder: null });
    expect(canCommit(access!.state(), ACCESS, [CHAIR])).toMatchObject({ ok: false, code: 'TOKEN_IN_TRANSIT' });
    expect(token(medics!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
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

  it('reports an offer to oneself, a stranger or a device that cannot hold rights', () => {
    for (const to of [ACCESS, 'actor-stranger']) {
      const access = new Device(ACCESS);
      const offer = access.offer([CHAIR], to, 'x');
      expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
      expect(access.derived().violations[0]).toMatchObject({ kind: 'forged-event', tokenId: CHAIR, events: [offer.id] });
    }
  });
});

describe('the sender can never reclaim alone', () => {
  function offered() {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    return access;
  }

  it('rejects a commit after the offer as a token-fork', () => {
    const access = offered();
    const reclaim = access.commit([CHAIR], 'mine-after-all');
    const { tokens, violations } = access.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS, overspent: true });
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

  it('cannot respend blind: a decline only counts once the sender has seen it', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    const decline = medics!.decline('x');
    const blind = access!.emit('right.committed', { tokens: [CHAIR], taskId: 'guess' }, { lamport: decline.lamport + 5 });
    const merged = derive([...access!.all(), ...medics!.all()]);
    expect(token(merged, CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
    expect(merged.violations[0]).toMatchObject({ kind: 'token-fork' });
    expect(merged.violations[0]!.events).toContain(blind.id);
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

  it('reports a second identical answer, with no effect', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    const first = medics!.accept('x');
    const second = medics!.accept('x');
    const derived = medics!.derived();
    expect(token(derived, CHAIR).chain).toHaveLength(2);
    expect(derived.violations[0]).toMatchObject({ kind: 'token-fork', events: [first.id, second.id] });
  });

  it('reports an answer to a transfer nobody offered', () => {
    const medics = new Device(MEDICS);
    const accept = medics.accept('ghost');
    expect(medics.derived().violations[0]).toMatchObject({ kind: 'forged-event', events: [accept.id] });
  });

  it('refuses an answer to an offer its signer had not seen', () => {
    const access = new Device(ACCESS);
    const offer = access.offer([CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    const blind = medics.emit('right.accepted', { transfer: 'x' }, { lamport: offer.lamport + 5 });
    const { tokens, violations } = derive([...access.all(), ...medics.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit', to: MEDICS });
    expect(violations.flatMap((v) => v.events)).toContain(blind.id);
  });
});

describe('transfer ids', () => {
  it('cannot be reused to hijack an open transfer', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const supply = new Device(SUPPLY);
    supply.receive(access.all());
    const hijack = supply.offer(['cart#1'], MEDICS, 'x');
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

  it('cannot re-bind an old acceptance to a new offer', () => {
    const { [ACCESS]: access, [MEDICS]: medics, [SUPPLY]: supply } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.accept('x');
    medics!.offer([CHAIR], SUPPLY, 'x');
    expect(token(medics!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
    exchange(medics!, supply!);
    supply!.accept('x');
    expect(token(supply!.derived(), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
  });

  it('let two senders who never saw each other use one id without either blocking the other', () => {
    const access = new Device(ACCESS);
    const supply = new Device(SUPPLY);
    access.offer([CHAIR], MEDICS, 'x');
    supply.offer(['cart#1'], FACILITIES, 'x');
    const medics = new Device(MEDICS);
    medics.receive(access.all());
    medics.accept('x');
    const merged = derive([...supply.all(), ...medics.all()]);
    expect(merged.violations).toEqual([]);
    expect(token(merged, CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
    expect(token(merged, 'cart#1')).toMatchObject({ state: 'in-transit', to: FACILITIES });
  });

  it('refuse to guess between two offers one answer could mean', () => {
    const access = new Device(ACCESS);
    const supply = new Device(SUPPLY);
    access.offer([CHAIR], MEDICS, 'x');
    supply.offer(['cart#1'], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(access, supply, medics);
    const answer = medics.accept('x');
    const { tokens, violations } = medics.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'in-transit' });
    expect(tokens['cart#1']).toMatchObject({ state: 'in-transit' });
    expect(violations[0]).toMatchObject({ kind: 'forged-event', events: [answer.id] });
  });
});

describe('a holder whose history forks', () => {
  it('freezes a token both branches tried to commit, with no winner', () => {
    const { original, twin } = forked();
    const a = original.commit([CHAIR], 'a');
    const b = twin.commit([CHAIR], 'b');
    const { tokens, violations } = derive([...original.all(), ...twin.all()]);
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));

    expect(tokens[CHAIR]).toMatchObject({ state: 'disputed', holder: null, chain: [], overspent: true });
    expect(tokens[CHAIR]).not.toHaveProperty('committedTo');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: 'violation', kind: 'token-fork', tokenId: CHAIR, resolved: false, taskId: first!.body.taskId });
    expect([...violations[0]!.events].sort()).toEqual([first!.id, second!.id].sort());
    expect(violations[0]!.summary).toBe('Access signed two conflicting histories, so the evacuation chair is frozen until the organiser rules.');
  });

  it('lets no choice of clock or id pick a winner', () => {
    for (const lamport of [0, 1, 1000]) {
      const { original, twin } = forked();
      original.commit([CHAIR], 'honest');
      twin.emit('right.committed', { tokens: [CHAIR], taskId: 'chosen' }, { lamport });
      expect(token(derive([...original.all(), ...twin.all()]), CHAIR).state).toBe('disputed');
    }
  });

  it('cannot use a fork to take back a transfer made at the fork', () => {
    const { original, twin } = forked();
    original.offer([CHAIR], MEDICS, 'x');
    twin.emit('right.committed', { tokens: [CHAIR], taskId: 'mine' }, { lamport: 0 });
    const medics = new Device(MEDICS);
    exchange(original, medics);
    medics.accept('x');
    const { tokens } = derive([...medics.all(), ...twin.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'disputed', holder: null, affected: [MEDICS] });
  });

  it('leaves alone a token handed over before the fork, so a forked key cannot grief its new holder', () => {
    const original = new Device(ACCESS);
    original.offer([CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(original, medics);
    medics.accept('x');
    const twin = original.clone();
    original.note('left');
    const grief = twin.commit([CHAIR], 'mine');

    const { tokens, violations } = derive([...medics.all(), ...original.all(), ...twin.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'held', holder: MEDICS, overspent: true });
    expect(violations[0]).toMatchObject({ kind: 'token-fork' });
    expect(violations[0]!.events).toContain(grief.id);
  });

  it('cannot freeze a token it never held by naming it', () => {
    const { original, twin } = forked();
    original.note('left');
    twin.commit(['aed#1'], 'grief');
    const { tokens, violations } = derive([...original.all(), ...twin.all()]);
    expect(tokens['aed#1']).toMatchObject({ state: 'held', holder: MEDICS });
    expect(violations.find((v) => v.tokenId === 'aed#1')).toMatchObject({ kind: 'forged-event' });
  });

  it('freezes what it held even when the fork itself touched no rights, without calling it a double spend', () => {
    const { original, twin } = forked();
    const a = original.note('left');
    const b = twin.note('right');
    const derived = derive([...original.all(), ...twin.all()]);
    expect(token(derived, CHAIR)).toMatchObject({ state: 'disputed', holder: null });
    expect(token(derived, CHAIR)).not.toHaveProperty('overspent');
    expect(derived.violations).toHaveLength(1);
    expect(derived.violations[0]!.events.sort()).toEqual([a.id, b.id].sort());
    const row = conservation(stateOf(derived)).find((r) => r.resource === 'evac-chair')!;
    expect(row).toMatchObject({ disputed: 1, held: 0, ok: true });
  });

  it('files one record per token its branches spent, and covers the rest under it', () => {
    const { original, twin } = forked(SUPPLY);
    original.commit(['cart#1'], 'a');
    twin.commit(['cart#1'], 'b');
    const { tokens, violations } = derive([...original.all(), ...twin.all()]);
    expect(tokens['cart#1']).toMatchObject({ state: 'disputed' });
    expect(tokens['cart#2']).toMatchObject({ state: 'disputed' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ tokenId: 'cart#1' });
  });

  it('keeps a commitment made before the fork', () => {
    const original = new Device(ACCESS);
    const commit = original.commit([CHAIR], 'done');
    const twin = original.clone();
    original.note('left');
    twin.note('right');
    expect(token(derive([...original.all(), ...twin.all()]), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'done', chain: [commit.id] });
  });

  it('does not let a branch release a commitment made before the fork', () => {
    const original = new Device(ACCESS);
    original.commit([CHAIR], 'done');
    const twin = original.clone();
    original.note('left');
    twin.emit('task.released', { taskId: 'done', reason: 'changed my mind' });
    expect(token(derive([...original.all(), ...twin.all()]), CHAIR)).toMatchObject({ state: 'committed' });
  });

  it('freezes a token returned to it after the fork', () => {
    const original = new Device(ACCESS);
    original.offer([CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(original, medics);
    const twin = original.clone();
    original.note('left');
    twin.note('right');
    medics.decline('x');
    expect(token(derive([...original.all(), ...twin.all(), ...medics.all()]), CHAIR)).toMatchObject({ state: 'disputed' });
  });

  it('freezes a token offered to it when a branch answers', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(access, medics);
    const twin = medics.clone();
    medics.accept('x');
    twin.decline('x');
    expect(token(derive([...access.all(), ...medics.all(), ...twin.all()]), CHAIR)).toMatchObject({ state: 'disputed', holder: null });
  });

  it('leaves a token in transit to it alone until it answers', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(access, medics);
    const twin = medics.clone();
    medics.note('left');
    twin.note('right');
    expect(token(derive([...access.all(), ...medics.all(), ...twin.all()]), CHAIR)).toMatchObject({ state: 'in-transit', to: MEDICS });
  });

  it('lists everyone who built on a branch, and honours none of it', () => {
    const { original, twin } = forked();
    const left = original.commit([CHAIR], 'left');
    const right = twin.offer([CHAIR], MEDICS, 'x');
    const { [MEDICS]: medics, [SUPPLY]: supply } = crew();
    exchange(twin, medics!);
    const accept = medics!.accept('x');
    const onward = medics!.offer([CHAIR], SUPPLY, 'y');
    exchange(medics!, supply!);
    const accept2 = supply!.accept('y');
    const spent = supply!.commit([CHAIR], 'phantom');

    expect(token(supply!.derived(), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'phantom' });

    const merged = derive([...original.all(), ...supply!.all()]);
    expect(token(merged, CHAIR)).toMatchObject({ state: 'disputed', affected: [MEDICS, SUPPLY] });
    expect(merged.violations).toHaveLength(1);
    expect(merged.violations[0]!.events.sort()).toEqual([left.id, right.id, accept.id, onward.id, accept2.id, spent.id].sort());
  });

  it('does not accuse an honest recipient over a token that stayed clean in a voided offer', () => {
    const access = new Device(ACCESS);
    access.commit([CHAIR], 'won');
    access.offer(['ghost#1', CHAIR], MEDICS, 'x');
    const medics = new Device(MEDICS);
    exchange(access, medics);
    medics.accept('x');
    const accepted = derive(medics.all());
    expect(accepted.violations.filter((v) => v.kind === 'forged-event' && v.events.length > 1)).toHaveLength(1);
  });

  it('does not accuse the recipient of the losing twin when both twins picked one transfer id', () => {
    const { original, twin } = forked();
    original.offer([CHAIR], MEDICS, 'same-id');
    twin.offer([CHAIR], SUPPLY, 'same-id');
    const supply = new Device(SUPPLY);
    exchange(twin, supply);
    supply.accept('same-id');
    supply.commit([CHAIR], 'phantom');

    const { tokens, violations } = derive([...original.all(), ...supply.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'disputed', affected: [SUPPLY] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'token-fork' });
  });

  it('still reports a stranger answering a voided offer', () => {
    const { original, twin } = forked();
    original.commit([CHAIR], 'left');
    twin.offer([CHAIR], MEDICS, 'x');
    const supply = new Device(SUPPLY);
    exchange(twin, supply);
    const stranger = supply.accept('x');
    const { tokens, violations } = derive([...original.all(), ...supply.all()]);
    expect(tokens[CHAIR]).toMatchObject({ state: 'disputed' });
    expect(violations.flatMap((v) => v.events)).toContain(stranger.id);
  });

  it('settles only on the set of events, never on which branch arrived first', () => {
    const { original, twin } = forked();
    original.commit([CHAIR], 'a');
    twin.commit([CHAIR], 'b');
    const forward = [...original.all(), ...twin.all()];
    expect(derive([...forward].reverse())).toEqual(derive(forward));
  });
});

describe('the organiser ruling on a stuck token', () => {
  function disputed() {
    const { original, twin } = forked();
    original.commit([CHAIR], 'a');
    twin.commit([CHAIR], 'b');
    const issuer = new Device(ISSUER);
    exchange(original, twin, issuer);
    const conflict = issuer.derived().violations[0]!;
    return { original, twin, issuer, conflict };
  }

  it('hands a disputed token to the named holder, who may then spend it', () => {
    const { issuer, conflict } = disputed();
    const decision = issuer.emit('conflict.resolved', ruling(conflict.id, CHAIR, MEDICS));
    const after = token(issuer.derived(), CHAIR);
    expect(after).toMatchObject({ state: 'held', holder: MEDICS, holderTeam: 'medics' });
    expect(after.chain.at(-1)).toBe(decision.id);
    expect(after).not.toHaveProperty('affected');

    const medics = new Device(MEDICS);
    exchange(issuer, medics);
    medics.commit([CHAIR], 'carry');
    expect(token(medics.derived(), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'carry' });
  });

  it('takes no ruling from anyone but the issuer, least of all the forked actor', () => {
    const { original, conflict } = disputed();
    const self = original.emit('conflict.resolved', ruling(conflict.id, CHAIR, ACCESS));
    const { tokens, violations } = original.derived();
    expect(tokens[CHAIR]).toMatchObject({ state: 'disputed' });
    expect(violations.flatMap((v) => v.events)).toContain(self.id);
  });

  it('needs the right conflict named', () => {
    const { issuer } = disputed();
    issuer.emit('conflict.resolved', ruling('token-fork:other', CHAIR, MEDICS));
    expect(token(issuer.derived(), CHAIR)).toMatchObject({ state: 'disputed' });
    expect(issuer.derived().violations.find((v) => v.kind === 'stale-decision')).toMatchObject({ severity: 'policy' });
  });

  it('needs the issuer to have seen the evidence', () => {
    const { original, twin, conflict } = disputed();
    const blind = new Device(ISSUER);
    blind.emit('conflict.resolved', ruling(conflict.id, CHAIR, MEDICS));
    expect(token(derive([...original.all(), ...twin.all(), ...blind.all()]), CHAIR)).toMatchObject({ state: 'disputed' });
  });

  it('cannot name the forked actor, or someone who cannot hold rights', () => {
    for (const holder of [ACCESS, 'actor-stranger']) {
      const { issuer, conflict } = disputed();
      issuer.emit('conflict.resolved', ruling(conflict.id, CHAIR, holder));
      expect(token(issuer.derived(), CHAIR)).toMatchObject({ state: 'disputed' });
    }
  });

  it('frees a token offered to a lost device', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const issuer = new Device(ISSUER);
    exchange(access, issuer);
    issuer.emit('conflict.resolved', ruling('lost-phone', CHAIR, ACCESS));
    expect(token(issuer.derived(), CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
    expect(token(issuer.derived(), CHAIR)).not.toHaveProperty('transfer');
  });

  it('gives way to a recipient who answered, whichever arrives first', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const issuer = new Device(ISSUER);
    const medics = new Device(MEDICS);
    exchange(access, issuer, medics);
    issuer.emit('conflict.resolved', ruling('lost-phone', CHAIR, ACCESS));
    medics.accept('x');
    const events = [...issuer.all(), ...medics.all()];
    expect(token(derive(events), CHAIR)).toMatchObject({ state: 'held', holder: MEDICS });
    expect(derive([...events].reverse())).toEqual(derive(events));
    expect(derive(events).violations[0]).toMatchObject({ kind: 'stale-decision', severity: 'policy' });
  });

  it('does not reach a token that is simply held or committed', () => {
    const issuer = new Device(ISSUER);
    issuer.emit('conflict.resolved', ruling('nothing', CHAIR, MEDICS));
    expect(token(issuer.derived(), CHAIR)).toMatchObject({ state: 'held', holder: ACCESS });
  });

  it('leaves ordinary conflict closures alone', () => {
    const access = new Device(ACCESS);
    access.emit('conflict.resolved', { conflictId: 'duplicate-effort:t', resolution: 'fine', keep: [] });
    expect(access.derived().violations).toEqual([]);
  });
});

describe('release', () => {
  it('returns a committed token to the holder who gives the task up', () => {
    const access = new Device(ACCESS);
    access.commit([CHAIR], 'carry');
    const release = access.emit('task.released', { taskId: 'carry', reason: 'not needed' });
    const after = token(access.derived(), CHAIR);
    expect(after).toMatchObject({ state: 'held', holder: ACCESS });
    expect(after).not.toHaveProperty('committedTo');
    expect(after.chain.at(-1)).toBe(release.id);
    access.commit([CHAIR], 'other');
    expect(token(access.derived(), CHAIR)).toMatchObject({ state: 'committed', committedTo: 'other' });
    expect(access.derived().violations).toEqual([]);
  });

  it('is only the committer\'s to give', () => {
    const access = new Device(ACCESS);
    access.commit([CHAIR], 'carry');
    const medics = new Device(MEDICS);
    exchange(access, medics);
    medics.emit('task.released', { taskId: 'carry', reason: 'mine now' });
    expect(token(medics.derived(), CHAIR)).toMatchObject({ state: 'committed', holder: ACCESS });
  });

  it('touches only tokens committed to that task', () => {
    const supply = new Device(SUPPLY);
    supply.commit(['cart#1'], 'a');
    supply.commit(['cart#2'], 'b');
    supply.emit('task.released', { taskId: 'a', reason: 'done' });
    expect(token(supply.derived(), 'cart#1')).toMatchObject({ state: 'held' });
    expect(token(supply.derived(), 'cart#2')).toMatchObject({ state: 'committed' });
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

  it('refuses everyone on a disputed token and says who decides', () => {
    const { original, twin } = forked();
    original.note('left');
    twin.note('right');
    const s = stateOf(derive([...original.all(), ...twin.all()]));
    for (const actor of [ACCESS, MEDICS]) {
      expect(canCommit(s, actor, [CHAIR])).toEqual({
        ok: false,
        code: 'NO_RIGHT',
        reason: 'The evacuation chair is in dispute. The organiser must rule on it.',
        next: ['ESCALATE', 'SUBSTITUTE'],
      });
    }
    expect(findTokens(s, ACCESS, 'evac-chair', 1)).toEqual([]);
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
      { resource: 'evac-chair', issued: 1, committed: 0, held: 1, inTransit: 0, disputed: 0, ok: true },
      { resource: 'aed', issued: 2, committed: 0, held: 2, inTransit: 0, disputed: 0, ok: true },
      { resource: 'cart', issued: 3, committed: 0, held: 3, inTransit: 0, disputed: 0, ok: true },
    ]);
  });

  it('counts each state', () => {
    const supply = new Device(SUPPLY);
    supply.commit(['cart#1'], 'haul');
    supply.offer(['cart#2'], MEDICS, 'x');
    expect(row(supply.state(), 'cart')).toEqual({ resource: 'cart', issued: 3, committed: 1, held: 1, inTransit: 1, disputed: 0, ok: true });
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

  it('fails when a disputed token still names a holder', () => {
    const s = clean();
    s.tokens['aed#1'] = { ...s.tokens['aed#1']!, state: 'disputed' };
    expect(row(s, 'aed').ok).toBe(false);
  });

  it('does not require the optional fields of a state, only forbids those of another', () => {
    const s = clean();
    s.tokens['aed#1'] = { ...s.tokens['aed#1']!, state: 'committed' };
    s.tokens['aed#2'] = { ...s.tokens['aed#2']!, state: 'in-transit', holder: null };
    expect(row(s, 'aed')).toMatchObject({ committed: 1, inTransit: 1, ok: true });
  });

  it('reports a resource the capsule never issued', () => {
    const s = clean();
    s.tokens['drone#1'] = { ...s.tokens['aed#1']!, id: 'drone#1', resource: 'drone' };
    expect(row(s, 'drone')).toMatchObject({ issued: 0, held: 1, ok: false });
  });

  it('is empty before a capsule arrives', () => {
    expect(conservation({ ...clean(), capsule: null })).toEqual([]);
  });

  it('fails on a double spend even though the sums still balance', () => {
    const { original, twin } = forked();
    original.commit([CHAIR], 'a');
    twin.commit([CHAIR], 'b');
    const s = stateOf(derive([...original.all(), ...twin.all()]));
    expect(row(s, 'evac-chair')).toMatchObject({ issued: 1, disputed: 1, ok: false });
    expect(row(s, 'aed').ok).toBe(true);
  });

  it('fails when the audit disagrees with a ledger that looks clean', () => {
    const { original, twin } = forked();
    original.commit([CHAIR], 'a');
    twin.commit([CHAIR], 'b');
    const events = [...original.all(), ...twin.all()];
    const looksClean = clean();
    expect(row(looksClean, 'evac-chair').ok).toBe(true);
    const audited = conservation(looksClean, auditRights(capsule, events, custodians));
    expect(audited.find((r) => r.resource === 'evac-chair')!.ok).toBe(false);
  });
});

describe('auditRights', () => {
  const audit = (events: AnyEvent[]) => auditRights(capsule, events, custodians);
  const row = (events: AnyEvent[], id: string) => audit(events).find((r) => r.token === id)!;

  it('finds nothing in a clean transfer and commitment', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.accept('x');
    const commit = medics!.commit([CHAIR], 'carry');
    expect(row(medics!.all(), CHAIR)).toEqual({ token: CHAIR, resource: 'evac-chair', commits: [commit.id], released: 0, overspent: [], reanswered: [], ok: true });
  });

  it('counts a double commit across forked branches', () => {
    const { original, twin } = forked();
    const a = original.commit([CHAIR], 'a');
    const b = twin.commit([CHAIR], 'b');
    const found = row([...original.all(), ...twin.all()], CHAIR);
    expect(found.commits.sort()).toEqual([a.id, b.id].sort());
    expect(found).toMatchObject({ overspent: [ACCESS], ok: false });
  });

  it('counts a spend by someone the right never reached', () => {
    const medics = new Device(MEDICS);
    medics.commit([CHAIR], 'grab');
    expect(row(medics.all(), CHAIR)).toMatchObject({ overspent: [MEDICS], ok: false });
  });

  it('allows spending again after a decline or a release', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.decline('x');
    exchange(access!, medics!);
    access!.commit([CHAIR], 'one');
    access!.emit('task.released', { taskId: 'one', reason: 'freed' });
    access!.commit([CHAIR], 'two');
    expect(row(access!.all(), CHAIR)).toMatchObject({ released: 1, overspent: [], ok: true });
  });

  it('flags an offer answered twice', () => {
    const { [ACCESS]: access, [MEDICS]: medics } = crew();
    const offer = access!.offer([CHAIR], MEDICS, 'x');
    exchange(access!, medics!);
    medics!.accept('x');
    medics!.decline('x');
    expect(row(medics!.all(), CHAIR)).toMatchObject({ reanswered: [offer.id], ok: false });
  });

  it('counts a ruling as a right reaching its new holder', () => {
    const access = new Device(ACCESS);
    access.offer([CHAIR], MEDICS, 'x');
    const issuer = new Device(ISSUER);
    exchange(access, issuer);
    issuer.emit('conflict.resolved', ruling('lost', CHAIR, ACCESS));
    const again = new Device(ACCESS);
    again.receive(issuer.all());
    const events = [...issuer.all(), access.commit([CHAIR], 'after') as AnyEvent];
    expect(row(events, CHAIR)).toMatchObject({ overspent: [], ok: true });
  });

  it('survives junk and ignores another mission', () => {
    const access = new Device(ACCESS);
    access.emit('right.committed', { tokens: 5, taskId: 't' } as never);
    access.emit('right.committed', { tokens: [CHAIR], taskId: 'x' }, { mission: 'mission-2' });
    expect(row(access.all(), CHAIR)).toMatchObject({ commits: [], ok: true });
  });
});

const _typecheck: LedgerToken | undefined = undefined;
void _typecheck;
