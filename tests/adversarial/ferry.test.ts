import { describe, expect, it } from 'vitest';
import { Author, EventLog, b64u, createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, FerryPacket } from '@afterlink/protocol';
import { FrameAssembler, buildPacket, crc32, frameText, ingestPacket, parseFrameText, planPacket, toFrames, verifyPacket } from '@afterlink/ferry';

const M = 'mission-a';
const observation = (source: string, value: unknown) => ({ observation: { key: 'k', value: value as never, subject: 's', observedAt: 1, validForMs: 0, source } });

function setup() {
  const a = generateKeys();
  const b = generateKeys();
  const logA = new EventLog(M);
  const logB = new EventLog(M);
  return { a, b, logA, logB, authorA: new Author(a, logA), authorB: new Author(b, logB) };
}

describe('ferry replay and tamper', () => {
  it('a second scan of one packet adds nothing to the log', () => {
    const { a, logA, logB, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const p = buildPacket({ keys: a, log: logA, wall: 5 });
    expect(ingestPacket(logB, p, { mission: M }).newEvents).toBe(1);
    const size = logB.size;
    expect(ingestPacket(logB, p, { mission: M }).newEvents).toBe(0);
    expect(logB.size).toBe(size);
  });

  it('refuses a packet replayed into another mission', () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const p = buildPacket({ keys: a, log: logA, wall: 5 });
    const other = new EventLog('mission-b');
    expect(ingestPacket(other, p, { mission: 'mission-b' }).ok).toBe(false);
    expect(other.size).toBe(0);
  });

  it('a sender with a clock in the future cannot make a packet immortal', () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const p = buildPacket({ keys: a, log: logA, wall: 10_000_000_000 });
    expect(verifyPacket(p, { mission: M, now: 1000, maxAgeMs: 1000 }).ok).toBe(false);
  });

  it('a signed packet cannot smuggle a forged event', () => {
    const { a, logA, logB, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const forged = structuredClone(buildPacket({ keys: a, log: logA, wall: 5 }));
    (forged.events[0]!.body as unknown as { observation: { value: number } }).observation.value = 99;
    expect(ingestPacket(logB, forged, { mission: M }).ok).toBe(false);
    expect(logB.size).toBe(0);
  });
});

describe('poisoned packets', () => {
  it('one observation with a field named secret must not stop the ferry', () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, { secretCode: 'blue' }), 1);
    expect(() => buildPacket({ keys: a, log: logA, wall: 5 })).not.toThrow();
  });

  it('a deeply nested event cannot crash verification', () => {
    const { a, logA } = setup();
    let deep: unknown = 1;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const p = buildPacket({ keys: a, log: logA, wall: 5 });
    const hostile = { ...p, events: [{ id: 'x', body: deep }] } as unknown as FerryPacket;
    expect(() => verifyPacket(hostile, { mission: M })).not.toThrow();
  });

  it('ingest does not throw on non-object packets', () => {
    const { logB } = setup();
    for (const x of [null, 1, 'x', [], {}, { v: 1 }, { v: 1, events: 5, summary: {} }]) {
      expect(() => ingestPacket(logB, x as unknown as FerryPacket, { mission: M })).not.toThrow();
    }
  });
});

describe('delta selection', () => {
  it('a budgeted packet is causally closed: it never ships a reply without what it answers', () => {
    const { a, b, logA, logB, authorA, authorB } = setup();
    for (let i = 0; i < 3; i++) authorA.emit('observation.recorded', observation(a.publicKey, i), i);
    authorA.emit('right.offered', { transfer: 'x', tokens: ['t'], to: b.publicKey }, 10);
    logB.ingestMany(logA.all());
    authorB.emit('right.accepted', { transfer: 'x' }, 11);
    logA.ingestMany(logB.all());
    const receiver = new EventLog(M);
    const p = buildPacket({ keys: a, log: logA, maxEvents: 1, wall: 20 });
    expect(ingestPacket(receiver, p, { mission: M }).ok).toBe(true);
    expect(receiver.pending).toBe(0);
  });

  it('carries the other side of a fork when the remote head sits on a different branch', () => {
    const k = generateKeys();
    const carrier = generateKeys();
    const ev = (seq: number, prev: string | null, v: number) =>
      createEvent({ keys: k, mission: M, seq, prev, parents: [], lamport: seq, wall: 1, type: 'observation.recorded', body: observation(k.publicKey, v) }) as AnyEvent;
    const e1 = ev(1, null, 1);
    const left = ev(2, e1.id, 2);
    const right = ev(2, e1.id, 3);
    const x = new EventLog(M);
    const y = new EventLog(M);
    x.ingestMany([e1, left]);
    y.ingestMany([e1, right]);
    const p = buildPacket({ keys: carrier, log: x, remote: y.summary(), wall: 5 });
    expect(p.events.map((e) => e.id)).toContain(left.id);
  });

  it('a summary that overstates the receiver leaves nothing silently stuck', () => {
    const { a, logA, logB, authorA } = setup();
    for (let i = 0; i < 4; i++) authorA.emit('observation.recorded', observation(a.publicKey, i), i);
    const stale = logA.summary();
    const head = stale.heads[a.publicKey]!;
    const p = buildPacket({ keys: a, log: logA, remote: { ...stale, heads: { [a.publicKey]: { seq: head.seq - 1, id: 'unknown-id' } } }, wall: 5 });
    expect(ingestPacket(logB, p, { mission: M }).ok).toBe(true);
    expect(logB.pending).toBe(0);
  });
});

describe('tampered and hostile QR frames', () => {
  it('rejects a frame with a flipped byte', async () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const [f] = await toFrames(buildPacket({ keys: a, log: logA, wall: 5 }));
    const text = frameText(f!);
    const flipped = text.slice(0, -1) + (text.endsWith('A') ? 'B' : 'A');
    expect(parseFrameText(flipped)).toBeNull();
  });

  it('a frame claiming two billion parts is refused', () => {
    const n = 2 ** 31;
    const id = 'aaaaaaaa';
    const data = 'AAAA';
    const f = parseFrameText(`AL1.${id}.0.${n}.${crc32(`${id}.0.${n}.${data}`)}.${data}`);
    expect(f).toBeNull();
  });

  it('a stray frame does not lock the scanner out of the real packet', async () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const p = buildPacket({ keys: a, log: logA, wall: 5 });
    const frames = await toFrames(p);
    const asm = new FrameAssembler();
    const id = 'strayzzz';
    asm.add({ id, i: 0, n: 3, data: 'AAAA', c: crc32(`${id}.0.3.AAAA`) } as never);
    for (const f of frames) asm.add(f);
    expect(asm.done).toBe(true);
    expect((await asm.packet()).id).toBe(p.id);
  });

  it('a compressed bomb is refused before it is expanded in full', async () => {
    const big = new Uint8Array(64 * 1024 * 1024);
    const stream = new Blob([big]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const data = b64u(new Uint8Array(await new Response(stream).arrayBuffer()));
    const id = 'bombbomb';
    const asm = new FrameAssembler();
    asm.add({ id, i: 0, n: 1, data, c: crc32(`${id}.0.1.${data}`) } as never);
    await expect(asm.packet()).rejects.toThrow(/too large/);
  });
});

describe('secret leakage', () => {
  it('no packet or frame contains a signing key', async () => {
    const { a, logA, authorA } = setup();
    authorA.emit('observation.recorded', observation(a.publicKey, 1), 1);
    const plan = planPacket({ keys: a, log: logA, wall: 5 });
    expect(JSON.stringify(plan.packet)).not.toContain(a.secretKey);
    expect(JSON.stringify(await toFrames(plan.packet))).not.toContain(a.secretKey);
  });
});
