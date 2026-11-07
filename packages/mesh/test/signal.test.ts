import { MessageChannel } from 'node:worker_threads';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignalClient, SignalMessage } from '@afterlink/protocol';
import { createHub, MemoryNetwork, Mesh, portSignalClient, servePort, wsSignalClient, type Hub } from '../src/index.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await wait(5);
  }
}

const fast = { heartbeatMs: 20, timeoutMs: 80 };

/** A hub reached by MessagePort, with a kill switch that behaves like terminating a worker: silence, no notice. */
function workerHub() {
  const hub = createHub();
  const stops: (() => void)[] = [];
  return {
    hub,
    port() {
      const { port1, port2 } = new MessageChannel();
      stops.push(servePortNode(hub, port2));
      return port1 as unknown as MessagePort;
    },
    terminate() {
      for (const stop of stops) stop();
    },
  };
}

function servePortNode(hub: Hub, port: import('node:worker_threads').MessagePort): () => void {
  servePort(hub, port as unknown as MessagePort);
  return () => {
    (port as unknown as MessagePort).onmessage = null;
    port.unref();
  };
}

describe('portSignalClient', () => {
  const clients: SignalClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
  });

  it('is down until the hub has answered, then up', async () => {
    const hq = workerHub();
    const client = portSignalClient(hq.port(), fast);
    clients.push(client);
    expect(client.connected).toBe(false);
    await until(() => client.connected);
  });

  it('detects a terminated worker by silence, though a port gives no notice', async () => {
    const hq = workerHub();
    const client = portSignalClient(hq.port(), fast);
    clients.push(client);
    const states: boolean[] = [];
    client.onState((up) => states.push(up));
    await until(() => client.connected);
    hq.terminate();
    await until(() => !client.connected);
    expect(states).toEqual([true, false]);
  });

  it('carries signalling both ways', async () => {
    const hq = workerHub();
    const a = portSignalClient(hq.port(), fast);
    const b = portSignalClient(hq.port(), fast);
    clients.push(a, b);
    const got: SignalMessage[] = [];
    b.onMessage((m) => got.push(m));
    await until(() => a.connected && b.connected);
    a.send({ t: 'hello', room: 'r', actor: 'a' });
    b.send({ t: 'hello', room: 'r', actor: 'b' });
    await until(() => got.some((m) => m.t === 'peers'));
    a.send({ t: 'signal', from: 'a', to: 'b', data: 'x' });
    await until(() => got.some((m) => m.t === 'signal'));
  });

  it('hides heartbeats from the application', async () => {
    const hq = workerHub();
    const client = portSignalClient(hq.port(), fast);
    clients.push(client);
    const got: unknown[] = [];
    client.onMessage((m) => got.push(m));
    await wait(120);
    expect(got).toEqual([]);
  });

  it('drops sends while down instead of queueing them for a dead hub', async () => {
    const hq = workerHub();
    const client = portSignalClient(hq.port(), fast);
    clients.push(client);
    await until(() => client.connected);
    hq.terminate();
    await until(() => !client.connected);
    expect(() => client.send({ t: 'hello', room: 'r', actor: 'a' })).not.toThrow();
  });
});

describe('a Mesh over a real port', () => {
  it('reports signalling down after the worker dies, leaves links alone, and says hello to a new worker', async () => {
    const net = new MemoryNetwork();
    const first = workerHub();
    const a = new Mesh({ self: 'a', peers: ['b'], connector: net.connector('a'), room: 'r' });
    const b = new Mesh({ self: 'b', peers: ['a'], connector: net.connector('b'), room: 'r' });
    const firstA = portSignalClient(first.port(), fast);
    const firstB = portSignalClient(first.port(), fast);
    a.setSignal(firstA);
    b.setSignal(firstB);
    a.start();
    b.start();
    await until(() => a.links()[0]!.state === 'open' && b.links()[0]!.state === 'open');

    first.terminate();
    await until(() => !a.signalUp && !b.signalUp);
    expect(a.links()[0]!.state).toBe('open');
    expect(a.send('b', { t: 'ping', n: 1 })).toBe(true);

    const second = workerHub();
    const nextA = portSignalClient(second.port(), fast);
    const nextB = portSignalClient(second.port(), fast);
    a.setSignal(nextA);
    b.setSignal(nextB);
    await until(() => second.hub.state().rooms.r?.length === 2);
    expect(a.signalUp).toBe(true);
    expect(a.stats()[0]!.opens).toBe(1);

    for (const c of [firstA, firstB, nextA, nextB]) c.close();
    a.stop();
    b.stop();
  });
});

describe('wsSignalClient', () => {
  function server(port = 0) {
    const hub = createHub();
    const wss = new WebSocketServer({ port });
    wss.on('connection', (ws: ServerSocket) => {
      const conn = hub.connect((m) => ws.send(JSON.stringify(m)));
      ws.on('message', (data) => conn.receive(JSON.parse(data.toString()) as SignalMessage));
      ws.on('close', () => conn.close());
    });
    return {
      hub,
      wss,
      url: () => `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
      port: () => (wss.address() as { port: number }).port,
      stop: () =>
        new Promise<void>((resolve) => {
          for (const client of wss.clients) client.terminate();
          wss.close(() => resolve());
        }),
    };
  }

  const options = { minBackoffMs: 10, maxBackoffMs: 40 };

  it('connects and carries signalling', async () => {
    const s = server();
    await new Promise((resolve) => s.wss.once('listening', resolve));
    const client = wsSignalClient(s.url(), options);
    const got: SignalMessage[] = [];
    client.onMessage((m) => got.push(m));
    await until(() => client.connected);
    client.send({ t: 'hello', room: 'r', actor: 'a' });
    await until(() => got.some((m) => m.t === 'peers'));
    client.close();
    await s.stop();
  });

  it('reports the loss, then reconnects with backoff when the server returns', async () => {
    const s = server();
    await new Promise((resolve) => s.wss.once('listening', resolve));
    const port = s.port();
    const client = wsSignalClient(s.url(), options);
    const states: boolean[] = [];
    client.onState((up) => states.push(up));
    await until(() => client.connected);

    await s.stop();
    await until(() => !client.connected);
    await wait(120);
    expect(client.connected).toBe(false);

    const back = server(port);
    await new Promise((resolve) => back.wss.once('listening', resolve));
    await until(() => client.connected);
    expect(states).toEqual([true, false, true]);
    client.close();
    await back.stop();
  });

  it('keeps retrying when the server is absent at start', async () => {
    const probe = server();
    await new Promise((resolve) => probe.wss.once('listening', resolve));
    const port = probe.port();
    await probe.stop();

    const client = wsSignalClient(`ws://127.0.0.1:${port}`, options);
    await wait(80);
    expect(client.connected).toBe(false);
    const late = server(port);
    await new Promise((resolve) => late.wss.once('listening', resolve));
    await until(() => client.connected);
    client.close();
    await late.stop();
  });

  it('stops for good on close', async () => {
    const s = server();
    await new Promise((resolve) => s.wss.once('listening', resolve));
    const client = wsSignalClient(s.url(), options);
    await until(() => client.connected);
    client.close();
    await wait(60);
    expect(client.connected).toBe(false);
    expect(s.wss.clients.size).toBe(0);
    await s.stop();
  });

  it('drops a half open socket that stopped answering heartbeats', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((resolve) => wss.once('listening', resolve));
    const client = wsSignalClient(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`, {
      ...options,
      heartbeatMs: 20,
      timeoutMs: 60,
    });
    const states: boolean[] = [];
    client.onState((up) => states.push(up));
    await until(() => states.length >= 2);
    expect(states.slice(0, 2)).toEqual([true, false]);
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  });

  it('gets Mesh back onto the hub after the server returns', async () => {
    const s = server();
    await new Promise((resolve) => s.wss.once('listening', resolve));
    const port = s.port();
    const net = new MemoryNetwork();
    const client = wsSignalClient(s.url(), options);
    const mesh = new Mesh({ self: 'a', peers: ['b'], signal: client, connector: net.connector('a'), room: 'r' });
    mesh.start();
    await until(() => s.hub.state().rooms.r?.length === 1);

    await s.stop();
    await until(() => !mesh.signalUp);
    const back = server(port);
    await new Promise((resolve) => back.wss.once('listening', resolve));
    await until(() => back.hub.state().rooms.r?.length === 1);
    expect(mesh.signalUp).toBe(true);
    mesh.stop();
    client.close();
    await back.stop();
  });
});
