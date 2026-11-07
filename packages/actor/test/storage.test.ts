import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent } from '@afterlink/protocol';
import { createIdbStorage, createMemoryStorage, type ActorStorage } from '../src/storage.ts';

const keys = generateKeys();
const identity = { publicKey: keys.publicKey, secretKey: keys.secretKey, mission: 'm1' };

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
    expect(await make().load()).toBeNull();
  });

  it('returns events in write order with identity and meta intact', async () => {
    const s = make();
    await s.reset(identity);
    const events = chain(5);
    await s.append(events.slice(0, 2));
    await s.append(events.slice(2));
    await s.saveMeta({ faults: { blocked: ['x'] }, hqLive: ['a'], hqLate: ['b'] });
    const got = await s.load();
    expect(got?.identity).toEqual(identity);
    expect(got?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(got?.events).toEqual(events);
    expect(got?.meta).toEqual({ faults: { blocked: ['x'] }, hqLive: ['a'], hqLate: ['b'] });
  });

  it('reset discards everything held', async () => {
    const s = make();
    await s.reset(identity);
    await s.append(chain(2));
    await s.saveMeta({ hqLive: ['a'] });
    await s.reset({ ...identity, mission: 'm2' });
    const got = await s.load();
    expect(got?.identity.mission).toBe('m2');
    expect(got?.events).toEqual([]);
    expect(got?.meta).toEqual({});
  });
});

describe('indexeddb durability', () => {
  it('survives closing and reopening the database', async () => {
    const name = `t-${Math.random()}`;
    const first = createIdbStorage(name);
    await first.reset(identity);
    await first.append(chain(3));
    first.close?.();
    const second = createIdbStorage(name);
    const got = await second.load();
    expect(got?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(got?.identity.secretKey).toBe(identity.secretKey);
  });

  it('keeps namespaces apart so devices in one browser do not share a log', async () => {
    const a = createIdbStorage(`a-${Math.random()}`);
    const b = createIdbStorage(`b-${Math.random()}`);
    await a.reset(identity);
    await a.append(chain(2));
    expect(await b.load()).toBeNull();
  });
});
