import { describe, expect, it } from 'vitest';
import { Author, EventLog, verifyEvent, type AnyEvent } from '../src/index.ts';
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

  it('returns an event peers accept unchanged', () => {
    const local = new EventLog(MISSION);
    const event = new Author(alice, local).emit('task.released', note('1'));
    const peer = new EventLog(MISSION);
    expect(peer.ingest(JSON.parse(JSON.stringify(event)))).toBe('added');
    expect(ids(peer.all())).toEqual(ids(local.all()));
  });
});
