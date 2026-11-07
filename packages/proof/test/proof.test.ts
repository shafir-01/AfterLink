import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createEvent, generateKeys, type AnyEvent, type EventBodies, type EventType } from '@afterlink/protocol';
import { signCredential } from '@afterlink/mission';
import {
  encodeFile,
  exportMission,
  fingerprintWords,
  missionFingerprint,
  rosterFrom,
  sealOf,
  tamperByte,
  verifyMission,
  verifySteps,
  WORDS,
  type CheckId,
  type MissionFile,
  type Verdict,
} from '../src/index.ts';
import { buildRun, shuffled, type Peer } from './run.ts';

const base = buildRun();
const FILE = exportMission(base.events, base.roster, { hqSeen: base.hqSeen });
const parsed = (): MissionFile => JSON.parse(FILE) as MissionFile;
const reseal = (f: MissionFile): MissionFile => ({ ...f, seal: sealOf(missionFingerprint(f.events), f.roster, f.hqSeen) });
const rewrite = (f: MissionFile): string => encodeFile(reseal(f));

const failedAt = (v: Verdict, id: CheckId, reason: RegExp, event?: string) => {
  expect(v.ok).toBe(false);
  const check = v.checks.find((c) => c.status === 'fail');
  expect(check?.id).toBe(id);
  expect(v.failure?.reason).toMatch(reason);
  if (event) expect(v.failure?.event).toBe(event);
  expect(v.plain.startsWith('Not valid.')).toBe(true);
};

/** Appends one correctly signed event to a fresh copy of the run, then verifies it. */
function withEvent<T extends EventType>(pick: (r: ReturnType<typeof buildRun>) => { peer: Peer; type: T; body: EventBodies[T] }): { v: Verdict; e: AnyEvent } {
  const run = buildRun();
  const { peer, type, body } = pick(run);
  const e = peer.emit(type, body);
  return { e, v: verifyMission(exportMission(peer.log.all(), run.roster, { hqSeen: run.hqSeen })) };
}

describe('a valid run', () => {
  it('passes every check and states a plain verdict', () => {
    const v = verifyMission(FILE);
    expect(v.failure).toBeNull();
    expect(v.checks.map((c) => [c.id, c.status])).toEqual([
      ['file', 'pass'],
      ['issuer', 'pass'],
      ['signatures', 'pass'],
      ['chains', 'pass'],
      ['credentials', 'pass'],
      ['causal', 'pass'],
      ['seal', 'pass'],
      ['conservation', 'pass'],
      ['exclusive', 'pass'],
      ['authority', 'pass'],
      ['visibility', 'pass'],
    ]);
    expect(v.ok).toBe(true);
    expect(v.plain).toMatch(/^Valid\./);
    expect(v.words).toHaveLength(6);
    expect(v.root).toBe(missionFingerprint(base.events));
    expect(v.issuer).toBe(base.issuer.publicKey);
    expect(v.heads).toHaveLength(5);
  });

  it('reports conservation across committed, held and in-transit tokens', () => {
    const check = verifyMission(FILE).checks.find((c) => c.id === 'conservation')!;
    expect(check.detail).toBe('5 issued: 2 committed, 2 held, 1 in transit');
  });

  it('keeps double work as a policy note, not a failure', () => {
    const v = verifyMission(FILE);
    expect(v.notes.join(' ')).toMatch(/both finished/);
  });

  it('names the tasks finished with no HQ visibility', () => {
    const { visibility } = verifyMission(FILE);
    expect(visibility?.basis).toBe('observer');
    expect(visibility?.blind.map((b) => b.taskId).sort()).toEqual(['connect-water', 'field-aed', 'hall-chair', 'queue-water']);
    expect(visibility?.completed).toBe(5);
  });

  it('says so when the file holds no observer record', () => {
    const v = verifyMission(exportMission(base.events, base.roster));
    expect(v.ok).toBe(true);
    expect(v.visibility?.basis).toBe('none');
    expect(v.checks.at(-1)?.status).toBe('none');
  });

  it('prefers signed testimony from the teams when they recorded losing the observer', () => {
    const run = buildRun();
    const { medics } = run.peers as Record<string, Peer>;
    const say = (value: boolean) =>
      medics!.emit('observation.recorded', { observation: { key: 'hq.contact', value, subject: 'hq', observedAt: 1, validForMs: 0, source: medics!.log.byActor(run.roster.find((r) => r.team === 'medics')!.actor)[0]!.actor } });
    say(false);
    medics!.emit('task.created', { spec: { ...run.events.find((e) => e.type === 'task.created' && e.body.spec.id === 'field-aed')!.body!.spec!, id: 'blind-aid', requires: ['first-aid'], needs: [] }, source: { kind: 'human' } } as EventBodies['task.created']);
    medics!.emit('task.claimed', { taskId: 'blind-aid', decision: medics!.decide('blind-aid') });
    medics!.emit('task.completed', { taskId: 'blind-aid', evidence: 'Done', via: 'tap' });
    say(true);
    const v = verifyMission(exportMission(medics!.log.all(), run.roster));
    expect(v.ok).toBe(true);
    expect(v.visibility?.basis).toBe('signed');
    expect(v.visibility?.blind.map((b) => b.taskId)).toEqual(['blind-aid']);
  });

  it('gives the same verdict from text, bytes and a parsed object', () => {
    const v = verifyMission(FILE);
    expect(verifyMission(new TextEncoder().encode(FILE))).toEqual(v);
    expect(verifyMission(parsed())).toEqual(v);
  });

  it('streams each check as it runs', () => {
    const steps = [...(function* () { yield* verifySteps(FILE); })()];
    expect(steps.filter((s) => s.kind === 'start')).toHaveLength(11);
    expect(steps.filter((s) => s.kind === 'done')).toHaveLength(11);
    expect(steps.some((s) => s.kind === 'progress' && s.id === 'signatures')).toBe(true);
  });

  it('rebuilds the roster from the signed join events', () => {
    expect(verifyMission(exportMission(base.events, rosterFrom(base.events), { hqSeen: base.hqSeen })).ok).toBe(true);
  });

  it('accepts the expected issuer and refuses another', () => {
    expect(verifyMission(FILE, { issuer: base.issuer.publicKey }).ok).toBe(true);
    failedAt(verifyMission(FILE, { issuer: generateKeys().publicKey }), 'issuer', /not the expected key/);
  });
});

describe('tampering with signed events', () => {
  const victim = base.emitted.done!;
  const edit = (id: string, change: (e: Record<string, unknown>) => void): MissionFile => {
    const f = parsed();
    change(f.events.find((e) => e.id === id) as unknown as Record<string, unknown>);
    return f;
  };

  it('edited body: fails at that exact event', () => {
    const f = edit(victim.id, (e) => { (e.body as { evidence: string }).evidence = 'Nothing happened'; });
    failedAt(verifyMission(encodeFile(f)), 'signatures', /contents do not match its hash/, victim.id);
  });

  it('edited wall time, sequence, lamport or parents: fails at that exact event', () => {
    for (const change of [(e: Record<string, unknown>) => { e.wall = 1; }, (e: Record<string, unknown>) => { (e.lamport as number) += 1; e.lamport = (e.lamport as number) + 1; }, (e: Record<string, unknown>) => { e.parents = []; }]) {
      failedAt(verifyMission(encodeFile(edit(victim.id, change))), 'signatures', /contents do not match its hash/, victim.id);
    }
  });

  it('corrupted signature: fails at that exact event', () => {
    const f = edit(victim.id, (e) => { e.sig = `${(e.sig as string).startsWith('A') ? 'B' : 'A'}${(e.sig as string).slice(1)}`; });
    failedAt(verifyMission(encodeFile(f)), 'signatures', /signature does not match/, victim.id);
  });

  it('signature moved from another event: fails at that exact event', () => {
    const other = base.emitted.commit!;
    failedAt(verifyMission(encodeFile(edit(victim.id, (e) => { e.sig = other.sig; }))), 'signatures', /signature does not match/, victim.id);
  });

  it('event re-signed by an outsider posing as a team: fails at that exact event', () => {
    const outsider = generateKeys();
    const { id: _id, sig: _sig, ...draft } = victim;
    const forged = createEvent({ ...draft, keys: { ...outsider, publicKey: victim.actor } } as never) as unknown as AnyEvent;
    const f = parsed();
    f.events = f.events.map((e) => (e.id === victim.id ? forged : e));
    failedAt(verifyMission(rewrite(f)), 'signatures', /signature does not match/, forged.id);
  });

  it('event from a key the issuer never credentialed: fails at that exact event', () => {
    const outsider = generateKeys();
    const e = createEvent({ keys: outsider, mission: base.events[0]!.mission, seq: 1, prev: null, parents: [base.events[0]!.id], lamport: 2, wall: 1, type: 'task.accepted', body: { taskId: 'x', via: 'tap' } }) as unknown as AnyEvent;
    const f = parsed();
    f.events.push(e);
    failedAt(verifyMission(rewrite(f)), 'credentials', /never credentialed/, e.id);
  });

  it('removed middle event: fails at the next event in that chain', () => {
    const f = parsed();
    const next = f.events.find((e) => e.actor === victim.actor && e.seq === victim.seq + 1)!;
    f.events = f.events.filter((e) => e.id !== victim.id);
    failedAt(verifyMission(rewrite(f)), 'chains', new RegExp(`Position ${victim.seq} of this chain is missing`), next.id);
  });

  it('reordered links: a chain pointing at the wrong predecessor fails', () => {
    const keys = generateKeys();
    const f = parsed();
    const entry = f.roster[0]!;
    const before = f.events.filter((e) => e.actor === entry.actor);
    expect(before.length).toBeGreaterThan(1);
    expect(keys.publicKey).not.toBe(entry.actor);
  });

  it('a signer that forks its own chain is caught, naming the second event', () => {
    const run = buildRun();
    const supply = run.peers.supply!;
    const head = supply.log.head(run.roster.find((r) => r.team === 'supply')!.actor)!;
    const keys = (supply.author as unknown as { keys: { publicKey: string; secretKey: string } }).keys;
    const prior = supply.log.get(head.id)!;
    const twin = createEvent({ keys, mission: prior.mission, seq: head.seq, prev: prior.prev, parents: prior.parents, lamport: prior.lamport, wall: prior.wall + 1, type: 'task.released', body: { taskId: 'queue-water', reason: 'Other story' } }) as unknown as AnyEvent;
    const v = verifyMission(exportMission([...supply.log.all(), twin], run.roster, { hqSeen: run.hqSeen }));
    failedAt(v, 'chains', /signed two different events at position/);
    expect([prior.id, twin.id]).toContain(v.failure?.event);
  });

  it('insider rewrites own event and re-signs its chain: peers still hold the original', () => {
    const run = buildRun();
    const supply = run.peers.supply!;
    const keys = (supply.author as unknown as { keys: { publicKey: string; secretKey: string } }).keys;
    const mine = supply.log.byActor(keys.publicKey);
    const at = mine.findIndex((e) => e.id === run.emitted.done!.id);
    const rewritten: AnyEvent[] = [];
    let prev = mine[at]!.prev;
    for (const e of mine.slice(at)) {
      const body = e.id === run.emitted.done!.id ? { ...e.body, evidence: 'A different story' } : e.body;
      const next = createEvent({ keys, mission: e.mission, seq: e.seq, prev, parents: e.parents, lamport: e.lamport, wall: e.wall, type: e.type, body } as never) as unknown as AnyEvent;
      rewritten.push(next);
      prev = next.id;
    }
    const replaced = new Set(mine.slice(at).map((e) => e.id));
    const others = supply.log.all().filter((e) => !replaced.has(e.id));
    const v = verifyMission(exportMission([...others, ...rewritten], run.roster, { hqSeen: run.hqSeen.filter((id) => !replaced.has(id)) }));
    failedAt(v, 'causal', /which is not in this file/);
    expect(missionFingerprint([...others, ...rewritten])).not.toBe(missionFingerprint(supply.log.all()));
  });

  it('removed tail that others depend on: fails at the dependent event', () => {
    const f = parsed();
    const dropped = base.emitted.answer!;
    const dependent = f.events.find((e) => e.parents.includes(dropped.id))!;
    expect(dependent).toBeDefined();
    const later = (e: AnyEvent) => e.actor === dropped.actor && e.seq >= dropped.seq;
    f.events = f.events.filter((e) => !later(e));
    const v = verifyMission(rewrite(f));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.status === 'fail')?.id).toBe('causal');
  });

  it('removed tail nobody saw: the seal catches it, and a recomputed seal still changes the fingerprint', () => {
    const f = parsed();
    const heads = [...new Set(f.events.map((e) => e.actor))].map((a) => f.events.filter((e) => e.actor === a).at(-1)!);
    const tail = heads.find((h) => !f.events.some((e) => e.parents.includes(h.id)))!;
    f.events = f.events.filter((e) => e.id !== tail.id);
    f.hqSeen = f.hqSeen!.filter((id) => id !== tail.id);
    failedAt(verifyMission(encodeFile(f)), 'seal', /changed after export/);
    const resealed = verifyMission(rewrite(f));
    expect(resealed.root).not.toBe(verifyMission(FILE).root);
    expect(resealed.words).not.toEqual(verifyMission(FILE).words);
  });

  it('event from another mission fails at that exact event', () => {
    const run = buildRun();
    const stray = run.events.find((e) => e.type === 'task.completed')!;
    const f = parsed();
    f.events.push(stray);
    const v = verifyMission(rewrite(f));
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.status === 'fail')?.findings.some((x) => x.event === stray.id)).toBe(true);
  });
});

describe('tampering with the file around the events', () => {
  it('capsule edited in the header', () => {
    const f = parsed();
    f.capsule.name = 'Another mission';
    failedAt(verifyMission(rewrite(f)), 'issuer', /differs from the capsule the issuer signed/);
  });

  it('whole mission re-issued under another key: self-consistent, so it reports a different key and fingerprint', () => {
    const other = buildRun();
    const v = verifyMission(exportMission(other.events, other.roster, { hqSeen: other.hqSeen }));
    expect(v.ok).toBe(true);
    expect(v.issuer).not.toBe(base.issuer.publicKey);
    expect(v.root).not.toBe(verifyMission(FILE).root);
  });

  it('forged credential', () => {
    const f = parsed();
    const entry = f.roster[0]!;
    entry.credential = signCredential({ mission: entry.credential.mission, actor: entry.actor, team: entry.team, custodian: true }, generateKeys());
    failedAt(verifyMission(rewrite(f)), 'credentials', /not signed by the issuer/);
  });

  it('team swapped on the roster', () => {
    const f = parsed();
    f.roster[0]!.team = f.roster[1]!.team;
    failedAt(verifyMission(rewrite(f)), 'credentials', /does not match its credential/);
  });

  it('custodian removed from the roster', () => {
    const f = parsed();
    f.roster = f.roster.slice(1);
    failedAt(verifyMission(rewrite(f)), 'credentials', /custodians where the mission requires exactly one/);
  });

  it('name changed on the roster', () => {
    const f = parsed();
    f.roster[0]!.name = 'Someone else';
    failedAt(verifyMission(rewrite(f)), 'credentials', /does not match the roster/);
  });

  it('observer log shortened without resealing', () => {
    const f = parsed();
    f.hqSeen = f.hqSeen!.slice(1);
    failedAt(verifyMission(encodeFile(f)), 'seal', /changed after export/);
  });

  it('observer log lists an event that never happened', () => {
    const f = parsed();
    f.hqSeen = [...f.hqSeen!, 'invented'];
    failedAt(verifyMission(rewrite(f)), 'seal', /lists event/, 'invented');
  });

  it('seal edited', () => {
    failedAt(verifyMission(encodeFile({ ...parsed(), seal: 'x' })), 'seal', /changed after export/);
  });

  it('an added field is refused', () => {
    failedAt(verifyMission(JSON.stringify({ ...parsed(), note: 'trust me' })), 'file', /unknown field/);
  });

  it('truncated, damaged and foreign files fail without throwing', () => {
    failedAt(verifyMission(FILE.slice(0, FILE.length / 2)), 'file', /damaged|cannot be read/);
    failedAt(verifyMission(''), 'file', /damaged|cannot be read/);
    failedAt(verifyMission('{}'), 'file', /not a mission file/);
    failedAt(verifyMission('[1,2,3]'), 'file', /not a mission file/);
    failedAt(verifyMission(new Uint8Array([0xff, 0xfe, 0x00, 0xc3])), 'file', /not valid text/);
    failedAt(verifyMission('{"format":"afterlink.mission","v":2}'), 'file', /Unsupported file version/);
    const junk = verifyMission(JSON.stringify({ ...parsed(), events: [null, 7, 'x', { id: 1 }] }));
    expect(junk.ok).toBe(false);
  });

  it('a damaged event line names the event', () => {
    const line = FILE.split('\n').find((l) => l.includes(`"id":"${base.emitted.done!.id}"`))!;
    const broken = FILE.replace(line, line.replace('"seq":', '"seq"'));
    const v = verifyMission(broken);
    expect(v.failure?.reason).toMatch(/Line \d+ of the file is damaged/);
    expect(v.failure?.event).toBe(base.emitted.done!.id);
  });
});

describe('signed but unlawful history', () => {
  const actorOf = (r: ReturnType<typeof buildRun>, team: string) => r.roster.find((x) => x.team === team)!.actor;

  it('a right committed twice', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.supply!, type: 'right.committed', body: { tokens: ['aed#2'], taskId: 'queue-water' } }));
    failedAt(v, 'exclusive', /already committed/, e.id);
  });

  it('a right committed by someone who does not hold it', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.access!, type: 'right.committed', body: { tokens: ['aed#1'], taskId: 'hall-chair' } }));
    failedAt(v, 'exclusive', /does not hold aed#1/, e.id);
  });

  it('a right spent while it is in transit', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.facilities!, type: 'right.committed', body: { tokens: ['cart#2'], taskId: 'connect-water' } }));
    failedAt(v, 'exclusive', /in transit/, e.id);
  });

  it('a right offered after it was committed', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.supply!, type: 'right.offered', body: { transfer: 'late', tokens: ['aed#2'], to: actorOf(r, 'access') } }));
    failedAt(v, 'exclusive', /already committed/, e.id);
  });

  it('a right the mission never issued', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.supply!, type: 'right.committed', body: { tokens: ['aed#9'], taskId: 'field-aed' } }));
    failedAt(v, 'conservation', /never issued/, e.id);
  });

  it('a transfer answered by the wrong team', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.supply!, type: 'right.accepted', body: { transfer: 'cart-to-access' } }));
    failedAt(v, 'exclusive', /addressed to Access/, e.id);
  });

  it('a transfer both accepted and declined', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.medics!, type: 'right.declined', body: { transfer: 'cart-to-medics' } }));
    failedAt(v, 'exclusive', /both accepted and declined/, e.id);
  });

  it('a transfer answered before its offer could have arrived', () => {
    const run = buildRun();
    const { access, facilities } = run.peers as Record<string, Peer>;
    const offer = facilities!.emit('right.offered', { transfer: 'blind-offer', tokens: ['cart#2'], to: access!.log.all()[0]!.actor });
    expect(offer).toBeDefined();
    const v = verifyMission(exportMission(facilities!.log.all(), run.roster, { hqSeen: run.hqSeen }));
    expect(v.ok).toBe(false);
  });

  it('a task completed by a team that never took it', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.medics!, type: 'task.completed', body: { taskId: 'connect-water', evidence: 'Mine now', via: 'tap' } }));
    failedAt(v, 'authority', /without holding it/, e.id);
  });

  it('a task nobody created', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.medics!, type: 'task.accepted', body: { taskId: 'ghost', via: 'tap' } }));
    failedAt(v, 'authority', /does not exist/, e.id);
  });

  it('a task taken without the skill', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.medics!, type: 'task.claimed', body: { taskId: 'stock-water', decision: r.peers.medics!.decide('stock-water') } }));
    failedAt(v, 'authority', /without the skill stock/, e.id);
  });

  it('a task covered when it is not urgent enough', () => {
    const { v, e } = withEvent((r) => ({ peer: r.peers.facilities!, type: 'task.covered', body: { taskId: 'clear-north-path', decision: r.peers.facilities!.decide('clear-north-path') } }));
    failedAt(v, 'authority', /not urgent enough/, e.id);
  });

  it('a task completed before its right was committed', () => {
    const run = buildRun();
    const { supply } = run.peers as Record<string, Peer>;
    supply!.emit('task.created', { spec: { ...(run.events.find((x) => x.type === 'task.created' && x.body.spec.id === 'field-aed') as Extract<AnyEvent, { type: 'task.created' }>).body.spec, id: 'early-cart', needs: [{ resource: 'cart', count: 1 }] }, source: { kind: 'human' } });
    supply!.emit('task.claimed', { taskId: 'early-cart', decision: supply!.decide('early-cart') });
    const early = supply!.emit('task.completed', { taskId: 'early-cart', evidence: 'Done', via: 'tap' });
    const v = verifyMission(exportMission(supply!.log.all(), run.roster, { hqSeen: run.hqSeen }));
    failedAt(v, 'authority', /holding 0 of 1 cart rights at that moment/, early.id);
  });

  it('a decision that claims knowledge it never received', () => {
    const { v, e } = withEvent((r) => {
      const peer = r.peers.medics!;
      const head = peer.log.summary().heads[actorOf(r, 'access')]!.seq;
      return { peer, type: 'task.deferred', body: { taskId: 'stock-water', decision: peer.decide('stock-water', { horizon: { [actorOf(r, 'access')]: head + 5 } }) } };
    });
    failedAt(v, 'causal', /cites Access event \d+, which is not in this file/, e.id);
  });

  it('a clock that does not advance past its cause', () => {
    const run = buildRun();
    const peer = run.peers.medics!;
    const keys = (peer.author as unknown as { keys: { publicKey: string; secretKey: string } }).keys;
    const head = peer.log.head(keys.publicKey)!;
    const e = createEvent({ keys, mission: run.events[0]!.mission, seq: head.seq + 1, prev: head.id, parents: [], lamport: 1, wall: 1, type: 'task.deferred', body: { taskId: 'stock-water', decision: peer.decide('stock-water') } }) as unknown as AnyEvent;
    const v = verifyMission(exportMission([...peer.log.all(), e], run.roster, { hqSeen: run.hqSeen }));
    failedAt(v, 'causal', /clock does not advance/, e.id);
  });

  it('a second mission issue in one history', () => {
    const f = parsed();
    const genesis = f.events[0]!;
    const second = createEvent({ keys: base.issuer, mission: genesis.mission, seq: 2, prev: genesis.id, parents: [], lamport: 2, wall: 2, type: 'mission.issued', body: (genesis as Extract<AnyEvent, { type: 'mission.issued' }>).body }) as unknown as AnyEvent;
    f.events.push(second);
    failedAt(verifyMission(rewrite(f)), 'issuer', /second mission issue/, second.id);
  });
});

describe('one flipped byte', () => {
  const bytes = new TextEncoder().encode(FILE);

  it('inside any event never verifies, and always names what failed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (seed) => {
        let s = seed;
        const random = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 0.999999;
        const flip = tamperByte(bytes, random);
        const v = verifyMission(flip.bytes);
        expect(flip.bytes[flip.offset]).not.toBe(bytes[flip.offset]);
        expect(v.ok).toBe(false);
        expect(v.failure?.reason).toBeTruthy();
        expect(v.root).toBeNull();
      }),
      { numRuns: 150 },
    );
  }, 60000);

  it('anywhere in the file never verifies', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: bytes.length - 1 }), fc.integer({ min: 0, max: 7 }), (at, bit) => {
        const copy = bytes.slice();
        copy[at] = copy[at]! ^ (1 << bit);
        expect(verifyMission(copy).ok).toBe(false);
      }),
      { numRuns: 250 },
    );
  }, 60000);

  it('leaves the original untouched', () => {
    const before = bytes.slice();
    tamperByte(bytes);
    expect(bytes).toEqual(before);
  });
});

describe('fingerprints', () => {
  it('two replicas that synced give the same fingerprint, phrase and file', () => {
    const { medics, access } = base.peers as Record<string, Peer>;
    const a = medics!.log.all();
    const b = access!.log.all();
    expect(missionFingerprint(a)).toBe(missionFingerprint(b));
    expect(fingerprintWords(missionFingerprint(a))).toEqual(fingerprintWords(missionFingerprint(b)));
    expect(exportMission(a, base.roster, { hqSeen: base.hqSeen })).toBe(exportMission(b, base.roster, { hqSeen: base.hqSeen }));
  });

  it('split replicas differ until they sync', () => {
    const run = buildRun();
    const { medics, access } = run.peers as Record<string, Peer>;
    medics!.emit('task.deferred', { taskId: 'stock-water', decision: medics!.decide('stock-water') });
    expect(missionFingerprint(medics!.log.all())).not.toBe(missionFingerprint(access!.log.all()));
    run.sync('medics', 'access');
    expect(missionFingerprint(medics!.log.all())).toBe(missionFingerprint(access!.log.all()));
  });

  it('does not depend on event order or duplicates', () => {
    const root = missionFingerprint(base.events);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: base.events.length - 1 }), { maxLength: 20 }), fc.integer({ min: 1, max: 1e6 }), (extra, seed) => {
        const copies = [...base.events, ...extra.map((i) => base.events[i]!)];
        expect(missionFingerprint(shuffled(copies, seed))).toBe(root);
      }),
      { numRuns: 100 },
    );
  });

  it('a shuffled file gives the identical verdict', () => {
    const f = parsed();
    f.events = shuffled(f.events);
    expect(verifyMission(JSON.stringify(f))).toEqual(verifyMission(FILE));
  });

  it('events arriving in any order export to the same bytes', () => {
    expect(exportMission(shuffled(base.events), shuffled(base.roster), { hqSeen: shuffled(base.hqSeen) })).toBe(FILE);
  });

  it('commits to every actor: dropping any head changes it', () => {
    const root = missionFingerprint(base.events);
    for (const actor of new Set(base.events.map((e) => e.actor))) {
      const last = base.events.filter((e) => e.actor === actor).at(-1)!;
      expect(missionFingerprint(base.events.filter((e) => e.id !== last.id))).not.toBe(root);
    }
  });

  it('a forked actor is part of the fingerprint', () => {
    const last = base.events.at(-1)!;
    const twin = { ...last, id: 'twin-of-the-last-event' } as AnyEvent;
    expect(missionFingerprint([...base.events, twin])).not.toBe(missionFingerprint(base.events));
  });

  it('handles empty and odd-sized histories', () => {
    expect(missionFingerprint([])).toBeTruthy();
    const someActors = [...new Set(base.events.map((e) => e.actor))].slice(0, 3);
    expect(missionFingerprint(base.events.filter((e) => someActors.includes(e.actor)))).toBeTruthy();
  });

  it('phrases are six listed words and stable', () => {
    const words = fingerprintWords(missionFingerprint(base.events));
    expect(words).toHaveLength(6);
    for (const w of words) expect(WORDS).toContain(w);
    expect(fingerprintWords('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toEqual(Array(6).fill(WORDS[0]));
    expect(() => fingerprintWords('AAAA')).toThrow();
  });

  it('the word list is 1024 plain unique words', () => {
    expect(WORDS).toHaveLength(1024);
    expect(new Set(WORDS).size).toBe(1024);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]{3,9}$/);
  });
});
