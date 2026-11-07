import { afterEach, describe, expect, it } from 'vitest';
import { createHub, encodeFrames, FrameDecoder, type HubFrame } from '@afterlink/mesh';
import { createEvent, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, SignalMessage, WireMessage } from '@afterlink/protocol';
import { Fleet, TEAMS, doubleSpends, forks } from './fleet.ts';

function client(hub: ReturnType<typeof createHub>) {
  const inbox: HubFrame[] = [];
  const conn = hub.connect((m) => inbox.push(m as HubFrame));
  return { inbox, conn };
}

const hello = (room: string, actor: string) => ({ t: 'hello', room, actor }) as SignalMessage;

describe('signalling hub, configured as the relay configures it', () => {
  it('a stranger cannot evict a live device by saying its name', () => {
    const hub = createHub();
    const real = client(hub);
    const id = generateKeys().publicKey;
    real.conn.receive(hello('room', id));
    const other = client(hub);
    const otherId = generateKeys().publicKey;
    other.conn.receive(hello('room', otherId));
    const impostor = client(hub);
    impostor.conn.receive(hello('room', id));
    other.conn.receive({ t: 'signal', from: otherId, to: id, data: 'for the real device' } as SignalMessage);
    expect(impostor.inbox.some((m) => m.t === 'signal')).toBe(false);
    expect(real.inbox.some((m) => m.t === 'signal')).toBe(true);
  });

  it('a stranger cannot make an offline device look alive to the observer', () => {
    let time = 1000;
    const hub = createHub({ now: () => time });
    const device = generateKeys().publicKey;
    const real = client(hub);
    real.conn.receive(hello('room', device));
    real.conn.close();
    const seenBefore = hub.state().actors[device]!.lastConfirmedAt;
    time = 99_000;
    const impostor = client(hub);
    impostor.conn.receive(hello('room', device));
    impostor.conn.receive({ t: 'report', actor: device, events: [], links: [{ peer: 'x', state: 'open', transport: 'webrtc', sent: 1, received: 1 }] } as SignalMessage);
    const after = hub.state().actors[device]!;
    expect(after.lastConfirmedAt).toBe(seenBefore);
    expect(after.links).toEqual([]);
  });

  it('a forged event in a report does not enter what HQ saw', () => {
    const hub = createHub();
    const device = generateKeys();
    const c = client(hub);
    c.conn.receive(hello('room', device.publicKey));
    c.conn.receive({ t: 'report', actor: device.publicKey, events: [{ id: 'made-up', seq: 1, actor: 'ghost' } as unknown as AnyEvent], links: [] } as SignalMessage);
    expect(hub.state().seen).toEqual([]);
  });

  it('a client cannot inject an external request through the signalling socket', () => {
    const hub = createHub();
    const device = client(hub);
    device.conn.receive(hello('room', generateKeys().publicKey));
    const attacker = client(hub);
    attacker.conn.receive({ t: 'ingress', ref: 'r', spec: {} } as unknown as SignalMessage);
    expect(device.inbox.some((m) => m.t === 'ingress')).toBe(false);
  });

  it('one reporter cannot grow what HQ holds without bound', () => {
    const hub = createHub();
    const k = generateKeys();
    const c = client(hub);
    c.conn.receive(hello('room', k.publicKey));
    for (let batch = 0; batch < 4; batch++) {
      const events = Array.from({ length: 2000 }, (_, i) =>
        createEvent({ keys: k, mission: 'm', seq: batch * 2000 + i + 1, prev: batch || i ? 'p' : null, parents: [], lamport: 1, wall: 1, type: 'right.declined', body: { transfer: 'x' } }),
      );
      c.conn.receive({ t: 'report', actor: k.publicKey, events: events as AnyEvent[], links: [] } as SignalMessage);
    }
    expect(hub.state().seen.length).toBeLessThanOrEqual(4096);
  });
});

describe('wire framing', () => {
  it('a message larger than one data channel frame crosses intact', () => {
    const big = { t: 'ping', n: 1, pad: 'x'.repeat(500_000) } as unknown as WireMessage;
    const decoder = new FrameDecoder();
    let out: unknown = null;
    for (const f of encodeFrames(big)) {
      const r = decoder.push(f);
      if (r.done) out = r.msg;
    }
    expect(out).toEqual(big);
  });

  it('an oversized message is refused before it is held in full', () => {
    const decoder = new FrameDecoder();
    const huge = encodeFrames({ pad: 'x'.repeat(3_000_000) });
    let held = 0;
    expect(() =>
      huge.forEach((f) => {
        decoder.push(f);
        held += f.length;
      }),
    ).toThrow(/too large/);
    expect(held).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe('sync under repeated faults', () => {
  let fleet: Fleet;
  afterEach(() => fleet?.stop());

  const settled = (f: Fleet) => {
    const heads = TEAMS.map((t) => JSON.stringify(f.node(t).view().summary.heads));
    return new Set(heads).size === 1;
  };

  it('converges after loss, duplication, reordering and split cycles, with no double spend', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.net.setLoss(0.15);
    fleet.net.setDuplicate(0.2);
    fleet.net.setReorder(true);
    for (let round = 0; round < 6; round++) {
      fleet.split(['medics', 'access'], ['facilities', 'supply']);
      fleet.node('medics').submitTask(fleet.task(`left-${round}`, { needs: [{ resource: 'aed', count: 1 }] }), { kind: 'human' });
      fleet.node('supply').submitTask(fleet.task(`right-${round}`, { needs: [{ resource: 'aed', count: 1 }] }), { kind: 'human' });
      await fleet.run(4000);
      fleet.net.heal();
      await fleet.run(4000);
    }
    fleet.net.setLoss(0);
    fleet.net.setDuplicate(0);
    fleet.net.setReorder(false);
    await fleet.run(30000);
    expect(settled(fleet)).toBe(true);
    const all = fleet.union();
    expect(forks(all)).toEqual([]);
    expect(doubleSpends(all)).toEqual([]);
    const states = TEAMS.map((t) => JSON.stringify(fleet.node(t).view().state.tokens));
    expect(new Set(states).size).toBe(1);
    expect(fleet.state().conflicts.filter((c) => c.severity === 'violation')).toEqual([]);
  });

  it('goes quiet: an idle mission does not keep signing events', async () => {
    fleet = await Fleet.start();
    await fleet.run(20000);
    const before = fleet.union().length;
    await fleet.run(60000);
    expect(fleet.union().length).toBe(before);
  });

  it('a task that needs a token is claimed once, not once per tick', async () => {
    fleet = await Fleet.start();
    fleet.node('medics').submitTask(fleet.task('needs-aed', { requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }), { kind: 'human' });
    await fleet.run(30000);
    const claims = fleet.union().filter((e) => e.type === 'task.claimed' && e.body.taskId === 'needs-aed');
    expect(claims.length).toBeLessThanOrEqual(1);
    expect(fleet.state().conflicts.filter((c) => c.severity === 'violation')).toEqual([]);
  });

  it('a released task does not leave a scarce right unusable through the real commands', async () => {
    fleet = await Fleet.start();
    const spec = fleet.task('needs-chair', { requires: ['mobility'], needs: [{ resource: 'evac-chair', count: 1 }] });
    fleet.node('access').submitTask(spec, { kind: 'human' });
    await fleet.run(2000);
    expect(fleet.node('access').acceptTask('needs-chair')).toBe(true);
    await fleet.run(1000);
    expect(fleet.node('access').declineTask('needs-chair', 'cannot reach it')).toBe(true);
    await fleet.run(2000);
    expect(fleet.node('access').view().state.tokens['evac-chair#1']!.state).toBe('held');
  });
});
