import { afterEach, describe, expect, it } from 'vitest';
import { wsSignalClient } from '@afterlink/mesh';
import type { SignalClient, SignalMessage } from '@afterlink/protocol';
import { startServer } from '../src/server.ts';

const open: Array<{ close(): void | Promise<void> }> = [];
afterEach(async () => {
  for (const o of open.splice(0)) await o.close();
});

const until = async (fn: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

function client(url: string): { c: SignalClient; got: SignalMessage[] } {
  const c = wsSignalClient(url);
  const got: SignalMessage[] = [];
  c.onMessage((m) => got.push(m));
  open.push(c);
  return { c, got };
}

describe('relay with the real signalling hub', () => {
  it('two websocket clients exchange signals and receive an external request', async () => {
    const srv = await startServer({ port: 0, env: { N8N_INGRESS_SECRET: 'secret-secret-1', AFTERLINK_RATE_PER_MINUTE: '1000' } });
    open.push(srv);
    const url = `ws://127.0.0.1:${srv.port}/signal`;
    const a = client(url);
    const b = client(url);
    await until(() => a.c.connected && b.c.connected);
    a.c.send({ t: 'hello', room: 'room-1', actor: 'actor-a' });
    b.c.send({ t: 'hello', room: 'room-1', actor: 'actor-b' });
    await until(() => a.got.some((m) => m.t === 'joined' && m.actor === 'actor-b'));
    a.c.send({ t: 'signal', from: 'actor-a', to: 'actor-b', data: { sdp: 'offer' } });
    await until(() => b.got.some((m) => m.t === 'signal' && m.from === 'actor-a'));

    const res = await fetch(`http://127.0.0.1:${srv.port}/ingress/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-afterlink-ingress-secret': 'secret-secret-1' },
      body: JSON.stringify({ sourceId: 'intake-0001', request: { title: 'Spill near the stage' } }),
    });
    expect([200, 202]).toContain(res.status);
    await until(() => [...a.got, ...b.got].some((m) => m.t === 'ingress' && m.spec.id === 'ext-intake-0001'));
  });
});
