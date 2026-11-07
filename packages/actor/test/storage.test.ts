import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { MemoryNetwork } from '@afterlink/mesh';
import { festivalCapsule, provision } from '@afterlink/mission';
import { createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent } from '@afterlink/protocol';
import { createActor, createIdbStorage, createMemoryStorage, type ActorStorage } from '../src/index.ts';

const keys = generateKeys();
const identity = { publicKey: keys.publicKey, secretKey: keys.secretKey, mission: 'm1' };
const mark = (seq: number) => ({ actor: keys.publicKey, mission: 'm1', seq, id: `e${seq}` });

function chain(n: number): AnyEvent[] {
  const out: AnyEvent[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      createEvent({
        keys,
        mission: 'm1',
        seq: i,
        prev: out.at(-1)?.id ?? null,
        parents: [],
        lamport: i,
        wall: i,
        type: 'observation.recorded',
        body: { observation: { key: 'k', value: i, subject: 's', observedAt: i, validForMs: 0, source: keys.publicKey } },
      }) as AnyEvent,
    );
  }
  return out;
}

const cases: [string, () => ActorStorage][] = [
  ['memory', () => createMemoryStorage()],
  ['indexeddb', () => createIdbStorage(`t-${Math.random()}`)],
];

describe.each(cases)('%s storage', (_name, make) => {
  it('is empty until bound to an identity', async () => {
    const s = make();
    expect(await s.load()).toBeNull();
    expect(await s.readMark()).toBeNull();
  });

  it('returns events in write order with identity and meta intact', async () => {
    const s = make();
    await s.reset(identity);
    const events = chain(5);
    await s.append(events.slice(0, 2));
    await s.append(events.slice(2));
    const meta = { faults: { blocked: ['x'] }, hqLive: ['a'], hqLate: ['b'], ferrySeen: ['p'] };
    await s.saveMeta(meta);
    const got = await s.load();
    expect(got?.identity).toEqual(identity);
    expect(got?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(got?.events).toEqual(events);
    expect(got?.meta).toEqual(meta);
  });

  it('reset discards the log, and the mark outlives it', async () => {
    const s = make();
    await s.reset(identity);
    await s.append(chain(2), mark(2));
    await s.saveMeta({ hqLive: ['a'] });
    await s.reset({ ...identity, mission: 'm2' });
    const got = await s.load();
    expect(got?.identity.mission).toBe('m2');
    expect(got?.events).toEqual([]);
    expect(got?.meta).toEqual({});
    expect(await s.readMark()).toEqual(mark(2));
  });

  it('keeps the newest mark', async () => {
    const s = make();
    await s.reset(identity);
    const events = chain(3);
    await s.append(events.slice(0, 1), mark(1));
    await s.append(events.slice(1), mark(3));
    expect((await s.readMark())?.seq).toBe(3);
  });

  it('frees the identity on close', async () => {
    const s = make();
    expect(await s.acquire()).toBe(true);
    s.close?.();
    expect(await s.acquire()).toBe(true);
    s.close?.();
  });
});

describe('indexeddb durability', () => {
  it('survives closing and reopening the database', async () => {
    const name = `t-${Math.random()}`;
    const first = createIdbStorage(name);
    await first.reset(identity);
    await first.append(chain(3), mark(3));
    first.close?.();
    const second = createIdbStorage(name);
    const got = await second.load();
    expect(got?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(got?.identity.secretKey).toBe(identity.secretKey);
    expect((await second.readMark())?.seq).toBe(3);
  });

  it('keeps namespaces apart so devices in one browser do not share a log', async () => {
    const a = createIdbStorage(`a-${Math.random()}`);
    const b = createIdbStorage(`b-${Math.random()}`);
    await a.reset(identity);
    await a.append(chain(2), mark(2));
    expect(await b.load()).toBeNull();
    expect(await b.readMark()).toBeNull();
  });

  it('the mark outlives deleting the log database, as evicted site data does', async () => {
    const name = `t-${Math.random()}`;
    const first = createIdbStorage(name);
    await first.reset(identity);
    await first.append(chain(2), mark(2));
    first.close?.();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(`afterlink-${name}`);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const second = createIdbStorage(name);
    expect(await second.load()).toBeNull();
    expect((await second.readMark())?.seq).toBe(2);
  });

  it('a second runtime is refused the identity while the first holds it, and gets it after', async () => {
    const name = `t-${Math.random()}`;
    const first = createIdbStorage(name);
    const second = createIdbStorage(name);
    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    first.close?.();
    expect(await second.acquire()).toBe(true);
    second.close?.();
  });

  it('a real actor restarts from indexeddb with its identity, chain and rights', async () => {
    const issuer = generateKeys();
    const capsule = { ...festivalCapsule(issuer, { now: 1000 }), tasks: [] };
    const { bundles } = provision(capsule, issuer, 'idb-room');
    const bundle = bundles.medics!;
    const self = bundle.actor.publicKey;
    const net = new MemoryNetwork({ seed: 3 });
    const namespace = `actor-${Math.random()}`;
    const connector = net.connector(self);

    // A device that has joined before: one signed event, and a mark that says so.
    const seed = createIdbStorage(namespace);
    await seed.reset({ publicKey: self, secretKey: bundle.actor.secretKey, mission: bundle.genesis.mission });
    await seed.append([bundle.genesis]);
    const joined = createEvent({
      keys: bundle.actor,
      mission: bundle.genesis.mission,
      seq: 1,
      prev: null,
      parents: [bundle.genesis.id],
      lamport: 2,
      wall: 1000,
      type: 'actor.joined',
      body: { team: bundle.team, name: bundle.name, credential: bundle.credential },
    }) as AnyEvent;
    await seed.append([joined], { actor: self, mission: bundle.genesis.mission, seq: 1, id: joined.id });
    seed.close?.();

    const first = createActor({ bundle, connector, storage: createIdbStorage(namespace) });
    await first.start();
    expect(first.view().phase).toBe('ready');
    expect(first.observe('note', 'kept')).toBe(true);
    await first.settled();
    const held = first.view().tokens.map((t) => t.id);
    first.stop();

    const second = createActor({ bundle, connector, storage: createIdbStorage(namespace) });
    await second.start();
    expect(second.id).toBe(first.id);
    expect(second.view().phase).toBe('ready');
    expect(second.view().state.observations.note).toHaveLength(1);
    expect(second.view().tokens.map((t) => t.id)).toEqual(held);
    expect(second.events().filter((e) => e.actor === self).map((e) => e.seq)).toEqual([1, 2]);
    second.stop();
  });
});
