import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { conservation, deriveTokens } from '@afterlink/authority';
import { claimRank, reduce } from '@afterlink/mission';
import { EventLog, createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, DecisionRecord, EventBodies, EventType, MissionState } from '@afterlink/protocol';
import { buildMissionRecord, classify } from '@afterlink/reconcile';
import { buildWorld, type Keys, type World } from './explorer.ts';

/** Signs events by hand, so tests can choose exactly what an attacker would. */
class Scribe {
  readonly log: EventLog;
  private heads = new Map<string, { seq: number; id: string }>();
  constructor(readonly world: World) {
    this.log = new EventLog(world.capsule.id);
    this.log.ingest(world.genesis);
  }
  sign<T extends EventType>(keys: Keys, type: T, body: EventBodies[T], over: { lamport?: number; parents?: string[]; seq?: number; prev?: string | null } = {}): AnyEvent {
    const head = this.heads.get(keys.publicKey);
    const seq = over.seq ?? (head?.seq ?? 0) + 1;
    const e = createEvent({
      keys,
      mission: this.world.capsule.id,
      seq,
      prev: over.prev !== undefined ? over.prev : (head?.id ?? null),
      parents: over.parents ?? this.log.heads().filter((id) => this.log.get(id)?.actor !== keys.publicKey),
      lamport: over.lamport ?? this.log.lamport() + 1,
      wall: 1000 + this.log.size,
      type,
      body,
    }) as AnyEvent;
    this.log.ingest(e);
    this.heads.set(keys.publicKey, { seq, id: e.id });
    return e;
  }
  state(): MissionState {
    return reduce(this.log.all(), this.world.roster);
  }
}

function decision(actor: string, taskId: string): DecisionRecord {
  return { id: `d-${actor}-${taskId}`, actor, taskId, outcome: 'ACCEPTED', reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [] };
}

/** Keys ordered so the first wins the claim tie-break on this task. */
function byRank(world: World, taskId: string): Keys[] {
  return [...world.keys].sort((x, y) => (claimRank(taskId, x.publicKey) < claimRank(taskId, y.publicKey) ? -1 : 1));
}

function setup(actors = 3, tokens = 2) {
  const world = buildWorld(actors, tokens);
  return { world, s: new Scribe(world), a: world.keys[0]!, b: world.keys[1]!, c: world.keys[2]! };
}

describe('authority over tokens', () => {
  it('a stranger cannot move a token, and is reported', () => {
    const { world, s } = setup();
    const stranger = generateKeys();
    s.sign(stranger, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    const st = s.state();
    expect(st.tokens['kit#0']!.state).toBe('held');
    expect(st.tokens['kit#0']!.holder).toBe(world.keys[0]!.publicKey);
    expect(st.conflicts.some((c) => c.severity === 'violation')).toBe(true);
  });

  it('a roster member that does not hold a token cannot spend it', () => {
    const { s, b } = setup();
    s.sign(b, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    expect(s.state().tokens['kit#0']!.state).toBe('held');
  });

  it('a partly invalid token list voids the whole event', () => {
    const { s, a } = setup();
    s.sign(a, 'right.committed', { tokens: ['kit#0', 'kit#1'], taskId: 'job-a' });
    const st = s.state();
    expect(st.tokens['kit#0']!.state).toBe('held');
    expect(st.tokens['kit#1']!.state).toBe('held');
  });

  it('only the named recipient can answer an offer', () => {
    const { s, a, b, c } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(c, 'right.accepted', { transfer: 'x' });
    expect(s.state().tokens['kit#0']!.state).toBe('in-transit');
  });

  it('a sender cannot answer its own offer to reclaim the token', () => {
    const { s, a, b } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(a, 'right.declined', { transfer: 'x' });
    expect(s.state().tokens['kit#0']!.state).toBe('in-transit');
  });

  it('a holder that commits then offers leaves the offer void, and the recipient holds nothing', () => {
    const { s, a, b } = setup();
    s.sign(a, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(b, 'right.accepted', { transfer: 'x' });
    const st = s.state();
    expect(st.tokens['kit#0']!.state).toBe('committed');
    expect(st.tokens['kit#0']!.holder).toBe(a.publicKey);
    expect(st.conflicts.some((c) => c.kind === 'token-fork')).toBe(true);
  });

  it('a holder that offers then commits cannot spend the locked token', () => {
    const { s, a, b } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(a, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    expect(s.state().tokens['kit#0']!.state).toBe('in-transit');
  });

  it('a reused transfer id cannot re-bind an old acceptance', () => {
    const { s, a, b, c } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(b, 'right.accepted', { transfer: 'x' });
    s.sign(b, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: c.publicKey });
    const st = s.state();
    expect(st.tokens['kit#0']!.holder).toBe(b.publicKey);
    expect(st.tokens['kit#0']!.state).toBe('held');
  });

  it('an offer to a key outside the roster is void: it cannot lock a token forever', () => {
    const { s, a } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: generateKeys().publicKey });
    expect(s.state().tokens['kit#0']!.state).toBe('held');
  });

  it('conservation reports a double commit', () => {
    const { world, s, a, b } = setup();
    const offer = s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(b, 'right.accepted', { transfer: 'x' });
    s.sign(b, 'right.committed', { tokens: ['kit#0'], taskId: 'job-b' });
    s.sign(a, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' }, { seq: offer.seq, prev: offer.prev, parents: [world.genesis.id] });
    const st = s.state();
    expect(conservation(st).find((r) => r.resource === 'kit')!.ok).toBe(false);
  });
});

describe('fork injection', () => {
  it('two signed successors are reported on every replica, whichever arrives first', () => {
    const { world, s, a, b, c } = setup();
    const left = s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    const right = s.sign(a, 'right.offered', { transfer: 'y', tokens: ['kit#0'], to: c.publicKey }, { seq: left.seq, prev: left.prev, parents: left.parents });
    const all = s.log.all();
    fc.assert(
      fc.property(fc.shuffledSubarray(all, { minLength: all.length, maxLength: all.length }), (order) => {
        const log = new EventLog(world.capsule.id);
        for (const e of order) log.ingest(e);
        const st = reduce(log.all(), world.roster);
        expect(st.conflicts.some((x) => x.kind === 'token-fork' && x.events.includes(left.id) && x.events.includes(right.id))).toBe(true);
        expect(JSON.stringify(st.tokens)).toBe(JSON.stringify(s.state().tokens));
      }),
      { numRuns: 60 },
    );
  });
});

describe('poison events signed by a roster key', () => {
  const survive = (fn: (s: Scribe, a: Keys) => void) => {
    const { s, a } = setup();
    fn(s, a);
    let stage = 'reduce';
    try {
      const st = s.state();
      stage = 'classify';
      classify(s.log.all(), st);
      stage = 'record';
      buildMissionRecord({ events: s.log.all(), state: st, hqSeen: [] });
      stage = 'ok';
    } catch (err) {
      stage = `${stage}: ${(err as Error).message}`;
    }
    expect(stage).toBe('ok');
  };
  const seen = (a: Keys, key: string) => ({ observation: { key, value: 1, subject: 's', observedAt: 1, validForMs: 0, source: a.publicKey } });

  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    it(`observation key ${key} cannot crash the fold`, () => survive((s, a) => s.sign(a, 'observation.recorded', seen(a, key))));
  }
  it('right.committed with a number for tokens', () => survive((s, a) => s.sign(a, 'right.committed', { tokens: 5, taskId: 'job-a' } as never)));
  it('right.committed with null tokens', () => survive((s, a) => s.sign(a, 'right.committed', { tokens: null, taskId: 'job-a' } as never)));
  it('right.offered with a number for tokens', () => survive((s, a) => s.sign(a, 'right.offered', { transfer: 'x', tokens: 5, to: a.publicKey } as never)));
  it('task.created with a null spec', () => survive((s, a) => s.sign(a, 'task.created', { spec: null, source: { kind: 'human' } } as never)));
  it('task.claimed with no decision', () => survive((s, a) => s.sign(a, 'task.claimed', { taskId: 'job-a' } as never)));
  it('task.claimed with a decision that has no inputs', () =>
    survive((s, a) => s.sign(a, 'task.claimed', { taskId: 'job-a', decision: { actor: a.publicKey, taskId: 'job-a' } } as never)));
  it('task.refused with no decision', () => survive((s, a) => s.sign(a, 'task.refused', { taskId: 'job-a' } as never)));
  it('observation with no body', () => survive((s, a) => s.sign(a, 'observation.recorded', {} as never)));
  it('actor.joined with no credential', () => survive((s, a) => s.sign(a, 'actor.joined', { team: 'team0' } as never)));
  it('conflict.resolved with a number for keep', () =>
    survive((s, a) => {
      s.sign(a, 'task.claimed', { taskId: 'job-a', decision: decision(a.publicKey, 'job-a') });
      s.sign(a, 'task.completed', { taskId: 'job-a', evidence: 'e', via: 'tap' });
      s.sign(a, 'conflict.resolved', { conflictId: 'duplicate-effort:job-a', resolution: 'r', keep: 5 } as never);
    }));
  it('task.created with id __proto__ stays a normal task', () => {
    const { s, a } = setup();
    const spec = { ...s.world.capsule.tasks[0]!, id: '__proto__', title: 'Pollution' };
    s.sign(a, 'task.created', { spec, source: { kind: 'human' } });
    const st = s.state();
    expect(Object.getPrototypeOf(st.tasks)).toBe(Object.prototype);
  });
});

describe('identity inside events', () => {
  it('an observation in someone else\'s name is not stored', () => {
    const { s, a, b } = setup();
    s.sign(a, 'observation.recorded', { observation: { key: 'gate', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: b.publicKey } });
    expect(s.state().observations.gate ?? []).toEqual([]);
  });

  it('a replayed credential buys nothing', () => {
    const { world, s, b } = setup();
    const stolen = world.roster[0]!.credential;
    s.sign(b, 'actor.joined', { team: 'team0', name: 'Thief', credential: stolen });
    const st = s.state();
    expect(st.actors[b.publicKey]!.team).toBe('team1');
    expect(st.tokens['kit#0']!.holder).toBe(world.keys[0]!.publicKey);
  });

  it('a second genesis by a stranger changes nothing', () => {
    const { world, s } = setup();
    const stranger = generateKeys();
    const capsule = { ...world.capsule, issuer: stranger.publicKey, resources: [] };
    s.sign(stranger, 'mission.issued', { capsule });
    const st = s.state();
    expect(st.capsule!.issuer).toBe(world.capsule.issuer);
    expect(Object.keys(st.tokens).length).toBe(2);
  });

  it('events replayed from another mission are ignored by the ledger', () => {
    const { world, s, a } = setup();
    const other = createEvent({ keys: a, mission: 'other-mission', seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'right.committed', body: { tokens: ['kit#0'], taskId: 'job-a' } }) as AnyEvent;
    const st = reduce([...s.log.all(), other], world.roster);
    expect(st.tokens['kit#0']!.state).toBe('held');
  });
});

describe('who may close a conflict', () => {
  function violated() {
    const { world, s, a, b, c } = setup();
    const left = s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(a, 'right.offered', { transfer: 'y', tokens: ['kit#0'], to: c.publicKey }, { seq: left.seq, prev: left.prev, parents: left.parents });
    const conflict = s.state().conflicts.find((x) => x.kind === 'token-fork')!;
    return { world, s, a, b, c, conflict };
  }

  it('the actor that forked cannot mark its own violation resolved', () => {
    const { s, a, conflict } = violated();
    s.sign(a, 'conflict.resolved', { conflictId: conflict.id, resolution: 'nothing to see', keep: [] });
    expect(s.state().conflicts.find((x) => x.id === conflict.id)!.resolved).toBe(false);
  });

  it('the classifier cannot be told to close a violation by the actor that caused it', () => {
    const { s, a } = violated();
    const before = classify(s.log.all(), s.state()).find((x) => x.kind === 'token-fork')!;
    s.sign(a, 'conflict.resolved', { conflictId: before.id, resolution: 'nothing to see', keep: [] });
    expect(classify(s.log.all(), s.state()).find((x) => x.id === before.id)!.resolved).toBe(false);
  });
});

describe('task order cannot be gamed with a declared clock', () => {
  it('a claim made after seeing a rival cannot win by declaring an early clock', () => {
    const { world, s } = setup();
    const [first, late] = byRank(world, 'job-a').reverse();
    const claim = s.sign(first!, 'task.claimed', { taskId: 'job-a', decision: decision(first!.publicKey, 'job-a') });
    s.sign(late!, 'task.claimed', { taskId: 'job-a', decision: decision(late!.publicKey, 'job-a') }, { lamport: 0, parents: [claim.id] });
    expect(s.state().tasks['job-a']!.owner).toBe(first!.publicKey);
  });

  it('a completion cannot be hidden from the tie-break by declaring an early clock', () => {
    const { world, s } = setup();
    const [winner, loser] = byRank(world, 'job-a');
    const claim = s.sign(loser!, 'task.claimed', { taskId: 'job-a', decision: decision(loser!.publicKey, 'job-a') });
    const done = s.sign(loser!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
    s.sign(winner!, 'task.claimed', { taskId: 'job-a', decision: decision(winner!.publicKey, 'job-a') }, { lamport: 0, parents: [claim.id, done.id] });
    const st = s.state();
    expect(st.tasks['job-a']!.owner).toBe(loser!.publicKey);
  });

  it('the classifier and the ledger agree on what a late, low clock means', () => {
    const { s, a, b } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey }, { lamport: 50 });
    s.sign(b, 'right.accepted', { transfer: 'x' });
    s.sign(a, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' }, { lamport: 1 });
    const st = s.state();
    expect(st.tokens['kit#0']!.holder).toBe(b.publicKey);
    expect(st.tokens['kit#0']!.state).toBe('held');
    const kinds = (list: { kind: string; tokenId?: string }[]) => list.filter((c) => c.tokenId === 'kit#0').map((c) => c.kind).sort();
    expect(kinds(classify(s.log.all(), st))).toEqual(kinds(st.conflicts));
  });
});

describe('claim tie-break', () => {
  it('a late concurrent claim cannot take a task from the team that finished it', () => {
    const { world, s } = setup();
    const [winner, finisher] = byRank(world, 'job-a');
    const left = s.sign(finisher!, 'task.claimed', { taskId: 'job-a', decision: decision(finisher!.publicKey, 'job-a') });
    s.sign(finisher!, 'task.accepted', { taskId: 'job-a', via: 'tap' });
    s.sign(finisher!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
    s.sign(winner!, 'task.claimed', { taskId: 'job-a', decision: decision(winner!.publicKey, 'job-a') }, { parents: [world.genesis.id], lamport: left.lamport });
    const st = s.state();
    expect(st.tasks['job-a']!.status).toBe('completed');
    expect(st.tasks['job-a']!.owner).toBe(finisher!.publicKey);
  });

  it('a late concurrent claim cannot take a task from the team already doing it', () => {
    const { world, s } = setup();
    const [winner, worker] = byRank(world, 'job-a');
    const left = s.sign(worker!, 'task.claimed', { taskId: 'job-a', decision: decision(worker!.publicKey, 'job-a') });
    s.sign(worker!, 'task.accepted', { taskId: 'job-a', via: 'tap' });
    s.sign(winner!, 'task.claimed', { taskId: 'job-a', decision: decision(winner!.publicKey, 'job-a') }, { parents: [world.genesis.id], lamport: left.lamport });
    expect(s.state().tasks['job-a']!.owner).toBe(worker!.publicKey);
  });
});

describe('rights are not stranded', () => {
  it('a released task gives its committed token back', () => {
    const { s, a } = setup();
    s.sign(a, 'task.claimed', { taskId: 'job-a', decision: decision(a.publicKey, 'job-a') });
    s.sign(a, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    s.sign(a, 'task.released', { taskId: 'job-a', reason: 'cannot do it' });
    const t = s.state().tokens['kit#0']!;
    expect(t.state).toBe('held');
  });
});

describe('cover rules', () => {
  it('an irreversible task cannot be covered without a human', () => {
    const world = buildWorld(3, 1);
    const spec = { ...world.capsule.tasks[0]!, id: 'one-way', reversible: false };
    const s = new Scribe(world);
    const [a, b] = world.keys;
    s.sign(a!, 'task.created', { spec, source: { kind: 'human' } });
    s.sign(a!, 'task.claimed', { taskId: 'one-way', decision: decision(a!.publicKey, 'one-way') });
    s.sign(b!, 'task.covered', { taskId: 'one-way', decision: decision(b!.publicKey, 'one-way') });
    expect(s.state().tasks['one-way']!.coveredBy ?? []).toEqual([]);
  });
});

describe('derived state stays a pure function of the event set', () => {
  it('any delivery order gives one state, ledger and classifier', () => {
    const { world, s, a, b, c } = setup();
    s.sign(a, 'right.offered', { transfer: 'x', tokens: ['kit#0'], to: b.publicKey });
    s.sign(b, 'right.accepted', { transfer: 'x' });
    s.sign(b, 'task.claimed', { taskId: 'job-a', decision: decision(b.publicKey, 'job-a') });
    s.sign(b, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    s.sign(c, 'task.claimed', { taskId: 'job-b', decision: decision(c.publicKey, 'job-b') });
    const all = s.log.all();
    const want = JSON.stringify(s.state());
    const ledger = JSON.stringify(deriveTokens(world.capsule, all, { team0: a.publicKey, team1: b.publicKey, team2: c.publicKey }).tokens);
    fc.assert(
      fc.property(fc.shuffledSubarray([...all, ...all], { minLength: all.length * 2, maxLength: all.length * 2 }), (order) => {
        const log = new EventLog(world.capsule.id);
        for (const e of order) log.ingest(e);
        expect(JSON.stringify(reduce(log.all(), world.roster))).toBe(want);
        expect(JSON.stringify(deriveTokens(world.capsule, order, { team0: a.publicKey, team1: b.publicKey, team2: c.publicKey }).tokens)).toBe(ledger);
      }),
      { numRuns: 80 },
    );
  });
});
