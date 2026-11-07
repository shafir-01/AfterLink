import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Author, EventLog, createEvent, generateKeys, verifyEvent } from '@afterlink/protocol';
import type { AnyEvent } from '@afterlink/protocol';

const M = 'mission-a';

function obs(keys: ReturnType<typeof generateKeys>, seq: number, prev: string | null, over: Partial<{ lamport: number; mission: string; parents: string[] }> = {}) {
  return createEvent({
    keys,
    mission: over.mission ?? M,
    seq,
    prev,
    parents: over.parents ?? [],
    lamport: over.lamport ?? seq,
    wall: 1000 + seq,
    type: 'observation.recorded',
    body: { observation: { key: 'k', value: seq, subject: 's', observedAt: 1, validForMs: 0, source: keys.publicKey } },
  }) as AnyEvent;
}

function chain(keys: ReturnType<typeof generateKeys>, n: number): AnyEvent[] {
  const out: AnyEvent[] = [];
  for (let i = 1; i <= n; i++) out.push(obs(keys, i, out[i - 2]?.id ?? null));
  return out;
}

describe('event integrity', () => {
  it('rejects every single-field tamper of a signed event', () => {
    const k = generateKeys();
    const good = obs(k, 1, null);
    const tampers: ((e: Record<string, unknown>) => void)[] = [
      (e) => (e.seq = 2),
      (e) => (e.lamport = 99),
      (e) => (e.wall = 7),
      (e) => (e.mission = 'mission-b'),
      (e) => (e.type = 'task.created'),
      (e) => (e.parents = ['x']),
      (e) => (e.actor = generateKeys().publicKey),
      (e) => ((e.body as { observation: { value: number } }).observation.value = 2),
    ];
    for (const t of tampers) {
      const copy = structuredClone(good) as unknown as Record<string, unknown>;
      t(copy);
      expect(verifyEvent(copy as unknown as AnyEvent).ok).toBe(false);
    }
  });

  it('never throws on arbitrary input off the wire', () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        const log = new EventLog(M);
        expect(verifyEvent(x as AnyEvent).ok).toBe(false);
        expect(log.ingest(x as AnyEvent)).toBe('invalid');
      }),
      { numRuns: 300 },
    );
  });

  it('refuses an event replayed from another mission', () => {
    const k = generateKeys();
    const log = new EventLog(M);
    expect(log.ingest(obs(k, 1, null, { mission: 'mission-b' }))).toBe('invalid');
    expect(log.size).toBe(0);
  });

  it('keeps one result under any delivery order and any duplication', () => {
    const a = generateKeys();
    const b = generateKeys();
    const ca = chain(a, 4);
    const cb: AnyEvent[] = [];
    for (let i = 1; i <= 3; i++) cb.push(obs(b, i, cb[i - 2]?.id ?? null, { parents: [ca[i]!.id], lamport: 10 + i }));
    const fork = obs(a, 3, ca[1]!.id, { lamport: 40 });
    const all = [...ca, ...cb, fork];
    const reference = new EventLog(M);
    reference.ingestMany([...ca, ...cb, fork]);
    fc.assert(
      fc.property(fc.shuffledSubarray([...all, ...all], { minLength: all.length * 2, maxLength: all.length * 2 }), (order) => {
        const log = new EventLog(M);
        for (const e of order) log.ingest(e);
        expect(log.all().map((e) => e.id)).toEqual(reference.all().map((e) => e.id));
        expect(log.summary()).toEqual(reference.summary());
        expect(log.forks().length).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});

describe('poison events', () => {
  it('survives an event at the largest lamport value: honest authors must still sign', () => {
    const honest = generateKeys();
    const attacker = generateKeys();
    const log = new EventLog(M);
    const author = new Author(honest, log);
    author.emit('observation.recorded', { observation: { key: 'k', value: 1, subject: 's', observedAt: 1, validForMs: 0, source: honest.publicKey } }, 1);
    log.ingest(obs(attacker, 1, null, { lamport: Number.MAX_SAFE_INTEGER }));
    expect(() =>
      author.emit('observation.recorded', { observation: { key: 'k', value: 2, subject: 's', observedAt: 2, validForMs: 0, source: honest.publicKey } }, 2),
    ).not.toThrow();
  });

  it('bounds a lamport jump: an event cannot run far ahead of its own dependencies', () => {
    const honest = generateKeys();
    const log = new EventLog(M);
    expect(log.ingest(obs(honest, 1, null, { lamport: 1_000_000_000 }))).toBe('invalid');
  });

  it('does not accept an event type outside the contract', () => {
    const k = generateKeys();
    const log = new EventLog(M);
    const e = createEvent({ keys: k, mission: M, seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'right.seized' as 'right.declined', body: { transfer: 'x' } });
    expect(log.ingest(e as AnyEvent)).toBe('invalid');
  });

  it('does not accept a contract event with a junk body', () => {
    const k = generateKeys();
    const log = new EventLog(M);
    const e = createEvent({ keys: k, mission: M, seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'right.committed', body: { tokens: 5, taskId: null } as never });
    expect(log.ingest(e as AnyEvent)).toBe('invalid');
  });
});

describe('admission', () => {
  it('can be told who may write: a stranger key is refused by the log', () => {
    const member = generateKeys();
    const stranger = generateKeys();
    const Log = EventLog as unknown as new (m: string, o: { admit: (a: string) => boolean }) => EventLog;
    const log = new Log(M, { admit: (a) => a === member.publicKey });
    expect(log.ingest(obs(member, 1, null))).toBe('added');
    expect(log.ingest(obs(stranger, 1, null))).toBe('invalid');
  });
});

describe('unbounded input', () => {
  it('bounds the buffer of events waiting for dependencies', () => {
    const attacker = generateKeys();
    const log = new EventLog(M);
    const fake = 'A'.repeat(43);
    for (let i = 2; i < 3000; i++) log.ingest(obs(attacker, i, fake));
    expect(log.pending).toBeLessThanOrEqual(2048);
  });

  it('refuses a parents list longer than any roster', () => {
    const k = generateKeys();
    const log = new EventLog(M);
    const parents = Array.from({ length: 5000 }, (_, i) => String(i));
    expect(log.ingest(obs(k, 1, null, { parents }))).toBe('invalid');
  });

  it('refuses an oversized event body', () => {
    const k = generateKeys();
    const log = new EventLog(M);
    const e = createEvent({ keys: k, mission: M, seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'task.released', body: { taskId: 't', reason: 'x'.repeat(4_000_000) } });
    expect(log.ingest(e as AnyEvent)).toBe('invalid');
  });
});
