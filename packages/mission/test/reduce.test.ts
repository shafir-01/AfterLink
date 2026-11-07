import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalize, createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, MissionState } from '@afterlink/protocol';
import { claimRank, reduce } from '../src/index.ts';
import { accept, claim, complete, cover, create, decision, spec, stateOf, sync, world, type Device } from './helpers.ts';

const same = (a: MissionState, b: MissionState) => canonicalize(a) === canonicalize(b);
const conflictsOf = (s: MissionState, kind: string) => s.conflicts.filter((c) => c.kind === kind);

function shuffled<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Orders two devices by the tie-break rank for a task. */
function ranked(taskId: string, a: Device, b: Device): [Device, Device] {
  return claimRank(taskId, a.id) < claimRank(taskId, b.id) ? [a, b] : [b, a];
}

describe('seeding', () => {
  it('starts from genesis with open capsule tasks, issued tokens and roster actors', () => {
    const w = world();
    const s = stateOf(w.medics);
    expect(s.mission).toBe(w.capsule.id);
    expect(s.capsule?.name).toBe('Field Day');
    expect(Object.values(s.tasks).map((t) => t.status)).toEqual(w.capsule.tasks.map(() => 'open'));
    expect(s.tasks['open-first-aid']?.source).toEqual({ kind: 'capsule' });
    expect(s.tokens['evac-chair#1']?.holder).toBe(w.access.id);
    expect(Object.keys(s.actors).sort()).toEqual(w.roster.map((r) => r.actor).sort());
    expect(s.conflicts).toEqual([]);
    expect(s.eventCount).toBe(1);
  });

  it('holds no capsule until genesis arrives', () => {
    const w = world();
    const e = create(w.medics, spec('x'));
    const s = reduce([e], w.roster);
    expect(s.capsule).toBeNull();
    expect(s.tasks).toEqual({});
    expect(s.eventCount).toBe(1);
  });

  it('refuses a genesis signed by someone else, keeping the real one', () => {
    const w = world();
    const attacker = generateKeys();
    const fake = createEvent({
      keys: attacker,
      mission: w.capsule.id,
      seq: 1,
      prev: null,
      parents: [],
      lamport: 0,
      wall: 1,
      type: 'mission.issued',
      body: { capsule: { ...w.capsule, name: 'Hijacked', issuer: attacker.publicKey } },
    }) as AnyEvent;
    expect(reduce([fake], w.roster).capsule).toBeNull();
    const s = reduce([fake, w.genesis], w.roster);
    expect(s.capsule?.name).toBe('Field Day');
    expect(conflictsOf(s, 'forged-event')).toHaveLength(1);
  });
});

describe('task lifecycle', () => {
  it('walks open, claimed, accepted, completed', () => {
    const w = world();
    const id = 'open-first-aid';
    claim(w.medics, id);
    expect(stateOf(w.medics).tasks[id]).toMatchObject({ status: 'claimed', owner: w.medics.id });
    accept(w.medics, id);
    expect(stateOf(w.medics).tasks[id]?.status).toBe('accepted');
    complete(w.medics, id, 'Post open.');
    expect(stateOf(w.medics).tasks[id]).toMatchObject({ status: 'completed', evidence: 'Post open.', updatedAt: 2_000 });
    expect(stateOf(w.medics).conflicts).toEqual([]);
  });

  it('adds runtime tasks once, keyed by id and by external ref', () => {
    const w = world();
    const s1 = spec('a');
    create(w.medics, s1);
    create(w.supply, s1);
    w.medics.author.emit('task.created', { spec: spec('b'), source: { kind: 'external', ref: 'ticket-9' } }, 2_000);
    w.medics.author.emit('task.created', { spec: spec('c'), source: { kind: 'external', ref: 'ticket-9' } }, 2_000);
    const s = stateOf(w.medics);
    expect(s.tasks.a?.createdBy).toBe(w.medics.id);
    expect(s.tasks.b).toBeDefined();
    expect(s.tasks.c).toBeUndefined();
    expect(s.conflicts).toEqual([]);
  });

  it('keeps a task claimable after a refusal or deferral', () => {
    const w = world();
    create(w.supply, spec('a'));
    w.supply.author.emit('task.refused', { taskId: 'a', decision: decision(w.supply.id, 'a', 'REFUSED', { refusal: 'NO_RIGHT', next: ['WAIT_FOR_CONTACT'] }) }, 2_100);
    expect(stateOf(w.supply).tasks.a?.status).toBe('refused');
    w.supply.author.emit('task.deferred', { taskId: 'a', decision: decision(w.supply.id, 'a', 'DEFERRED') }, 2_200);
    expect(stateOf(w.supply).tasks.a?.status).toBe('deferred');
    claim(w.supply, 'a');
    const t = stateOf(w.supply).tasks.a!;
    expect(t.status).toBe('claimed');
    expect(t.decisions.map((d) => d.outcome)).toEqual(['REFUSED', 'DEFERRED', 'ACCEPTED']);
  });

  it('reopens a released task', () => {
    const w = world();
    create(w.supply, spec('a'));
    claim(w.supply, 'a');
    w.supply.author.emit('task.released', { taskId: 'a', reason: 'Called away.' }, 2_100);
    const t = stateOf(w.supply).tasks.a!;
    expect(t.status).toBe('open');
    expect(t.owner).toBeUndefined();
    expect(t.decisions.at(-1)).toMatchObject({ actor: w.supply.id, outcome: 'UNKNOWN', policy: 'task.released', reason: 'Called away.' });
  });
});

describe('concurrent claims', () => {
  function race() {
    const w = world();
    create(w.supply, spec('a'));
    sync(...w.all);
    const [winner, loser] = ranked('a', w.supply, w.facilities);
    const lost = claim(loser, 'a');
    const won = claim(winner, 'a');
    return { w, winner, loser, lost, won };
  }

  it('gives the task to the lowest hash on every replica, however the claims arrive', () => {
    const { w, winner, loser, lost, won } = race();
    expect(stateOf(loser).tasks.a?.owner).toBe(loser.id);
    sync(...w.all);
    for (const d of w.all) {
      const s = stateOf(d);
      expect(s.tasks.a?.owner).toBe(winner.id);
      expect(s.tasks.a?.decisions.map((x) => x.actor).sort()).toEqual([winner.id, loser.id].sort());
      const [conflict] = conflictsOf(s, 'double-claim');
      expect(conflict).toMatchObject({ id: 'double-claim:a', severity: 'policy', taskId: 'a', resolved: true });
      expect(conflict?.events.sort()).toEqual([lost.id, won.id].sort());
    }
  });

  it('marks a release by the race loser in the decisions and keeps the owner', () => {
    const { w, winner, loser } = race();
    sync(...w.all);
    loser.author.emit('task.released', { taskId: 'a', reason: 'Lost the claim.' }, 2_100);
    const t = stateOf(loser).tasks.a!;
    expect(t.owner).toBe(winner.id);
    expect(t.decisions.at(-1)).toMatchObject({ actor: loser.id, outcome: 'UNKNOWN', policy: 'task.released', reason: 'Lost the claim.' });
  });

  it('passes the task to the surviving claim when the winner releases', () => {
    const { w, winner, loser } = race();
    winner.author.emit('task.released', { taskId: 'a', reason: 'Called away.' }, 2_100);
    sync(...w.all);
    expect(stateOf(w.medics).tasks.a).toMatchObject({ owner: loser.id, status: 'claimed' });
  });

  it('counts a completion made before the loser could know', () => {
    const { w, winner, loser } = race();
    complete(loser, 'a', 'Finished in good faith.');
    sync(...w.all);
    expect(stateOf(w.medics).tasks.a).toMatchObject({ owner: winner.id, status: 'completed', evidence: 'Finished in good faith.' });
  });

  it('records a duplicate when both claimants finish while apart', () => {
    const { w, winner, loser } = race();
    complete(winner, 'a', 'From the winner.');
    complete(loser, 'a', 'From the loser.');
    sync(...w.all);
    const s = stateOf(w.medics);
    expect(s.tasks.a).toMatchObject({ status: 'completed', evidence: 'From the winner.' });
    expect(conflictsOf(s, 'duplicate-effort')).toHaveLength(1);
    expect(conflictsOf(s, 'double-claim')).toHaveLength(1);
  });

  it('treats acting after learning of the loss as stale, not as work', () => {
    const { w, winner, loser } = race();
    sync(...w.all);
    const late = accept(loser, 'a');
    const s = stateOf(loser);
    expect(s.tasks.a).toMatchObject({ owner: winner.id, status: 'claimed' });
    expect(conflictsOf(s, 'stale-decision')).toMatchObject([{ severity: 'policy', events: [late.id] }]);
  });
});

describe('cover', () => {
  function split() {
    const w = world();
    create(w.supply, spec('a'));
    sync(...w.all);
    claim(w.supply, 'a');
    accept(w.supply, 'a');
    sync(...w.all);
    return w;
  }

  it('adds coveredBy and leaves the owner in place', () => {
    const w = split();
    cover(w.facilities, 'a');
    const t = stateOf(w.facilities).tasks.a!;
    expect(t.owner).toBe(w.supply.id);
    expect(t.coveredBy).toEqual([w.facilities.id]);
    expect(t.decisions.map((d) => d.actor)).toEqual([w.supply.id, w.facilities.id]);
  });

  it('emits one duplicate-effort conflict with both completions preserved', () => {
    const w = split();
    cover(w.facilities, 'a');
    const ownerDone = complete(w.supply, 'a', 'Supply delivered.');
    const coverDone = complete(w.facilities, 'a', 'Facilities delivered.');
    sync(...w.all);
    for (const d of w.all) {
      const s = stateOf(d);
      expect(s.conflicts).toHaveLength(1);
      expect(s.conflicts[0]).toMatchObject({ id: 'duplicate-effort:a', kind: 'duplicate-effort', severity: 'policy', taskId: 'a' });
      expect(s.conflicts[0]?.events.sort()).toEqual([ownerDone.id, coverDone.id].sort());
      expect(s.conflicts[0]?.summary).toContain('Supply');
      expect(s.conflicts[0]?.summary).toContain('Facilities');
      expect(s.tasks.a).toMatchObject({ status: 'completed', owner: w.supply.id, coveredBy: [w.facilities.id], evidence: 'Supply delivered.' });
    }
  });

  it('raises no conflict when only the cover finishes', () => {
    const w = split();
    cover(w.facilities, 'a');
    complete(w.facilities, 'a');
    sync(...w.all);
    const s = stateOf(w.medics);
    expect(s.tasks.a?.status).toBe('completed');
    expect(s.conflicts).toEqual([]);
  });

  it('hands the task to the cover when the owner releases', () => {
    const w = split();
    cover(w.facilities, 'a');
    w.supply.author.emit('task.released', { taskId: 'a', reason: 'Called away.' }, 2_100);
    sync(...w.all);
    const t = stateOf(w.medics).tasks.a!;
    expect(t.owner).toBe(w.facilities.id);
    expect(t.coveredBy).toBeUndefined();
  });

  it('refuses cover on a task below the priority the capsule allows', () => {
    const w = world();
    create(w.supply, spec('low', { priority: 2 }));
    sync(...w.all);
    claim(w.supply, 'low');
    sync(...w.all);
    cover(w.facilities, 'low');
    const s = stateOf(w.facilities);
    expect(s.tasks.low?.coveredBy).toBeUndefined();
    expect(conflictsOf(s, 'unauthorised-action')).toHaveLength(1);
  });

  it('applies a human resolution while keeping both completions in the conflict', () => {
    const w = split();
    cover(w.facilities, 'a');
    complete(w.supply, 'a', 'Supply delivered.');
    const keep = complete(w.facilities, 'a', 'Facilities delivered.');
    sync(...w.all);
    w.medics.author.emit('conflict.resolved', { conflictId: 'duplicate-effort:a', resolution: 'Use the Facilities count.', keep: [keep.id] }, 2_500);
    const s = stateOf(w.medics);
    expect(s.conflicts[0]).toMatchObject({ resolved: true, resolution: 'Use the Facilities count.' });
    expect(s.conflicts[0]?.events).toHaveLength(2);
    expect(s.tasks.a?.evidence).toBe('Facilities delivered.');
  });
});

describe('rejection as data', () => {
  it('records an unknown actor without applying its events', () => {
    const w = world();
    const stranger = generateKeys();
    const e = createEvent({
      keys: stranger,
      mission: w.capsule.id,
      seq: 1,
      prev: null,
      parents: [w.genesis.id],
      lamport: 2,
      wall: 2_000,
      type: 'task.completed',
      body: { taskId: 'open-first-aid', evidence: 'Trust me.', via: 'tap' },
    }) as AnyEvent;
    const s = reduce([w.genesis, e], w.roster);
    expect(s.tasks['open-first-aid']?.status).toBe('open');
    expect(s.conflicts).toMatchObject([{ kind: 'forged-event', severity: 'violation', events: [e.id] }]);
    expect(s.actors[stranger.publicKey]).toBeUndefined();
    expect(s.eventCount).toBe(2);
  });

  it('refuses a token spend from an unknown actor', () => {
    const w = world();
    const stranger = generateKeys();
    const e = createEvent({
      keys: stranger,
      mission: w.capsule.id,
      seq: 1,
      prev: null,
      parents: [w.genesis.id],
      lamport: 2,
      wall: 2_000,
      type: 'right.committed',
      body: { tokens: ['evac-chair#1'], taskId: 'open-first-aid' },
    }) as AnyEvent;
    expect(reduce([w.genesis, e], w.roster).tokens['evac-chair#1']?.state).toBe('held');
  });

  it('records an event from another mission', () => {
    const w = world();
    const e = createEvent({
      keys: w.bundles.medics!.actor,
      mission: 'another',
      seq: 1,
      prev: null,
      parents: [],
      lamport: 2,
      wall: 2_000,
      type: 'task.completed',
      body: { taskId: 'open-first-aid', evidence: 'x', via: 'tap' },
    }) as AnyEvent;
    expect(conflictsOf(reduce([w.genesis, e], w.roster), 'forged-event')).toHaveLength(1);
  });

  it('refuses a join whose credential does not match the roster', () => {
    const w = world();
    w.medics.author.emit('actor.joined', { team: 'medics', name: 'Medics', credential: w.bundles.medics!.credential }, 2_000);
    expect(stateOf(w.medics).conflicts).toEqual([]);
    w.medics.author.emit('actor.joined', { team: 'medics', name: 'Medics', credential: w.bundles.supply!.credential }, 2_000);
    expect(conflictsOf(stateOf(w.medics), 'forged-event')).toHaveLength(1);
  });

  const cases: [string, (w: ReturnType<typeof world>) => { reader: Device; check: (s: MissionState) => void }][] = [
    ['a claim without the skills', (w) => {
      claim(w.supply, 'open-first-aid');
      return { reader: w.supply, check: (s) => expect(s.tasks['open-first-aid']).toMatchObject({ status: 'open' }) };
    }],
    ['a claim on a task nobody created', (w) => {
      claim(w.supply, 'ghost');
      return { reader: w.supply, check: (s) => expect(s.tasks.ghost).toBeUndefined() };
    }],
    ['a claim made after seeing another claim', (w) => {
      create(w.supply, spec('a'));
      claim(w.supply, 'a');
      sync(...w.all);
      claim(w.facilities, 'a');
      return { reader: w.facilities, check: (s) => expect(s.tasks.a?.owner).toBe(w.supply.id) };
    }],
    ['a claim made after seeing the task finished', (w) => {
      create(w.supply, spec('a'));
      claim(w.supply, 'a');
      complete(w.supply, 'a');
      sync(...w.all);
      claim(w.facilities, 'a');
      return { reader: w.facilities, check: (s) => expect(s.tasks.a?.owner).toBe(w.supply.id) };
    }],
    ['accepting a task without holding it', (w) => {
      accept(w.medics, 'open-first-aid');
      return { reader: w.medics, check: (s) => expect(s.tasks['open-first-aid']?.status).toBe('open') };
    }],
    ['completing a task without holding it', (w) => {
      complete(w.medics, 'open-first-aid');
      return { reader: w.medics, check: (s) => expect(s.tasks['open-first-aid']?.status).toBe('open') };
    }],
    ['releasing a task without holding it', (w) => {
      w.medics.author.emit('task.released', { taskId: 'open-first-aid', reason: 'x' }, 2_000);
      return { reader: w.medics, check: (s) => expect(s.tasks['open-first-aid']?.status).toBe('open') };
    }],
    ['starting token work with no token committed', (w) => {
      claim(w.supply, 'stock-first-aid');
      accept(w.supply, 'stock-first-aid');
      return { reader: w.supply, check: (s) => expect(s.tasks['stock-first-aid']?.status).toBe('claimed') };
    }],
    ['an automatic step on a task that needs a person', (w) => {
      create(w.supply, spec('close', { kind: 'site-closure' }));
      claim(w.supply, 'close');
      w.supply.author.emit('task.accepted', { taskId: 'close', via: 'auto' }, 2_000);
      return { reader: w.supply, check: (s) => expect(s.tasks.close?.status).toBe('claimed') };
    }],
    ['a task id reused for different work', (w) => {
      create(w.supply, spec('a'));
      create(w.supply, spec('a', { title: 'Something else' }));
      return { reader: w.supply, check: (s) => expect(s.tasks.a?.spec.title).toBe('Task a') };
    }],
    ['a task that cannot be read', (w) => {
      create(w.supply, { id: 'bad' } as never);
      return { reader: w.supply, check: (s) => expect(s.tasks.bad).toBeUndefined() };
    }],
  ];

  it.each(cases)('rejects %s without throwing', (_name, play) => {
    const w = world();
    const { reader, check } = play(w);
    const s = stateOf(reader);
    check(s);
    expect(conflictsOf(s, 'unauthorised-action')).toHaveLength(1);
    expect(s.conflicts[0]).toMatchObject({ severity: 'violation', resolved: false });
  });

  it('accepts token work once the right is committed, in either order', () => {
    const w = world();
    claim(w.supply, 'stock-first-aid');
    w.supply.author.emit('right.committed', { tokens: ['cart#1'], taskId: 'stock-first-aid' }, 2_000);
    accept(w.supply, 'stock-first-aid');
    const s = stateOf(w.supply);
    expect(s.tasks['stock-first-aid']?.status).toBe('accepted');
    expect(s.tokens['cart#1']).toMatchObject({ state: 'committed', committedTo: 'stock-first-aid' });
    expect(s.conflicts).toEqual([]);
  });

  it('refuses a commit of a token the actor does not hold, and the work that relied on it', () => {
    const w = world();
    claim(w.supply, 'stock-first-aid');
    w.supply.author.emit('right.committed', { tokens: ['cart#2'], taskId: 'stock-first-aid' }, 2_000);
    accept(w.supply, 'stock-first-aid');
    const s = stateOf(w.supply);
    expect(s.tokens['cart#2']?.state).toBe('held');
    expect(s.tasks['stock-first-aid']?.status).toBe('claimed');
    expect(s.conflicts.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses a decision signed for another actor', () => {
    const w = world();
    create(w.supply, spec('a'));
    w.supply.author.emit('task.claimed', { taskId: 'a', decision: decision(w.facilities.id, 'a') }, 2_000);
    const s = stateOf(w.supply);
    expect(s.tasks.a?.status).toBe('open');
    expect(conflictsOf(s, 'forged-event')).toHaveLength(1);
  });

  it('refuses an observation in another source name', () => {
    const w = world();
    w.supply.author.emit('observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: w.medics.id } }, 2_000);
    const s = stateOf(w.supply);
    expect(s.observations.k).toBeUndefined();
    expect(conflictsOf(s, 'forged-event')).toHaveLength(1);
  });
});

describe('observations and contingencies', () => {
  const gateClosed = (d: Device) =>
    d.author.emit('observation.recorded', { observation: { key: 'gate.north.open', value: false, subject: 'North gate', observedAt: 2_000, validForMs: 0, source: d.id } }, 2_000);

  it('keeps every observation of a key', () => {
    const w = world();
    gateClosed(w.supply);
    gateClosed(w.medics);
    sync(...w.all);
    expect(stateOf(w.access).observations['gate.north.open']).toHaveLength(2);
  });

  it('spawns the contingency task on every replica that holds the observation', () => {
    const w = world();
    expect(stateOf(w.access).tasks['west-gate-reroute']).toBeUndefined();
    const e = gateClosed(w.supply);
    sync(w.supply, w.medics);
    expect(stateOf(w.access).tasks['west-gate-reroute']).toBeUndefined();
    expect(stateOf(w.medics).tasks['west-gate-reroute']).toMatchObject({
      status: 'open',
      createdBy: w.supply.id,
      source: { kind: 'contingency', ref: 'north-gate-closed:west-gate-reroute' },
      updatedAt: e.wall,
    });
    sync(...w.all);
    expect(stateOf(w.access).tasks['west-gate-reroute']?.status).toBe('open');
  });

  it('stays quiet when the observation does not match the rule', () => {
    const w = world();
    w.supply.author.emit('observation.recorded', { observation: { key: 'gate.north.open', value: true, subject: 'North gate', observedAt: 2_000, validForMs: 0, source: w.supply.id } }, 2_000);
    expect(stateOf(w.supply).tasks['west-gate-reroute']).toBeUndefined();
  });

  it('treats a task.created for a spawned task as the same task', () => {
    const w = world();
    gateClosed(w.supply);
    const spawn = w.capsule.contingencies[0]!.then.spawn![0]!;
    w.supply.author.emit('task.created', { spec: spawn, source: { kind: 'contingency', ref: 'north-gate-closed:west-gate-reroute' } }, 2_100);
    const s = stateOf(w.supply);
    expect(Object.values(s.tasks).filter((t) => t.spec.id === spawn.id)).toHaveLength(1);
    expect(s.conflicts).toEqual([]);
  });
});

describe('actors', () => {
  it('tracks the last sequence and wall time seen from each actor', () => {
    const w = world();
    create(w.supply, spec('a'));
    claim(w.supply, 'a');
    expect(stateOf(w.supply).actors[w.supply.id]).toMatchObject({ lastSeq: 2, lastSeenWall: 2_000, team: 'supply', name: 'Supply' });
    expect(stateOf(w.supply).actors[w.medics.id]).toMatchObject({ lastSeq: 0, team: 'medics' });
  });
});

describe('convergence', () => {
  type Op =
    | { op: 'claim' | 'cover' | 'accept' | 'complete' | 'release' | 'refuse'; who: number; task: number }
    | { op: 'commit'; who: number; task: number; token: number }
    | { op: 'observe'; who: number; value: boolean }
    | { op: 'sync'; a: number; b: number };

  const TASKS = ['queue', 'stock-first-aid', 'open-first-aid', 'fix-it'];
  const TOKENS = ['cart#1', 'cart#2', 'aed#1'];

  const who = fc.integer({ min: 0, max: 3 });
  const task = fc.integer({ min: 0, max: TASKS.length - 1 });
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constantFrom('claim', 'cover', 'accept', 'complete', 'release', 'refuse') as fc.Arbitrary<'claim'>, who, task }),
    fc.record({ op: fc.constant('commit' as const), who, task, token: fc.integer({ min: 0, max: TOKENS.length - 1 }) }),
    fc.record({ op: fc.constant('observe' as const), who, value: fc.boolean() }),
    fc.record({ op: fc.constant('sync' as const), a: who, b: who }),
  );

  function play(ops: Op[]) {
    const w = world();
    create(w.supply, spec('queue'));
    create(w.facilities, spec('fix-it', { requires: ['repair'] }));
    sync(...w.all);
    for (const o of ops) {
      if (o.op === 'sync') {
        if (o.a !== o.b) sync(w.all[o.a]!, w.all[o.b]!);
        continue;
      }
      const d = w.all[o.who]!;
      if (o.op === 'observe') {
        d.author.emit('observation.recorded', { observation: { key: 'gate.north.open', value: o.value, subject: 'North gate', observedAt: 3_000, validForMs: 0, source: d.id } }, 3_000);
        continue;
      }
      const id = TASKS[o.task]!;
      if (o.op === 'claim') claim(d, id);
      else if (o.op === 'cover') cover(d, id);
      else if (o.op === 'accept') accept(d, id);
      else if (o.op === 'complete') complete(d, id);
      else if (o.op === 'release') d.author.emit('task.released', { taskId: id, reason: 'x' }, 3_000);
      else if (o.op === 'refuse') d.author.emit('task.refused', { taskId: id, decision: decision(d.id, id, 'REFUSED') }, 3_000);
      else d.author.emit('right.committed', { tokens: [TOKENS[o.token]!], taskId: id }, 3_000);
    }
    return w;
  }

  it('gives every replica the same state after any partial sync history', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const w = play(ops);
        sync(...w.all);
        sync(...w.all);
        const [first, ...rest] = w.all.map(stateOf);
        for (const s of rest) expect(same(first!, s)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('gives the same state for any arrival order and duplication of the event set', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), fc.infiniteStream(fc.double({ min: 0, max: 0.999999, noNaN: true })), (ops, stream) => {
        const w = play(ops);
        sync(...w.all);
        sync(...w.all);
        const events = w.medics.log.all();
        const expected = reduce(events, w.roster);
        const it = stream[Symbol.iterator]();
        const random = () => it.next().value as number;
        for (let i = 0; i < 3; i++) {
          const order = shuffled([...events, ...events.slice(0, 3)], random);
          expect(same(reduce(order, w.roster), expected)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });

  it('keeps every owner capable and every issued token on the ledger', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 30 }), (ops) => {
        const w = play(ops);
        sync(...w.all);
        sync(...w.all);
        const s = stateOf(w.medics);
        for (const t of Object.values(s.tasks)) {
          if (!t.owner) continue;
          const team = s.capsule!.teams.find((x) => x.id === s.actors[t.owner!]?.team);
          expect(t.spec.requires.every((c) => team?.capabilities.includes(c))).toBe(true);
        }
        const issued = s.capsule!.resources.flatMap((r) => r.tokens.map((k) => k.id)).sort();
        expect(Object.keys(s.tokens).sort()).toEqual(issued);
      }),
      { numRuns: 40 },
    );
  });

  it('does not mutate the capsule or the events it reads', () => {
    const w = world();
    create(w.supply, spec('a'));
    claim(w.supply, 'a');
    const events = w.supply.log.all();
    const before = canonicalize(events);
    const first = stateOf(w.supply);
    first.tasks.a!.decisions.length = 0;
    expect(canonicalize(events)).toBe(before);
    expect(stateOf(w.supply).tasks.a?.decisions).toHaveLength(1);
  });
});
