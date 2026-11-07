import { describe, expect, it } from 'vitest';
import { Author, EventLog, signBytes, type AnyEvent, type LinkInfo, type SignalMessage, type TaskSpec } from '@afterlink/protocol';
import { createHub, helloProofBytes, type Hub, type HubChallenge, type HubState, type ProvedHello } from '../src/index.ts';
import { keysFor, MISSION } from './helpers.ts';

function device(hub: Hub) {
  const inbox: (SignalMessage | HubChallenge)[] = [];
  const conn = hub.connect((m) => inbox.push(m));
  return {
    conn,
    inbox,
    of: <T extends string>(t: T) => inbox.filter((m) => m.t === t) as Extract<SignalMessage | HubChallenge, { t: T }>[],
    hello: (actor: string, room = 'r') => conn.receive({ t: 'hello', room, actor }),
  };
}

const spec = { id: 'x' } as unknown as TaskSpec;

function prove(dev: ReturnType<typeof device>, n: number, room = 'r') {
  const keys = keysFor(n);
  const nonce = dev.of('challenge').at(-1)!.nonce;
  const sig = signBytes(keys.secretKey, helloProofBytes(room, keys.publicKey, nonce));
  const hello: ProvedHello = { t: 'hello', room, actor: keys.publicKey, nonce, sig };
  dev.conn.receive(hello);
}

const sign = (n: number, count = 1): AnyEvent[] => {
  const log = new EventLog(MISSION);
  const author = new Author(keysFor(n), log);
  for (let i = 0; i < count; i++) author.emit('task.released', { taskId: 't', reason: `${i}` }, 0);
  return log.all();
};

describe('rooms', () => {
  it('lists peers to a newcomer and announces it to the room', () => {
    const hub = createHub();
    const a = device(hub);
    const b = device(hub);
    a.hello('a');
    b.hello('b');
    expect(a.of('peers')[0]).toEqual({ t: 'peers', peers: [] });
    expect(b.of('peers')[0]).toEqual({ t: 'peers', peers: ['a'] });
    expect(a.of('joined')).toEqual([{ t: 'joined', actor: 'b' }]);
    expect(hub.state().rooms).toEqual({ r: ['a', 'b'] });
  });

  it('keeps rooms apart', () => {
    const hub = createHub();
    const a = device(hub);
    const b = device(hub);
    a.hello('a', 'one');
    b.hello('b', 'two');
    expect(b.of('peers')[0]).toEqual({ t: 'peers', peers: [] });
    a.conn.receive({ t: 'signal', from: 'a', to: 'b', data: 1 });
    expect(b.of('signal')).toEqual([]);
  });

  it('announces departure and forgets the connection', () => {
    const hub = createHub();
    const a = device(hub);
    const b = device(hub);
    a.hello('a');
    b.hello('b');
    b.conn.close();
    expect(a.of('left')).toEqual([{ t: 'left', actor: 'b' }]);
    expect(hub.state().rooms.r).toEqual(['a']);
    expect(hub.state().actors.b?.connected).toBe(false);
  });

  it('lets a reconnecting device take over its own place without announcing a departure', () => {
    const hub = createHub();
    const a = device(hub);
    const old = device(hub);
    const fresh = device(hub);
    a.hello('a');
    old.hello('b');
    fresh.hello('b');
    old.conn.close();
    expect(a.of('left')).toEqual([]);
    expect(hub.state().rooms.r).toEqual(['a', 'b']);
    a.conn.receive({ t: 'signal', from: 'a', to: 'b', data: 1 });
    expect(fresh.of('signal')).toHaveLength(1);
    expect(old.of('signal')).toEqual([]);
  });

  it('drops a connection whose send throws', () => {
    const hub = createHub();
    const a = device(hub);
    a.hello('a');
    const b = hub.connect(() => {
      throw new Error('gone');
    });
    b.receive({ t: 'hello', room: 'r', actor: 'b' });
    expect(hub.state().rooms.r).toEqual(['a']);
  });
});

describe('signal forwarding', () => {
  it('forwards to the named peer only', () => {
    const hub = createHub();
    const [a, b, c] = [device(hub), device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    c.hello('c');
    a.conn.receive({ t: 'signal', from: 'a', to: 'b', data: { x: 1 } });
    expect(b.of('signal')).toEqual([{ t: 'signal', from: 'a', to: 'b', data: { x: 1 } }]);
    expect(c.of('signal')).toEqual([]);
  });

  it('refuses a forged sender', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    a.conn.receive({ t: 'signal', from: 'someone', to: 'b', data: 1 });
    expect(b.of('signal')).toEqual([]);
  });

  it('forwards nothing from a connection that never said hello', () => {
    const hub = createHub();
    const a = device(hub);
    const stranger = device(hub);
    a.hello('a');
    stranger.conn.receive({ t: 'signal', from: 'x', to: 'a', data: 1 });
    expect(a.of('signal')).toEqual([]);
  });
});

describe('observer', () => {
  const link: LinkInfo = { peer: 'b', state: 'open', transport: 'webrtc', sent: 1, received: 1 };

  it('records when each actor was last confirmed, in hub time', () => {
    let now = 100;
    const hub = createHub({ now: () => now });
    const keys = keysFor(0);
    const a = device(hub);
    a.hello(keys.publicKey);
    now = 250;
    a.conn.receive({ t: 'report', actor: keys.publicKey, events: [], links: [link] });
    const record = hub.state().actors[keys.publicKey]!;
    expect(record.lastConfirmedAt).toBe(250);
    expect(record.links).toEqual([link]);
  });

  it('keeps seen ids once each and credits the author of relayed events', () => {
    let now = 1;
    const hub = createHub({ now: () => now });
    const reporter = keysFor(0).publicKey;
    const author = keysFor(1).publicKey;
    const a = device(hub);
    a.hello(reporter);
    const events = sign(1, 3);
    now = 50;
    a.conn.receive({ t: 'report', actor: reporter, events, links: [] });
    a.conn.receive({ t: 'report', actor: reporter, events, links: [] });
    const state: HubState = hub.state();
    expect(state.seen).toEqual(events.map((e) => e.id));
    expect(state.actors[author]).toMatchObject({ lastSeq: 3, lastConfirmedAt: 50, connected: false });
    expect(state.recent).toHaveLength(3);
  });

  it('identifies the reporter by its connection, not by what the report claims', () => {
    const hub = createHub();
    const a = device(hub);
    a.hello('a');
    a.conn.receive({ t: 'report', actor: 'victim', events: [], links: [link] });
    expect(hub.state().actors.victim).toBeUndefined();
    expect(hub.state().actors.a?.links).toEqual([link]);
  });

  it('ignores reports from a connection that never said hello', () => {
    const hub = createHub();
    const stranger = device(hub);
    stranger.conn.receive({ t: 'report', actor: 'x', events: sign(0), links: [] });
    expect(hub.state().seen).toEqual([]);
  });

  it('refuses reported events with a bad signature', () => {
    const hub = createHub();
    const a = device(hub);
    a.hello('a');
    const [event] = sign(0);
    const forged = { ...event!, sig: event!.sig.slice(0, -2) + 'AA' } as AnyEvent;
    const junk = [null, 5, { id: 5 }, { id: 'no-signature' }, forged] as unknown as AnyEvent[];
    a.conn.receive({ t: 'report', actor: 'a', events: junk, links: 'junk' as unknown as LinkInfo[] });
    expect(hub.state().seen).toEqual([]);
    expect(hub.state().actors.a?.links).toEqual([]);
  });

  it('bounds one report', () => {
    const hub = createHub({ verifyEvents: false });
    const a = device(hub);
    a.hello('a');
    const events = Array.from({ length: 2000 }, (_, i) => ({ id: `e${i}`, actor: 'x', seq: i })) as unknown as AnyEvent[];
    a.conn.receive({ t: 'report', actor: 'a', events, links: [] });
    expect(hub.state().seen).toHaveLength(512);
  });

  it('caps recent events and keeps the newest', () => {
    const hub = createHub({ recentLimit: 2 });
    const a = device(hub);
    a.hello('a');
    const events = sign(0, 5);
    a.conn.receive({ t: 'report', actor: 'a', events, links: [] });
    expect(hub.state().recent.map((e) => e.id)).toEqual(events.slice(3).map((e) => e.id));
    expect(hub.state().seen).toHaveLength(5);
  });

  it('never sends a device anything in reply to a report', () => {
    const hub = createHub();
    const a = device(hub);
    a.hello('a');
    const before = a.inbox.length;
    a.conn.receive({ t: 'report', actor: 'a', events: sign(0), links: [] });
    expect(a.inbox).toHaveLength(before);
  });

  it('notifies observers and lets them unsubscribe', () => {
    const hub = createHub();
    let changes = 0;
    const off = hub.onChange(() => changes++);
    const a = device(hub);
    a.hello('a');
    expect(changes).toBe(1);
    off();
    a.conn.close();
    expect(changes).toBe(1);
  });
});

describe('ingress', () => {
  it('delivers each request to exactly one connected device', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    expect(hub.ingress('ref-1', spec)).toBe('delivered');
    expect(a.of('ingress').length + b.of('ingress').length).toBe(1);
    expect(hub.state().ingress.delivered).toHaveLength(1);
  });

  it('shares requests between devices', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    for (let i = 0; i < 4; i++) hub.ingress(`ref-${i}`, spec);
    expect(a.of('ingress')).toHaveLength(2);
    expect(b.of('ingress')).toHaveLength(2);
  });

  it('treats a repeated ref as a duplicate', () => {
    const hub = createHub();
    const a = device(hub);
    a.hello('a');
    hub.ingress('ref', spec);
    expect(hub.ingress('ref', spec)).toBe('duplicate');
    expect(a.of('ingress')).toHaveLength(1);
  });

  it('holds a request until a device connects', () => {
    const hub = createHub();
    expect(hub.ingress('ref', spec)).toBe('queued');
    expect(hub.ingress('ref', spec)).toBe('duplicate');
    expect(hub.state().ingress.queued).toEqual(['ref']);
    const a = device(hub);
    a.hello('a');
    expect(a.of('ingress')).toEqual([{ t: 'ingress', ref: 'ref', spec }]);
    expect(hub.state().ingress.queued).toEqual([]);
  });

  it('respects a named room', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a', 'one');
    b.hello('b', 'two');
    hub.ingress('ref', spec, 'two');
    expect(a.of('ingress')).toEqual([]);
    expect(b.of('ingress')).toHaveLength(1);
  });

  it('never accepts ingress from a device connection', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    a.conn.receive({ t: 'ingress', ref: 'forged', spec });
    expect(a.of('ingress')).toEqual([]);
    expect(b.of('ingress')).toEqual([]);
    expect(hub.state().ingress.delivered).toEqual([]);
  });
});

describe('client frames a hub must never honour', () => {
  it('ignores joined, left and peers sent by a device', () => {
    const hub = createHub();
    const [a, b] = [device(hub), device(hub)];
    a.hello('a');
    b.hello('b');
    const before = b.inbox.length;
    a.conn.receive({ t: 'joined', actor: 'ghost' });
    a.conn.receive({ t: 'left', actor: 'b' });
    a.conn.receive({ t: 'peers', peers: ['ghost'] });
    expect(b.inbox).toHaveLength(before);
    expect(hub.state().rooms.r).toEqual(['a', 'b']);
  });

  it('ignores malformed frames', () => {
    const hub = createHub();
    const a = device(hub);
    for (const junk of [null, 5, 'x', {}, { t: 'nope' }, { t: 'hello' }, { t: 'hello', room: 1, actor: 2 }]) {
      a.conn.receive(junk as unknown as SignalMessage);
    }
    expect(hub.state().rooms).toEqual({});
  });
});

describe('heartbeat', () => {
  it('answers without needing a hello', () => {
    const hub = createHub();
    const a = device(hub);
    a.conn.receive({ t: 'hb' } as unknown as SignalMessage);
    expect(a.inbox).toEqual([{ t: 'hb' }]);
  });
});

describe('key proof at hello', () => {
  it('marks a device that signs the challenge as proved', () => {
    const hub = createHub();
    const a = device(hub);
    const { publicKey } = keysFor(0);
    a.hello(publicKey);
    expect(hub.state().actors[publicKey]?.proved).toBe(false);
    const announced = a.inbox.length;
    prove(a, 0);
    expect(hub.state().actors[publicKey]?.proved).toBe(true);
    expect(a.inbox).toHaveLength(announced);
  });

  it('never lets an unproved hello displace a proved device', () => {
    const hub = createHub();
    const real = device(hub);
    const spoof = device(hub);
    const { publicKey } = keysFor(0);
    real.hello(publicKey);
    prove(real, 0);
    spoof.hello(publicKey);

    const other = device(hub);
    other.hello('other');
    other.conn.receive({ t: 'signal', from: 'other', to: publicKey, data: 1 });
    expect(real.of('signal')).toHaveLength(1);
    expect(spoof.of('signal')).toEqual([]);
    expect(spoof.of('peers')).toEqual([]);
  });

  it('lets the real device return on a new connection by proving again', () => {
    const hub = createHub();
    const old = device(hub);
    const fresh = device(hub);
    const { publicKey } = keysFor(0);
    old.hello(publicKey);
    prove(old, 0);
    fresh.hello(publicKey);
    prove(fresh, 0);
    expect(fresh.of('peers')).toHaveLength(1);
    expect(hub.state().actors[publicKey]?.proved).toBe(true);
    old.conn.close();
    expect(hub.state().rooms.r).toEqual([publicKey]);
  });

  it('rejects a wrong key, a wrong nonce and a replayed answer', () => {
    const hub = createHub();
    const a = device(hub);
    const { publicKey } = keysFor(0);
    a.hello(publicKey);
    const nonce = a.of('challenge').at(-1)!.nonce;
    const wrongKey = signBytes(keysFor(1).secretKey, helloProofBytes('r', publicKey, nonce));
    a.conn.receive({ t: 'hello', room: 'r', actor: publicKey, nonce, sig: wrongKey } as ProvedHello);
    expect(hub.state().actors[publicKey]?.proved).toBe(false);

    a.hello(publicKey);
    const second = a.of('challenge').at(-1)!.nonce;
    const stale = signBytes(keysFor(0).secretKey, helloProofBytes('r', publicKey, nonce));
    a.conn.receive({ t: 'hello', room: 'r', actor: publicKey, nonce: second, sig: stale } as ProvedHello);
    expect(hub.state().actors[publicKey]?.proved).toBe(false);

    a.hello(publicKey);
    prove(a, 0);
    const replay = device(hub);
    replay.hello(publicKey);
    const used = signBytes(keysFor(0).secretKey, helloProofBytes('r', publicKey, nonce));
    replay.conn.receive({ t: 'hello', room: 'r', actor: publicKey, nonce, sig: used } as ProvedHello);
    expect(replay.of('peers')).toEqual([]);
  });

  it('does not carry proof from one actor to another on the same connection', () => {
    const hub = createHub({ requireProof: true });
    const a = device(hub);
    const { publicKey } = keysFor(0);
    const other = keysFor(1).publicKey;
    a.hello(publicKey);
    prove(a, 0);
    a.hello(other);
    expect(hub.state().rooms.r).toEqual([publicKey]);
    expect(hub.state().actors[other]).toBeUndefined();
  });

  it('marks a second identity on a proved connection as unproved', () => {
    const hub = createHub();
    const a = device(hub);
    const { publicKey } = keysFor(0);
    const other = keysFor(1).publicKey;
    a.hello(publicKey);
    prove(a, 0);
    a.hello(other);
    expect(hub.state().actors[other]?.proved).toBe(false);
  });

  it('gives a proved device its peer list again after a repeated hello', () => {
    const hub = createHub({ requireProof: true });
    const a = device(hub);
    const { publicKey } = keysFor(0);
    a.hello(publicKey);
    prove(a, 0);
    const lists = a.of('peers').length;
    a.hello(publicKey);
    expect(a.of('peers')).toHaveLength(lists + 1);
  });

  it('admits nobody unproved when proof is required', () => {
    const hub = createHub({ requireProof: true });
    const a = device(hub);
    const { publicKey } = keysFor(0);
    a.hello(publicKey);
    expect(hub.state().rooms).toEqual({});
    expect(a.of('peers')).toEqual([]);
    prove(a, 0);
    expect(hub.state().rooms.r).toEqual([publicKey]);
    expect(a.of('peers')).toHaveLength(1);
  });
});
