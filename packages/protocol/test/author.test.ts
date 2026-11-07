import { describe, expect, it } from 'vitest';
import { Author, createEvent, EventLog, MAX_EVENT_BYTES, verifyEvent, type AnyEvent } from '../src/index.ts';
import { ids, MISSION, note, seededKeys } from './helpers.ts';

const alice = seededKeys(20);
const bob = seededKeys(21);

describe('Author', () => {
  it('builds a hash chain with rising seq and lamport', () => {
    const log = new EventLog(MISSION);
    const author = new Author(alice, log);
    const first = author.emit('task.released', note('a'), 100);
    const second = author.emit('task.released', note('b'), 200);
    expect(first).toMatchObject({ seq: 1, prev: null, lamport: 1, wall: 100, parents: [], actor: alice.publicKey });
    expect(second).toMatchObject({ seq: 2, prev: first.id, lamport: 2, wall: 200, parents: [] });
    expect(verifyEvent(second as unknown as AnyEvent)).toEqual({ ok: true });
    expect(ids(log.all())).toEqual([first.id, second.id]);
  });

  it('defaults wall to the current time', () => {
    const before = Date.now();
    const e = new Author(alice, new EventLog(MISSION)).emit('task.released', note('a'));
    expect(e.wall).toBeGreaterThanOrEqual(before);
  });

  it('links what it has seen from others and passes their clock', () => {
    const logA = new EventLog(MISSION);
    const logB = new EventLog(MISSION);
    const a = new Author(alice, logA);
    const b = new Author(bob, logB);
    a.emit('task.released', note('1'));
    a.emit('task.released', note('2'));
    const seen = a.emit('task.released', note('3'));
    logB.ingestMany(logA.all());
    const reply = b.emit('task.released', note('reply'));
    expect(reply).toMatchObject({ seq: 1, prev: null, parents: [seen.id], lamport: seen.lamport + 1 });
    logA.ingestMany(logB.all());
    const next = a.emit('task.released', note('after reply'));
    expect(next).toMatchObject({ seq: 4, prev: seen.id, parents: [reply.id], lamport: reply.lamport + 1 });
  });

  it('never lists its own actor as a parent', () => {
    const log = new EventLog(MISSION);
    const author = new Author(alice, log);
    author.emit('task.released', note('1'));
    expect(author.emit('task.released', note('2')).parents).toEqual([]);
  });

  it('resumes the chain after a restart from stored events', () => {
    const log = new EventLog(MISSION);
    const author = new Author(alice, log);
    const stored = [author.emit('task.released', note('1')), author.emit('task.released', note('2'))];
    const restored = new EventLog(MISSION);
    restored.ingestMany(JSON.parse(JSON.stringify(stored)));
    const resumed = new Author(alice, restored).emit('task.released', note('3'));
    expect(resumed).toMatchObject({ seq: 3, prev: stored[1]!.id, lamport: 3 });
    expect(restored.forks()).toEqual([]);
  });

  it('merges its own fork tips, so one signed event closes the frontier', () => {
    const [root] = [createEvent({ keys: alice, mission: MISSION, seq: 1, prev: null, parents: [], lamport: 1, wall: 1, type: 'task.released', body: note('root') })];
    const branch = (reason: string, lamport: number) =>
      createEvent({ keys: alice, mission: MISSION, seq: 2, prev: root!.id, parents: [], lamport, wall: 1, type: 'task.released', body: note(reason) });
    const left = branch('left', 2);
    const right = branch('right', 9);
    const log = new EventLog(MISSION);
    log.ingestMany([root!, left, right]);
    const next = new Author(alice, log).emit('task.released', note('after'), 1);
    expect(next.parents).toHaveLength(1);
    expect(next.lamport).toBe(10);
    expect(log.heads()).toEqual([next.id]);
  });

  it('throws rather than losing an event the log refuses', () => {
    const log = new EventLog(MISSION);
    const author = new Author(alice, log);
    expect(() => author.emit('right.committed', { tokens: 5 } as never)).toThrow('malformed right.committed body');
    expect(() => author.emit('task.released', note('x'.repeat(MAX_EVENT_BYTES)))).toThrow('event too large');
    expect(log.size).toBe(0);
    const closed = new EventLog(MISSION, { admit: () => false });
    expect(() => new Author(alice, closed).emit('task.released', note('a'))).toThrow('actor not admitted');
  });

  it('returns an event peers accept unchanged', () => {
    const local = new EventLog(MISSION);
    const event = new Author(alice, local).emit('task.released', note('1'));
    const peer = new EventLog(MISSION);
    expect(peer.ingest(JSON.parse(JSON.stringify(event)))).toBe('added');
    expect(ids(peer.all())).toEqual(ids(local.all()));
  });
});
