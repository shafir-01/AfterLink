import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage } from '@afterlink/protocol';
import { createContext } from '../src/context.ts';
import { createLimits } from '../src/limits.ts';
import type { HubLike } from '../src/hq.ts';
import { startServer } from '../src/server.ts';

function testHub(): HubLike {
  const conns = new Map<string, (m: SignalMessage) => void>();
  return {
    state: () => ({}),
    connect(send) {
      let me: string | null = null;
      return {
        receive(m) {
          if (m.t === 'hello') {
            me = m.actor;
            conns.set(me, send);
            send({ t: 'peers', peers: [...conns.keys()].filter((k) => k !== me) });
          } else if (m.t === 'signal') conns.get(m.to)?.(m);
        },
        close() {
          if (me) conns.delete(me);
        },
      };
    },
  };
}

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

async function boot(env: Record<string, string> = {}, webDist?: string) {
  const full = { AFTERLINK_ADMIN_TOKEN: 'tok', ...env } as NodeJS.ProcessEnv;
  const ctx = await createContext({ env: full, hub: testHub });
  const s = await startServer({ port: 0, ctx, webDist });
  running.push(s);
  return { s, base: `http://127.0.0.1:${s.port}`, ws: `ws://127.0.0.1:${s.port}/signal` };
}

const open = (url: string) =>
  new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(url);
    w.once('open', () => res(w));
    w.once('error', rej);
    w.once('unexpected-response', () => rej(new Error('refused')));
  });
const next = (w: WebSocket) => new Promise<SignalMessage>((r) => w.once('message', (d) => r(JSON.parse(d.toString()))));
const closed = (w: WebSocket) => new Promise<number>((r) => w.once('close', (code) => r(code)));

describe('limits', () => {
  it('enforces the daily budget across providers and counts per provider', () => {
    const l = createLimits({ aiEnabled: true, dailyAiCalls: 3, ratePerMinute: 10 });
    expect(l.take('claude').ok).toBe(true);
    expect(l.take('elevenlabs').ok).toBe(true);
    expect(l.take('claude').ok).toBe(true);
    expect(l.take('claude')).toEqual({ ok: false, status: 429, reason: 'daily-budget' });
    expect(l.spend().calls).toEqual({ claude: 2, elevenlabs: 1 });
  });
  it('resets on a new UTC day', () => {
    let t = Date.UTC(2026, 0, 1, 23, 59);
    const l = createLimits({ aiEnabled: true, dailyAiCalls: 1, ratePerMinute: 10, now: () => t });
    expect(l.take('claude').ok).toBe(true);
    expect(l.take('claude').ok).toBe(false);
    t += 120_000;
    expect(l.take('claude').ok).toBe(true);
  });
  it('kill switch blocks and does not count', () => {
    const l = createLimits({ aiEnabled: false, dailyAiCalls: 5, ratePerMinute: 10 });
    expect(l.take('claude')).toEqual({ ok: false, status: 503, reason: 'disabled' });
    expect(l.spend().total).toBe(0);
    l.setAiEnabled(true);
    expect(l.take('claude').ok).toBe(true);
  });
  it('rate limits per IP within a minute window', () => {
    let t = 0;
    const l = createLimits({ aiEnabled: true, dailyAiCalls: 1, ratePerMinute: 2, now: () => t });
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('b')]).toEqual([true, true, false, true]);
    t = 61_000;
    expect(l.hit('a')).toBe(true);
  });
});

describe('http', () => {
  it('health and status expose booleans and counts only', async () => {
    const { base } = await boot({ ANTHROPIC_API_KEY: 'sk-secret-value', AFTERLINK_AI_ENABLED: 'true' });
    expect((await (await fetch(`${base}/health`)).json()).ok).toBe(true);
    const text = await (await fetch(`${base}/api/status`)).text();
    expect(text).not.toContain('sk-secret-value');
    expect(text).not.toContain('"tok"');
    const j = JSON.parse(text);
    expect(j.services.claude).toBe(true);
    expect(j.services.elevenlabs).toBe(false);
    expect(j.spend.calls).toEqual({ claude: 0, elevenlabs: 0 });
  });
  it('cors allows localhost and the configured origin only', async () => {
    const { base } = await boot({ AFTERLINK_WEB_ORIGIN: 'https://app.example.org' });
    const get = async (origin: string) =>
      (await fetch(`${base}/health`, { headers: { origin } })).headers.get('access-control-allow-origin');
    expect(await get('http://localhost:5173')).toBe('http://localhost:5173');
    expect(await get('https://app.example.org')).toBe('https://app.example.org');
    expect(await get('https://evil.example.com')).toBeNull();
  });
  it('rate limits by forwarded ip', async () => {
    const { base } = await boot({ AFTERLINK_RATE_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '9.9.9.9' } })).status);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await fetch(`${base}/health`, { headers: { 'x-forwarded-for': '8.8.8.8' } })).status).toBe(200);
  });
  it('serves static files with SPA fallback and never shadows api routes', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'relay-dist-'));
    writeFileSync(join(dist, 'index.html'), '<html>shell</html>');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    const { base } = await boot({}, dist);
    expect(await (await fetch(`${base}/`)).text()).toContain('shell');
    expect(await (await fetch(`${base}/debrief/x`)).text()).toContain('shell');
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/..%2f..%2fpackage.json`)).status).not.toBe(200);
  });
  it('starts without a web build', async () => {
    const { base } = await boot({}, join(tmpdir(), 'does-not-exist-xyz'));
    expect((await fetch(`${base}/`)).status).toBe(404);
  });
});

describe('admin and signalling', () => {
  it('relays signalling between sockets', async () => {
    const { ws } = await boot();
    const a = await open(ws);
    const b = await open(ws);
    const pa = next(a);
    a.send(JSON.stringify({ t: 'hello', room: 'r', actor: 'A' }));
    expect(await pa).toEqual({ t: 'peers', peers: [] });
    const pb = next(b);
    b.send(JSON.stringify({ t: 'hello', room: 'r', actor: 'B' }));
    await pb;
    const got = next(a);
    b.send(JSON.stringify({ t: 'signal', from: 'B', to: 'A', data: { x: 1 } }));
    expect(await got).toEqual({ t: 'signal', from: 'B', to: 'A', data: { x: 1 } });
    a.close();
    b.close();
  });
  it('kill needs the token, closes sockets, keeps the process up, restore reopens', async () => {
    const { base, ws } = await boot();
    const a = await open(ws);
    const gone = closed(a);
    expect((await fetch(`${base}/admin/kill`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/admin/kill`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(403);
    const k = await fetch(`${base}/admin/kill`, { method: 'POST', headers: { authorization: 'Bearer tok' } });
    expect((await k.json()).closed).toBe(1);
    await gone;
    expect((await (await fetch(`${base}/health`)).json()).signal).toBe(false);
    await expect(open(ws)).rejects.toBeTruthy();
    expect((await fetch(`${base}/admin/restore`, { method: 'POST' })).status).toBe(403);
    expect((await fetch(`${base}/admin/restore`, { method: 'POST', headers: { 'x-admin-token': 'tok' } })).status).toBe(200);
    const b = await open(ws);
    b.close();
  });
  it('admin is disabled without a configured token', async () => {
    const ctx = await createContext({ env: {} as NodeJS.ProcessEnv, hub: testHub });
    const s = await startServer({ port: 0, ctx });
    running.push(s);
    expect((await fetch(`http://127.0.0.1:${s.port}/admin/kill`, { method: 'POST' })).status).toBe(503);
  });
  it('counts reports without deciding anything', async () => {
    const { ws, base } = await boot();
    const a = await open(ws);
    a.send(JSON.stringify({ t: 'hello', room: 'r', actor: 'A' }));
    await next(a);
    a.send(JSON.stringify({ t: 'report', actor: 'A', events: [], links: [] }));
    await new Promise((r) => setTimeout(r, 100));
    const j = await (await fetch(`${base}/api/status`)).json();
    expect(j.hq.reports).toBe(1);
    expect(j.hq.actors).toBe(1);
    a.close();
  });
});
