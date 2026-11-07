import { afterEach, describe, expect, it } from 'vitest';
import { conservation } from '@afterlink/authority';
import { buildPacket } from '@afterlink/ferry';
import { Author, EventLog, createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, FerryPacket } from '@afterlink/protocol';
import { Fleet, TEAMS, doubleSpends, forks } from './fleet.ts';

let fleet: Fleet;
afterEach(() => fleet?.stop());

const LEFT = ['medics', 'access'];
const RIGHT = ['facilities', 'supply'];
const received = (f: Fleet, team: string) => f.node(team).events().filter((e) => e.type === 'ferry.received' && e.actor === f.id(team)).length;

describe('carrying updates between split groups on real actors', () => {
  it('a carried task arrives, and repeat scans change nothing, even across a restart', async () => {
    fleet = await Fleet.start();
    fleet.split(LEFT, RIGHT);
    await fleet.run(1000);
    fleet.node('medics').submitTask(fleet.task('carried', { requires: ['haul'] }), { kind: 'human' });
    await fleet.run(500);
    const packet = fleet.node('medics').buildFerry(fleet.node('supply').view().summary);
    const first = fleet.node('supply').ingestFerry(packet);
    expect(first.newEvents).toBeGreaterThan(0);
    expect(fleet.node('supply').view().state.tasks['carried']).toBeTruthy();
    await fleet.run(500);
    const size = fleet.node('supply').events().length;
    for (let i = 0; i < 5; i++) expect(fleet.node('supply').ingestFerry(packet).newEvents).toBe(0);
    await fleet.run(500);
    expect(received(fleet, 'supply')).toBe(1);
    fleet.node('supply').stop();
    await fleet.run(200);
    await fleet.boot('supply');
    fleet.node('supply').ingestFerry(packet);
    await fleet.run(500);
    expect(received(fleet, 'supply')).toBe(1);
    expect(fleet.node('supply').events().length).toBeGreaterThanOrEqual(size);
  });

  it('a replayed old packet does not make a silent peer look heard', async () => {
    fleet = await Fleet.start();
    fleet.split(LEFT, RIGHT);
    await fleet.run(1000);
    fleet.node('medics').observe('old', 1);
    await fleet.run(200);
    const packet = fleet.node('medics').buildFerry();
    fleet.node('supply').ingestFerry(packet);
    await fleet.run(30000);
    const before = fleet.node('supply').view().lastHeard[fleet.id('medics')];
    fleet.node('supply').ingestFerry(packet);
    expect(fleet.node('supply').view().lastHeard[fleet.id('medics')]).toBe(before);
  });

  it('an old packet cannot lower what a device knows', async () => {
    fleet = await Fleet.start();
    const old = fleet.node('medics').buildFerry();
    fleet.node('medics').observe('newer', 1);
    await fleet.run(2000);
    const heads = JSON.stringify(fleet.node('supply').view().summary.heads);
    fleet.node('supply').ingestFerry(old);
    expect(JSON.stringify(fleet.node('supply').view().summary.heads)).toBe(heads);
  });

  it('a right crosses the gap by carried packets, both ways, and is never held twice', async () => {
    fleet = await Fleet.start();
    fleet.split(LEFT, RIGHT);
    await fleet.run(1000);
    expect(fleet.node('access').offerTokens(['evac-chair#1'], fleet.id('supply'))).toBeNull();
    const transfer = fleet.node('access').offerTokens(['evac-chair#1'], fleet.id('supply'), { carry: true });
    expect(transfer).not.toBeNull();
    await fleet.run(300);
    fleet.node('supply').ingestFerry(fleet.node('access').buildFerry(fleet.node('supply').view().summary));
    await fleet.run(300);
    expect(fleet.node('access').view().state.tokens['evac-chair#1']!.state).toBe('in-transit');
    expect(fleet.node('supply').answerTransfer(transfer!, true)).toBe(true);
    await fleet.run(300);
    expect(fleet.node('supply').view().tokens.map((t) => t.id)).toContain('evac-chair#1');
    expect(fleet.node('access').view().tokens.map((t) => t.id)).not.toContain('evac-chair#1');
    fleet.node('access').ingestFerry(fleet.node('supply').buildFerry(fleet.node('access').view().summary));
    await fleet.run(300);
    expect(fleet.node('access').view().state.tokens['evac-chair#1']!.holder).toBe(fleet.id('supply'));
    fleet.net.heal();
    await fleet.run(10000);
    for (const t of TEAMS) expect(fleet.node(t).view().state.tokens['evac-chair#1']!.holder).toBe(fleet.id('supply'));
    expect(forks(fleet.union())).toEqual([]);
    expect(doubleSpends(fleet.union())).toEqual([]);
    expect(conservation(fleet.state()).every((r) => r.ok)).toBe(true);
  });

  it('electronic sync after a carry applies nothing twice', async () => {
    fleet = await Fleet.start();
    fleet.split(LEFT, RIGHT);
    await fleet.run(1000);
    fleet.node('medics').observe('carried.fact', 1);
    await fleet.run(300);
    fleet.node('supply').ingestFerry(fleet.node('medics').buildFerry());
    await fleet.run(300);
    fleet.net.heal();
    await fleet.run(10000);
    const ids = fleet.node('supply').events().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fleet.node('supply').view().state.observations['carried.fact']!.length).toBe(1);
  });
});

describe('hostile packets on real actors', () => {
  it('a packet signed by a key outside the roster is refused whole', async () => {
    fleet = await Fleet.start();
    const stranger = generateKeys();
    const log = new EventLog(fleet.capsule.id);
    new Author(stranger, log).emit('observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: stranger.publicKey } }, 1);
    const size = fleet.node('medics').events().length;
    const r = fleet.node('medics').ingestFerry(buildPacket({ keys: stranger, log, wall: 1 }));
    expect(r.newEvents).toBe(0);
    expect(fleet.node('medics').events().length).toBe(size);
  });

  it('a roster member cannot launder a stranger\'s events through its own packet', async () => {
    fleet = await Fleet.start();
    const stranger = generateKeys();
    const log = new EventLog(fleet.capsule.id);
    new Author(stranger, log).emit('observation.recorded', { observation: { key: 'smuggled', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: stranger.publicKey } }, 1);
    const carrier = fleet.bundles['supply']!.actor;
    fleet.node('medics').ingestFerry(buildPacket({ keys: carrier, log, wall: 1 }));
    await fleet.run(3000);
    for (const t of TEAMS) expect(fleet.node(t).events().some((e) => e.actor === stranger.publicKey)).toBe(false);
  });

  it('a stranger\'s events do not spread over sync', async () => {
    fleet = await Fleet.start();
    const stranger = generateKeys();
    const log = new EventLog(fleet.capsule.id);
    const e = new Author(stranger, log).emit('observation.recorded', { observation: { key: 'junk', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: stranger.publicKey } }, 1);
    const carrier = fleet.bundles['supply']!.actor;
    fleet.node('medics').ingestFerry(buildPacket({ keys: carrier, log, wall: 1 }));
    await fleet.run(5000);
    expect(fleet.node('supply').events().map((x) => x.id)).not.toContain(e.id);
  });

  it('a packet from another mission is refused, even if its keys are on this roster', async () => {
    fleet = await Fleet.start();
    const carrier = fleet.bundles['supply']!.actor;
    const log = new EventLog('another-mission');
    new Author(carrier, log).emit('observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: carrier.publicKey } }, 1);
    const r = fleet.node('medics').ingestFerry(buildPacket({ keys: carrier, log, wall: 1 }));
    expect(r.newEvents).toBe(0);
    expect(r.reason).toBeTruthy();
  });

  it('garbage in place of a packet is refused without an exception', async () => {
    fleet = await Fleet.start();
    for (const x of [null, 1, 'x', [], {}, { v: 1 }, { v: 1, from: fleet.id('supply'), events: 5, summary: {} }]) {
      expect(() => fleet.node('medics').ingestFerry(x as unknown as FerryPacket)).not.toThrow();
    }
  });

  it('a report of new events is never negative', async () => {
    fleet = await Fleet.start();
    const k = fleet.bundles['supply']!.actor;
    const log = new EventLog(fleet.capsule.id);
    log.ingestMany(fleet.node('supply').events());
    const one = new Author(k, log).emit('observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: k.publicKey } }, 1);
    const twin = new EventLog(fleet.capsule.id);
    twin.ingestMany(fleet.node('supply').events());
    new Author(k, twin).emit('observation.recorded', { observation: { key: 'k', value: 2, subject: 's', observedAt: 1, validForMs: 0, source: k.publicKey } }, 1);
    expect(one).toBeTruthy();
    const r = fleet.node('medics').ingestFerry(buildPacket({ keys: k, log: twin, wall: 1 }));
    expect(r.newEvents).toBeGreaterThanOrEqual(0);
  });
});

describe('secrets never leave a device', () => {
  it('no signing key appears in anything a device shows, reports or carries', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.node('medics').submitTask(fleet.task('work', { requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }), { kind: 'human' });
    await fleet.run(8000);
    const secrets = [fleet.issuer.secretKey, ...Object.values(fleet.bundles).map((b) => b.actor.secretKey)];
    const surfaces: Record<string, unknown> = { hub: fleet.net.hubState(), union: fleet.union() };
    for (const t of TEAMS) {
      surfaces[`${t} view`] = fleet.node(t).view();
      surfaces[`${t} packet`] = fleet.node(t).buildFerry();
    }
    for (const [name, value] of Object.entries(surfaces)) {
      const text = JSON.stringify(value);
      for (const s of secrets) expect(`${name}: ${text.includes(s)}`).toBe(`${name}: false`);
    }
  });
});

describe('poison carried to real actors', () => {
  it('an event from a stranger at the largest clock value does not stop the mission', async () => {
    fleet = await Fleet.start();
    const stranger = generateKeys();
    const log = new EventLog(fleet.capsule.id);
    log.ingest(
      createEvent({
        keys: stranger,
        mission: fleet.capsule.id,
        seq: 1,
        prev: null,
        parents: [],
        lamport: Number.MAX_SAFE_INTEGER,
        wall: 1,
        type: 'observation.recorded',
        body: { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: stranger.publicKey } },
      }) as AnyEvent,
    );
    const carrier = fleet.bundles['supply']!.actor;
    fleet.node('medics').ingestFerry(buildPacket({ keys: carrier, log, wall: 1 }));
    await fleet.run(5000);
    expect(() => fleet.node('facilities').observe('still.alive', 1)).not.toThrow();
    await fleet.run(2000);
    expect(fleet.node('medics').view().state.observations['still.alive']?.length).toBe(1);
  });

  it('an observation key from Object.prototype does not stop the mission', async () => {
    fleet = await Fleet.start();
    fleet.node('medics').observe('constructor', 1);
    await fleet.run(3000);
    expect(() => fleet.node('supply').view()).not.toThrow();
    expect(() => fleet.node('supply').observe('still.alive', 1)).not.toThrow();
  });

  it('a field named secret in an observation does not stop the QR carry', async () => {
    fleet = await Fleet.start();
    fleet.node('medics').observe('note', { privateRoom: true });
    await fleet.run(2000);
    expect(() => fleet.node('supply').buildFerry()).not.toThrow();
  });
});
