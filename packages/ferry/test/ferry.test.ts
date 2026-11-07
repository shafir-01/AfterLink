import { describe, expect, it, vi } from 'vitest';
import {
  EventLog,
  createEvent,
  canonicalize,
  generateKeys,
  signBytes,
  type AnyEvent,
  type EventBodies,
  type EventType,
  type TaskSpec,
} from '@afterlink/protocol';
import {
  FrameAssembler,
  buildPacket,
  frameImage,
  ingestPacket,
  planPacket,
  readFrame,
  toFrames,
  verifyPacket,
  type WireFrame,
} from '../src/index.ts';

vi.mock('@afterlink/protocol', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return typeof real.createEvent === 'function' ? real : await import('./stub-protocol.ts');
});

type Keys = ReturnType<typeof generateKeys>;
const MISSION = 'fresher-field-day';

function spec(n: number): TaskSpec {
  return {
    id: `task-${n}`,
    kind: 'first-aid',
    title: `Casualty near stage ${n}`,
    brief: 'Send a first aid team to the north lawn and report when the person is stable.',
    objective: 'care',
    priority: 1,
    location: { x: 12 + n, y: 40 },
    locationName: 'North lawn',
    requires: ['first-aid'],
    needs: [{ resource: 'aed', count: 1 }],
    dependsOn: [],
    reversible: false,
  };
}

function decision(actor: string, taskId: string) {
  return {
    id: `d-${taskId}`,
    actor,
    taskId,
    outcome: 'ACCEPTED' as const,
    reason: 'Medics are closest, hold the AED and have the first-aid capability.',
    policy: 'lowest-hash-tiebreak',
    reachable: [] as string[],
    horizon: {} as Record<string, number>,
    inputs: [{ key: 'gate.north.open', ageMs: 4000, state: 'confirmed' as const }],
    tokens: ['aed#1'],
  };
}

class Writer {
  seq = 0;
  prev: string | null = null;
  constructor(readonly keys: Keys, readonly log: EventLog, readonly clock: { t: number }) {}
  emit<T extends EventType>(type: T, body: EventBodies[T]): AnyEvent {
    const e = createEvent({
      keys: this.keys,
      mission: MISSION,
      seq: ++this.seq,
      prev: this.prev,
      parents: this.log.heads().filter((h) => h !== this.prev),
      lamport: ++this.clock.t,
      wall: 1_700_000_000_000 + this.clock.t * 1000,
      type,
      body,
    } as never) as AnyEvent;
    this.prev = e.id;
    expect(this.log.ingest(e)).toBe('added');
    return e;
  }
}

function scenario(count = 40) {
  const clock = { t: 0 };
  const log = new EventLog(MISSION);
  const medics = new Writer(generateKeys(), log, clock);
  const access = new Writer(generateKeys(), log, clock);
  for (let i = 0; i < count; i++) {
    const w = i % 2 ? access : medics;
    const k = i % 5;
    if (k === 0) w.emit('task.created', { spec: spec(i), source: { kind: 'human' } });
    else if (k === 1) w.emit('task.claimed', { taskId: `task-${i - 1}`, decision: decision(w.keys.publicKey, `task-${i - 1}`) });
    else if (k === 2)
      w.emit('observation.recorded', {
        observation: { key: 'gate.north.open', value: i % 2 === 0, subject: 'north gate', observedAt: 1_700_000_000_000 + i, validForMs: 0, source: w.keys.publicKey },
      });
    else if (k === 3) w.emit('right.offered', { transfer: `tr-${i}`, tokens: ['aed#1'], to: access.keys.publicKey });
    else w.emit('link.changed', { peer: access.keys.publicKey, state: 'severed', transport: 'webrtc' });
  }
  return { log, medics, access, clock };
}

function qrRoundTrip(frames: WireFrame[]): WireFrame[] {
  return frames.map((f) => {
    const got = readFrame(frameImage(f));
    expect(got).not.toBeNull();
    return got!;
  });
}

describe('packet', () => {
  it('signs, verifies and carries no key material', () => {
    const { log, medics, access } = scenario();
    const p = buildPacket({ keys: medics.keys, log });
    expect(verifyPacket(p, { mission: MISSION })).toEqual({ ok: true });
    const json = JSON.stringify(p);
    expect(json).not.toContain(medics.keys.secretKey);
    expect(json).not.toContain(access.keys.secretKey);
    expect(p.from).toBe(medics.keys.publicKey);
  });

  it('refuses to build from events that carry secrets', () => {
    const { log, medics } = scenario(5);
    const w = new Writer(generateKeys(), new EventLog(MISSION), { t: 0 });
    const bad = w.emit('observation.recorded', {
      observation: { key: 'k', value: { secretKey: 'x' }, subject: 's', observedAt: 1, validForMs: 0, source: w.keys.publicKey },
    });
    const l2 = new EventLog(MISSION);
    l2.ingest(bad);
    expect(() => buildPacket({ keys: medics.keys, log: l2 })).toThrow(/secret/);
    expect(log.size).toBe(5);
  });

  it('sends only the delta against a remote summary', () => {
    const { log, medics } = scenario(40);
    const remote = new EventLog(MISSION);
    for (const e of log.all().slice(0, 20)) remote.ingest(e);
    const p = buildPacket({ keys: medics.keys, log, remote: remote.summary() });
    expect(p.events.length).toBe(20);
    expect(p.events.every((e) => !remote.has(e.id))).toBe(true);
    const r = ingestPacket(remote, p, { mission: MISSION });
    expect(r).toMatchObject({ ok: true, newEvents: 20, rejected: 0 });
    expect(remote.size).toBe(40);
  });

  it('prefers task, right and observation events and keeps chains contiguous', () => {
    const { log, medics } = scenario(40);
    const plan = planPacket({ keys: medics.keys, log, maxEvents: 24 });
    const events = plan.packet.events;
    expect(events.length).toBeLessThanOrEqual(24);
    for (const actor of new Set(events.map((e) => e.actor))) {
      const seqs = events.filter((e) => e.actor === actor).map((e) => e.seq);
      expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    }
    const kept = events.filter((e) => e.type !== 'link.changed').length;
    const droppedImportant = plan.dropped.filter((d) => d.type !== 'link.changed').length;
    expect(kept).toBeGreaterThan(droppedImportant);
    expect(plan.dropped.length + events.length).toBe(plan.candidates);
  });
});

describe('QR round trip', () => {
  it('carries a 40-event packet through real QR pixels, out of order with duplicates', async () => {
    const { log, medics } = scenario(40);
    const packet = buildPacket({ keys: medics.keys, log });
    expect(packet.events.length).toBe(40);
    const frames = await toFrames(packet);
    console.log(`ferry: 40-event packet -> ${frames.length} QR frames (chunk ${frames[0]!.data.length} chars)`);

    const scanned = qrRoundTrip(frames);
    const order = [...scanned].reverse();
    const mixed = [...order.slice(3), ...order.slice(0, 3), ...scanned.slice(0, 4), ...order];
    const asm = new FrameAssembler();
    for (const f of mixed) asm.add(f);
    expect(asm.done).toBe(true);
    const got = await asm.packet();
    expect(got).toEqual(packet);
    expect(verifyPacket(got, { mission: MISSION })).toEqual({ ok: true });

    const receiver = new EventLog(MISSION);
    const first = ingestPacket(receiver, got, { mission: MISSION });
    expect(first).toMatchObject({ ok: true, newEvents: 40, duplicates: 0, rejected: 0 });
    expect(receiver.all().map((e) => e.id)).toEqual(log.all().map((e) => e.id));
  });

  it('ingesting the same packet twice is a no-op', async () => {
    const { log, medics } = scenario(20);
    const packet = buildPacket({ keys: medics.keys, log });
    const asm = new FrameAssembler();
    for (const f of qrRoundTrip(await toFrames(packet))) asm.add(f);
    const got = await asm.packet();
    const receiver = new EventLog(MISSION);
    ingestPacket(receiver, got, { mission: MISSION });
    const before = receiver.summary();
    const again = ingestPacket(receiver, got, { mission: MISSION });
    expect(again).toMatchObject({ ok: true, newEvents: 0, duplicates: 20, rejected: 0 });
    expect(receiver.summary()).toEqual(before);
    expect(receiver.size).toBe(20);
  });

  it('rejects a truncated sequence', async () => {
    const { log, medics } = scenario(20);
    const frames = qrRoundTrip(await toFrames(buildPacket({ keys: medics.keys, log })));
    expect(frames.length).toBeGreaterThan(2);
    const asm = new FrameAssembler();
    for (const f of frames.slice(0, -1)) asm.add(f);
    expect(asm.done).toBe(false);
    expect(asm.missing()).toEqual([frames.length - 1]);
    await expect(asm.packet()).rejects.toThrow(/incomplete/);
  });

  it('drops corrupt frames and frames from another packet', async () => {
    const a = scenario(10);
    const b = scenario(10);
    const fa = await toFrames(buildPacket({ keys: a.medics.keys, log: a.log, wall: 1 }));
    const fb = await toFrames(buildPacket({ keys: b.medics.keys, log: b.log, wall: 2 }));
    const asm = new FrameAssembler();
    asm.add(fa[0]!);
    asm.add({ ...fa[1]!, data: 'AAAA' + fa[1]!.data.slice(4) });
    asm.add(fb[1]!);
    expect(asm.rejected).toBe(2);
    expect(asm.add(fa[1]!).have).toBe(2);

    const img = frameImage(fa[0]!);
    for (let i = 0; i < img.data.length; i += 4) if ((i / 4) % 3 === 0) img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 - img.data[i]!;
    const noisy = readFrame(img);
    expect(noisy === null || noisy.data === fa[0]!.data).toBe(true);
  });
});

describe('tampering and policy', () => {
  it('detects a modified event, a modified packet and a swapped signer', () => {
    const { log, medics, access } = scenario(12);
    const p = buildPacket({ keys: medics.keys, log });

    const body = structuredClone(p);
    (body.events[0] as { wall: number }).wall += 1;
    expect(verifyPacket(body).ok).toBe(false);

    const sum = structuredClone(p);
    sum.createdAt += 1;
    expect(verifyPacket(sum)).toEqual({ ok: false, reason: 'bad packet signature' });

    const dropped = structuredClone(p);
    dropped.events = dropped.events.slice(1);
    expect(verifyPacket(dropped).ok).toBe(false);

    const swapped = { ...p, from: access.keys.publicKey };
    expect(verifyPacket(swapped)).toEqual({ ok: false, reason: 'bad packet signature' });
  });

  it('detects a tampered event even when the signer re-signs the packet', () => {
    const { log, medics, access } = scenario(12);
    const p = buildPacket({ keys: medics.keys, log });
    p.events[2] = { ...p.events[2]!, lamport: 999 } as AnyEvent;
    const { sig: _s, ...rest } = p;
    p.sig = signBytes(medics.keys.secretKey, new TextEncoder().encode(canonicalize(rest)));
    expect(access.keys.publicKey).not.toBe(p.from);
    const r = verifyPacket(p);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/invalid event/);
  });

  it('refuses a packet for another mission', () => {
    const { log, medics } = scenario(8);
    const p = buildPacket({ keys: medics.keys, log });
    expect(verifyPacket(p, { mission: 'other-mission' })).toEqual({ ok: false, reason: 'wrong mission' });
    const receiver = new EventLog('other-mission');
    const r = ingestPacket(receiver, p, { mission: 'other-mission' });
    expect(r.ok).toBe(false);
    expect(receiver.size).toBe(0);
  });

  it('refuses an expired packet', () => {
    const { log, medics } = scenario(4);
    const p = buildPacket({ keys: medics.keys, log, wall: 1000 });
    expect(verifyPacket(p, { now: 5000, maxAgeMs: 10_000 }).ok).toBe(true);
    expect(verifyPacket(p, { now: 50_000, maxAgeMs: 10_000 })).toEqual({ ok: false, reason: 'packet expired' });
  });
});
