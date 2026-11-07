import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { register, SECRET_HEADER } from '../src/ingress/index.ts';
import type { IngressMessage } from '../src/ingress/index.ts';

const SECRET = 'test-fixture';
const body = (id = 'req-0001abcd') => ({
  sourceId: id,
  request: { title: 'Wheelchair user stuck at north gate', locationName: 'North gate' },
  classification: { kind: 'mobility', priority: 1, requires: ['mobility'], method: 'rules' },
});

function setup(opts: { connected?: boolean; env?: Record<string, string | undefined>; fetch?: typeof fetch } = {}) {
  const sent: IngressMessage[] = [];
  let up = opts.connected ?? false;
  let ready: (() => void) | undefined;
  const app = new Hono();
  const service = register(app, {
    env: { AFTERLINK_INGRESS_SECRET: SECRET, ...opts.env },
    fetch: opts.fetch,
    ingress: {
      deliver: (m) => (up ? (sent.push(m), true) : false),
      onDeviceReady: (fn) => {
        ready = fn;
      },
    },
  });
  const post = (b: unknown, headers: Record<string, string> = { [SECRET_HEADER]: SECRET }) =>
    app.request('/ingress/request', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return {
    app,
    service,
    sent,
    post,
    connect: () => {
      up = true;
      ready?.();
    },
  };
}

describe('ingress request', () => {
  it('rejects a missing or wrong secret', async () => {
    const { post, sent } = setup({ connected: true });
    expect((await post(body(), {})).status).toBe(401);
    expect((await post(body(), { [SECRET_HEADER]: 'nope' })).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('refuses to run unconfigured', async () => {
    const { post } = setup({ env: { AFTERLINK_INGRESS_SECRET: undefined } });
    expect((await post(body())).status).toBe(503);
  });

  it('validates the body', async () => {
    const { post } = setup({ connected: true });
    expect((await post({ sourceId: 'x', request: {} })).status).toBe(400);
  });

  it('delivers to a connected device with a typed spec', async () => {
    const { post, sent } = setup({ connected: true });
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'delivered', duplicate: false, taskId: 'ext-req-0001abcd' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'ingress', ref: 'req-0001abcd', spec: { id: 'ext-req-0001abcd', kind: 'mobility', priority: 1 } });
  });

  it('is idempotent on source id', async () => {
    const { post, sent } = setup({ connected: true });
    await post(body());
    const again = await post(body());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, state: 'delivered' });
    expect(sent).toHaveLength(1);
  });

  it('queues with 202 when no device is connected, then delivers once on connect', async () => {
    const { post, sent, connect, service } = setup();
    const first = await post(body());
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ state: 'queued', queued: 1 });
    const dup = await post(body());
    expect(dup.status).toBe(202);
    expect(service.queued()).toBe(1);
    connect();
    expect(sent).toHaveLength(1);
    expect(service.get('req-0001abcd')?.state).toBe('delivered');
    expect((await post(body())).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('delivers queued requests in arrival order', async () => {
    const { post, sent, connect } = setup();
    await post(body('req-aaaaaaaa'));
    await post(body('req-bbbbbbbb'));
    connect();
    expect(sent.map((m) => m.ref)).toEqual(['req-aaaaaaaa', 'req-bbbbbbbb']);
  });
});

describe('report debrief', () => {
  const post = (app: Hono, b: string) => app.request('/report/debrief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });

  it('forwards the record to n8n with the secret', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ reportUrl: 'http://n8n/webhook/afterlink/report' }), { status: 200 }));
    const { app } = setup({ env: { N8N_WEBHOOK_URL: 'http://n8n.local/webhook/afterlink/debrief' }, fetch: f as unknown as typeof fetch });
    const res = await post(app, JSON.stringify({ mission: 'm1', events: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ published: true, reportUrl: 'http://n8n/webhook/afterlink/report' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://n8n.local/webhook/afterlink/debrief');
    expect((init.headers as Record<string, string>)[SECRET_HEADER]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ record: { mission: 'm1', events: 3 } });
  });

  it('reports failure when n8n is down', async () => {
    const f = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { app } = setup({ env: { N8N_WEBHOOK_URL: 'http://n8n.local/webhook/afterlink/debrief' }, fetch: f as unknown as typeof fetch });
    const res = await post(app, '{"mission":"m1"}');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ published: false });
  });

  it('reports when n8n is not configured', async () => {
    const { app } = setup();
    expect((await post(app, '{"mission":"m1"}')).status).toBe(503);
  });
});
