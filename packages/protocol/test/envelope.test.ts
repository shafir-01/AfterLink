import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, createEvent, eventId, sha256, verifyEvent, type AnyEvent, type KeyPair } from '../src/index.ts';
import { MISSION, note, seededKeys } from './helpers.ts';

const alice = seededKeys(1);
const mallory = seededKeys(2);

function draft(overrides: Partial<Parameters<typeof createEvent<'task.released'>>[0]> = {}) {
  return {
    keys: alice,
    mission: MISSION,
    seq: 1,
    prev: null,
    parents: [],
    lamport: 1,
    wall: 1000,
    type: 'task.released' as const,
    body: note('because'),
    ...overrides,
  };
}

const make = (overrides = {}): AnyEvent => createEvent(draft(overrides)) as unknown as AnyEvent;

describe('createEvent', () => {
  it('hashes the canonical envelope without id and sig, and signs the id bytes', () => {
    const e = make();
    const { id, sig, ...unsigned } = e;
    expect(id).toBe(sha256(canonicalize(unsigned)));
    expect(id).toBe(eventId(unsigned));
    expect(verifyEvent(e)).toEqual({ ok: true });
    expect(sig).toHaveLength(86);
  });

  it('matches values computed independently with OpenSSL from the literal canonical text', () => {
    const e = make({ parents: ['p2', 'p1'], seq: 3, prev: 'q', lamport: 7 });
    expect(e.actor).toBe('gTl3Dqh9F19Wo1Rmw0x-zMuNipG07jeiXfYPW4_Js5Q');
    expect(e.id).toBe('sfFf9-RwrtBpeJG0319w74YisqD0aTODsETMRdoELgc');
    expect(e.sig).toBe('qAtxZAmWq2MVg4pLQUrBTt_7SbM3RCzw8drhK38OoWmZ_WIe_Vy2wsJP2RXUYHsw-pkdt_biP2h-7sEo29E7BQ');
  });

  it('sorts and dedupes parents', () => {
    expect(make({ parents: ['b', 'a', 'b'] }).parents).toEqual(['a', 'b']);
  });

  it('returns what peers will decode, detached from the caller', () => {
    const body = { taskId: 't', reason: 'r', extra: undefined };
    const e = createEvent(draft({ body }));
    expect(Object.keys(e.body).sort()).toEqual(['reason', 'taskId']);
    body.reason = 'changed later';
    expect(verifyEvent(e as unknown as AnyEvent)).toEqual({ ok: true });
    expect(JSON.parse(JSON.stringify(e))).toStrictEqual(e);
  });

  it('refuses drafts that could never verify', () => {
    expect(() => make({ seq: 0 })).toThrow(TypeError);
    expect(() => make({ seq: 1.5, prev: 'x' })).toThrow(TypeError);
    expect(() => make({ seq: 1, prev: 'x' })).toThrow(TypeError);
    expect(() => make({ seq: 2, prev: null })).toThrow(TypeError);
    expect(() => make({ wall: NaN })).toThrow(TypeError);
    expect(() => make({ lamport: -1 })).toThrow(TypeError);
    expect(() => make({ mission: '' })).toThrow(TypeError);
    expect(() => make({ body: { ageMs: Infinity } })).toThrow(TypeError);
  });
});

describe('verifyEvent', () => {
  it('survives every transport encoding', () => {
    const e = make({ parents: ['x'] });
    expect(verifyEvent(JSON.parse(JSON.stringify(e)))).toEqual({ ok: true });
    expect(verifyEvent(structuredClone(e))).toEqual({ ok: true });
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as unknown as AnyEvent;
    expect(verifyEvent(reordered)).toEqual({ ok: true });
  });

  const tamperings: [string, (e: Record<string, unknown>) => void][] = [
    ['v', (e) => (e.v = 2)],
    ['mission', (e) => (e.mission = 'other')],
    ['actor', (e) => (e.actor = mallory.publicKey)],
    ['seq', (e) => (e.seq = 3)],
    ['prev', (e) => (e.prev = 'other')],
    ['parents', (e) => (e.parents = ['other'])],
    ['lamport', (e) => (e.lamport = 99)],
    ['wall', (e) => (e.wall = 1)],
    ['type', (e) => (e.type = 'task.completed')],
    ['body', (e) => (e.body = note('forged'))],
    ['nested body', (e) => ((e.body as { reason: string }).reason = 'forged')],
    ['extra field', (e) => (e.extra = true)],
    ['id', (e) => (e.id = sha256('other'))],
    ['sig', (e) => (e.sig = make({ wall: 5 }).sig)],
    ['removed sig', (e) => delete e.sig],
    ['removed id', (e) => delete e.id],
    ['removed field', (e) => delete e.wall],
  ];

  it.each(tamperings)('detects a change to %s', (_, tamper) => {
    const e = structuredClone(make({ seq: 2, prev: 'prior', parents: ['p'] })) as unknown as Record<string, unknown>;
    expect(verifyEvent(e as unknown as AnyEvent).ok).toBe(true);
    tamper(e);
    expect(verifyEvent(e as unknown as AnyEvent).ok).toBe(false);
  });

  it('detects any single character change in id or sig', () => {
    const e = make();
    fc.assert(
      fc.property(
        fc.constantFrom('id', 'sig'),
        fc.nat(),
        fc.constantFrom(...'ABCabc012-_'),
        (field, at, char) => {
          const text = e[field as 'id' | 'sig'];
          const i = at % text.length;
          fc.pre(text[i] !== char);
          const tampered = { ...e, [field]: text.slice(0, i) + char + text.slice(i + 1) } as AnyEvent;
          expect(verifyEvent(tampered).ok).toBe(false);
        },
      ),
    );
  });

  it('refuses a signature from a different key, even with the id recomputed', () => {
    const honest = make();
    const { id, sig, ...unsigned } = honest;
    const forged = { ...unsigned, body: note('forged') };
    const signedByMallory = createEvent(draft({ keys: mallory, body: note('forged') }));
    const tampered = { ...forged, id: eventId(forged), sig: signedByMallory.sig } as AnyEvent;
    expect(verifyEvent(tampered)).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('refuses an alternate spelling of a public key', () => {
    const last = alice.publicKey.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const respelled = alice.publicKey.slice(0, -1) + alphabet[alphabet.indexOf(last) + 1]!;
    const keys: KeyPair = { publicKey: respelled, secretKey: alice.secretKey };
    expect(verifyEvent(make({ keys })).ok).toBe(false);
  });

  it('does not let an earlier success vouch for a changed event', () => {
    const e = make();
    expect(verifyEvent(e).ok).toBe(true);
    expect(verifyEvent(e).ok).toBe(true);
    expect(verifyEvent({ ...e, wall: 2000 } as AnyEvent).ok).toBe(false);
    expect(verifyEvent({ ...e, sig: make({ wall: 9 }).sig } as AnyEvent).ok).toBe(false);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (junk) => {
        expect(verifyEvent(junk as AnyEvent).ok).toBe(false);
      }),
    );
    const e = make();
    for (const body of [null, 1, 'x', undefined]) {
      expect(verifyEvent({ ...e, body } as unknown as AnyEvent).ok).toBe(false);
    }
    expect(verifyEvent({ ...e, body: { n: NaN } } as unknown as AnyEvent).ok).toBe(false);
    expect(verifyEvent({ ...e, body: { n: 1n } } as unknown as AnyEvent).ok).toBe(false);
  });
});
