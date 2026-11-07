import { describe, expect, it } from 'vitest';
import { festivalCapsule, provision } from '@afterlink/mission';
import { createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, EventBodies, EventType } from '@afterlink/protocol';
import { exportMission, missionFingerprint, rosterFrom, sealOf, verifyMission, type MissionFile, FORMAT } from '@afterlink/proof';
import { buildWorld, type Keys, type World } from './explorer.ts';

function scribe(world: World) {
  const events: AnyEvent[] = [world.genesis];
  const heads = new Map<string, AnyEvent>();
  const sign = <T extends EventType>(k: Keys, type: T, body: EventBodies[T], wall = 2000): AnyEvent => {
    const prev = heads.get(k.publicKey);
    const tips = new Set(events.map((e) => e.id));
    for (const e of events) {
      if (e.prev) tips.delete(e.prev);
      for (const p of e.parents) tips.delete(p);
    }
    const e = createEvent({
      keys: k,
      mission: world.capsule.id,
      seq: (prev?.seq ?? 0) + 1,
      prev: prev?.id ?? null,
      parents: [...tips].filter((id) => events.find((x) => x.id === id)!.actor !== k.publicKey),
      lamport: Math.max(...events.map((x) => x.lamport)) + 1,
      wall,
      type,
      body,
    }) as AnyEvent;
    events.push(e);
    heads.set(k.publicKey, e);
    return e;
  };
  return { events, sign };
}

const decision = (actor: string, taskId: string) => ({ id: `d${actor}${taskId}`, actor, taskId, outcome: 'ACCEPTED' as const, reason: 'r', policy: 'p', reachable: [], horizon: {}, inputs: [] });

function honestMission() {
  const world = buildWorld(2, 1);
  const { events, sign } = scribe(world);
  world.keys.forEach((k, i) => {
    const r = world.roster[i]!;
    sign(k, 'actor.joined', { team: r.team, name: r.name, credential: r.credential });
  });
  const [a, b] = world.keys;
  sign(a!, 'task.claimed', { taskId: 'job-a', decision: decision(a!.publicKey, 'job-a') });
  sign(a!, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
  sign(a!, 'task.completed', { taskId: 'job-a', evidence: 'done', via: 'tap' });
  sign(b!, 'observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: b!.publicKey } });
  return { world, events, sign };
}

/** Rebuilds the file around a changed event list, recomputing the unsigned seal as a forger can. */
function reseal(world: World, events: AnyEvent[], hqSeen: string[] | null = null): string {
  return exportMission(events, world.roster, { hqSeen });
}

describe('mission file verification', () => {
  it('passes an honest mission, and the fingerprint is stable', () => {
    const { world, events } = honestMission();
    const v = verifyMission(reseal(world, events));
    expect(v.ok).toBe(true);
    expect(verifyMission(reseal(world, [...events].reverse())).root).toBe(v.root);
  });

  it('fails on a flipped byte in any event', () => {
    const { world, events } = honestMission();
    const text = reseal(world, events);
    expect(verifyMission(text.replace('"evidence":"done"', '"evidence":"dome"')).ok).toBe(false);
  });

  it('fails when one event is removed from the middle of a chain', () => {
    const { world, events } = honestMission();
    const cut = events.filter((e) => e.type !== 'right.committed');
    expect(verifyMission(reseal(world, cut)).ok).toBe(false);
  });

  it('does not call a mission complete when the end of an actor chain may have been cut', () => {
    const { world, events } = honestMission();
    const last = events.filter((e) => e.actor === world.keys[0]!.publicKey).at(-1)!;
    expect(last.type).toBe('task.completed');
    const cut = events.filter((e) => e.id !== last.id);
    const v = verifyMission(reseal(world, cut));
    const says = JSON.stringify(v);
    expect(v.ok === false || /cannot|not prove|complete history|truncat|missing/i.test(says)).toBe(true);
  });

  it('hides nothing by cutting a double spend off the end of a chain: the file says what it cannot prove', () => {
    const world = buildWorld(2, 1);
    const { events, sign } = scribe(world);
    world.keys.forEach((k, i) => {
      const r = world.roster[i]!;
      sign(k, 'actor.joined', { team: r.team, name: r.name, credential: r.credential });
    });
    sign(world.keys[0]!, 'right.committed', { tokens: ['kit#0'], taskId: 'job-a' });
    const spent = sign(world.keys[0]!, 'right.committed', { tokens: ['kit#0'], taskId: 'job-b' });
    expect(verifyMission(reseal(world, events)).ok).toBe(false);
    const hidden = verifyMission(reseal(world, events.filter((e) => e.id !== spent.id)));
    expect(hidden.ok === false || hidden.notes.some((n) => /complete|cut|remove|truncat/i.test(n))).toBe(true);
  });

  it('a mission forged end to end with a fresh issuer key is not reported as the real one', () => {
    const real = honestMission();
    const fake = honestMission();
    expect(fake.world.capsule.issuer).not.toBe(real.world.capsule.issuer);
    const verdict = verifyMission(reseal(fake.world, fake.events), { issuer: real.world.capsule.issuer });
    expect(verdict.ok).toBe(false);
  });

  it('without a pinned issuer the verdict does not claim more than the key it rests on', () => {
    const fake = honestMission();
    const v = verifyMission(reseal(fake.world, fake.events));
    expect(v.issuer).toBe(fake.world.capsule.issuer);
    expect(v.plain).toMatch(/issuer|key|signed by/i);
  });

  it('a forged observer log cannot rewrite who saw what without being labelled unsigned', () => {
    const { world, events } = honestMission();
    const honest = verifyMission(reseal(world, events, events.map((e) => e.id)));
    const forged = verifyMission(reseal(world, events, []));
    expect(honest.ok).toBe(true);
    expect(forged.ok).toBe(true);
    if (forged.visibility?.blind.length) expect(forged.visibility.basis).not.toBe('signed');
  });

  it('never throws on hostile input', () => {
    const inputs: unknown[] = ['', 'x', '{}', '[]', 'null', '{"format":"afterlink.mission"}', `{"format":"${FORMAT}","v":1,"events":5}`, new Uint8Array([0, 1, 2]), null, 5, {}];
    for (const x of inputs) expect(() => verifyMission(x as string)).not.toThrow();
  });

  it('survives an event body that would crash a reducer', () => {
    const { world, events, sign } = honestMission();
    sign(world.keys[0]!, 'right.committed', { tokens: 5, taskId: 'job-b' } as never);
    expect(() => verifyMission(reseal(world, events))).not.toThrow();
    expect(verifyMission(reseal(world, events)).ok).toBe(false);
  });

  it('rejects a roster edited to add a second custodian', () => {
    const { world, events } = honestMission();
    const intruder = generateKeys();
    const roster = [...world.roster, { ...world.roster[0]!, actor: intruder.publicKey }];
    expect(verifyMission(exportMission(events, roster)).ok).toBe(false);
  });

  it('rejects a capsule swapped for one with more tokens', () => {
    const { world, events } = honestMission();
    const file = JSON.parse(reseal(world, events)) as MissionFile;
    const capsule = structuredClone(file.capsule);
    capsule.resources[0]!.tokens.push({ id: 'kit#9', holderTeam: 'team0' });
    const root = missionFingerprint(file.events);
    const forged: MissionFile = { ...file, capsule, seal: sealOf(root, file.roster, file.hqSeen) };
    expect(verifyMission(JSON.stringify(forged)).ok).toBe(false);
  });

  it('a real festival mission round-trips', () => {
    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer, { now: 5 });
    const { genesis, bundles } = provision(capsule, issuer, 'r');
    const events: AnyEvent[] = [genesis as AnyEvent];
    for (const b of Object.values(bundles)) {
      events.push(
        createEvent({ keys: b.actor, mission: capsule.id, seq: 1, prev: null, parents: [genesis.id], lamport: 2, wall: 6, type: 'actor.joined', body: { team: b.team, name: b.name, credential: b.credential } }) as AnyEvent,
      );
    }
    expect(verifyMission(exportMission(events, rosterFrom(events))).ok).toBe(true);
  });
});
