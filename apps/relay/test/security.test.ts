import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SignalMessage } from '@afterlink/protocol';
import { createContext } from '../src/context.ts';
import { createLimits } from '../src/limits.ts';
import { createHq, type HubLike } from '../src/hq.ts';
import { ipFrom, startServer } from '../src/server.ts';
import { IngressService } from '../src/ingress/service.ts';
import { ClipCache } from '../src/voice/cache.ts';
import { check, type Sentence } from '../src/ai/narrate.ts';
import { overCaps } from '../src/ai/compile.ts';

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (running.length) await running.pop()!.close();
});

const recorder = () => {
  const got: SignalMessage[] = [];
  const hub: HubLike = {
    state: () => ({}),
    connect: () => ({
      receive: (m) => void got.push(m),
      close() {},
    }),
  };
  return { got, hub };
};

async function boot(env: Record<string, string> = {}, hub?: HubLike) {
  const ctx = await createContext({ env: { AFTERLINK_ADMIN_TOKEN: 'tok', ...env } as NodeJS.ProcessEnv, hub: () => hub ?? recorder().hub });
  const s = await startServer({ port: 0, ctx });
  running.push(s);
  return { base: `http://127.0.0.1:${s.port}`, ws: `ws://127.0.0.1:${s.port}/signal` };
}

const json = { 'content-type': 'application/json' };

describe('client address', () => {
  it('ignores forwarded headers unless proxy hops are configured', () => {
    expect(ipFrom('1.1.1.1', '10.0.0.1', 0)).toBe('10.0.0.1');
  });
  it('counts from the right so a spoofed left entry is ignored', () => {
    expect(ipFrom('6.6.6.6, 203.0.113.9', '10.0.0.1', 1)).toBe('203.0.113.9');
    expect(ipFrom('6.6.6.6, 203.0.113.9, 10.1.1.1', '10.0.0.1', 2)).toBe('203.0.113.9');
    expect(ipFrom(undefined, '10.0.0.1', 1)).toBe('10.0.0.1');
  });
  it('a rotating forwarded header does not escape the limit by default', async () => {
    const { base } = await boot({ AFTERLINK_RATE_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/health`, { headers: { 'x-forwarded-for': `9.9.9.${i}` } })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
});

describe('http hardening', () => {
  it('rejects oversized bodies on every post route, including chunked', async () => {
    const { base } = await boot({ AFTERLINK_RATE_PER_MINUTE: '1000', AFTERLINK_PAID_RATE_PER_MINUTE: '1000', AFTERLINK_ADMIN_RATE: '1000' });
    const big = 'x'.repeat(2_000_000);
    for (const path of ['/api/triage', '/api/mission/compile', '/api/voice/brief', '/ingress/request', '/admin/kill', '/report/debrief', '/api/debrief/narrate']) {
      const r = await fetch(base + path, { method: 'POST', headers: json, body: JSON.stringify({ a: big }) }).catch(() => ({ status: 'reset' }));
      expect([413, 'reset'], path).toContain(r.status);
    }
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":"' + 'y'.repeat(100_000)));
        c.enqueue(new TextEncoder().encode('"}'));
        c.close();
      },
    });
    const chunked = await fetch(base + '/api/triage', { method: 'POST', headers: json, body: stream, duplex: 'half' } as RequestInit).catch(() => ({ status: 'reset' }));
    expect([413, 'reset']).toContain(chunked.status);
  });

  it('answers 413 for a moderately oversized body', async () => {
    const { base } = await boot();
    const small = await fetch(base + '/ingress/request', { method: 'POST', headers: json, body: JSON.stringify({ a: 'x'.repeat(20_000) }) });
    expect(small.status).toBe(413);
  });

  it('refuses cross-site posts and allows the configured origin', async () => {
    const { base } = await boot({ AFTERLINK_WEB_ORIGIN: 'https://app.example.com', AFTERLINK_RATE_PER_MINUTE: '1000', AFTERLINK_PAID_RATE_PER_MINUTE: '1000' });
    const post = (origin: string) => fetch(`${base}/api/triage`, { method: 'POST', headers: { origin, ...json }, body: '{}' });
    expect((await post('https://evil.example.com')).status).toBe(403);
    expect((await post('https://app.example.com')).status).not.toBe(403);
    expect((await post(base)).status).not.toBe(403);
  });

  it('applies a tight per-ip limit to paid and admin routes', async () => {
    const { base } = await boot({ AFTERLINK_PAID_RATE_PER_MINUTE: '3', AFTERLINK_RATE_PER_MINUTE: '1000' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/triage`, { method: 'POST', body: '{}' })).status);
    expect(codes.slice(3)).toEqual([429, 429]);
    const admin: number[] = [];
    for (let i = 0; i < 12; i++) admin.push((await fetch(`${base}/admin/kill`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status);
    expect(admin.slice(0, 10).every((c) => c === 403)).toBe(true);
    expect(admin[11]).toBe(429);
  });

  it('never returns a stack trace or secret in an error', async () => {
    const { base } = await boot({ ANTHROPIC_API_KEY: 'sk-secret-value', AFTERLINK_INGRESS_SECRET: 'ing-fixture' });
    for (const [path, body] of [['/api/triage', '{bad'], ['/ingress/request', '{}'], ['/report/debrief', '[]'], ['/nope', '']] as const) {
      const r = await fetch(base + path, { method: 'POST', body });
      const text = await r.text();
      expect(text).not.toMatch(/sk-secret-value|ing-fixture|node_modules|\.ts:\d+/);
    }
    const status = await (await fetch(`${base}/api/status`)).text();
    expect(status).not.toMatch(/sk-secret-value|ing-secret-value|"tok"/);
  });
});

describe('signalling hardening', () => {
  const open = (url: string) =>
    new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(url);
      w.once('open', () => res(w));
      w.once('error', rej);
    });
  const closed = (w: WebSocket) => new Promise<number>((res) => w.once('close', (code) => res(code)));

  it('drops ingress frames sent by clients and closes a socket that floods joins', async () => {
    const { got, hub } = recorder();
    const { ws } = await boot({}, hub);
    const w = await open(ws);
    w.send(JSON.stringify({ t: 'ingress', ref: 'r1', spec: {} }));
    w.send(JSON.stringify({ t: 'hello', room: 'r', actor: 'a1' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => m.t)).toEqual(['hello']);
    const done = closed(w);
    for (let i = 0; i < 15; i++) w.send(JSON.stringify({ t: 'hello', room: 'r', actor: `a${i}` }));
    expect(await done).toBe(1008);
  });

  it('closes a socket that floods messages', async () => {
    const { ws } = await boot();
    const w = await open(ws);
    const done = closed(w);
    for (let i = 0; i < 500; i++) w.send(JSON.stringify({ t: 'hb' }));
    expect(await done).toBe(1008);
  });

  it('closes a socket sending an oversized frame', async () => {
    const { ws } = await boot();
    const w = await open(ws);
    const done = closed(w);
    w.send('x'.repeat(300_000));
    expect([1006, 1009]).toContain(await done);
  });
});

describe('observer bounds', () => {
  it('ignores bad names, caps actors and trims reports', () => {
    const { got, hub } = recorder();
    const hq = createHq(() => hub);
    const s = hq.open(() => {}, () => {})!;
    s.receive({ t: 'hello', room: '../x', actor: 'a' } as SignalMessage);
    s.receive({ t: 'hello', room: 'r', actor: 'x'.repeat(200) } as SignalMessage);
    expect(got).toHaveLength(0);
    for (let i = 0; i < 520; i++) s.receive({ t: 'hello', room: 'r', actor: `a${i}` } as SignalMessage);
    expect(got).toHaveLength(500);
    const events = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, actor: 'a1', seq: i }));
    s.receive({ t: 'report', actor: 'a1', events, links: [] } as unknown as SignalMessage);
    const rep = got.at(-1) as Extract<SignalMessage, { t: 'report' }>;
    expect(rep.events).toHaveLength(200);
  });
});

describe('daily budget', () => {
  const base = { aiEnabled: true, dailyAiCalls: 3, ratePerMinute: 10 };
  it('is global across callers and survives a restart', () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), 'budget-')), 'b.json');
    const t = Date.UTC(2026, 10, 7, 12);
    const a = createLimits({ ...base, persistPath, now: () => t });
    expect([a.take('claude').ok, a.take('elevenlabs').ok]).toEqual([true, true]);
    expect(JSON.parse(readFileSync(persistPath, 'utf8')).calls).toEqual({ claude: 1, elevenlabs: 1 });
    const b = createLimits({ ...base, persistPath, now: () => t });
    expect(b.spend().total).toBe(2);
    expect(b.take('claude').ok).toBe(true);
    expect(b.take('claude')).toEqual({ ok: false, status: 429, reason: 'daily-budget' });
    expect(createLimits({ ...base, persistPath, now: () => t }).take('claude').ok).toBe(false);
    expect(createLimits({ ...base, persistPath, now: () => t + 86_400_000 }).spend().total).toBe(0);
  });
  it('ignores a corrupt budget file', () => {
    const persistPath = join(mkdtempSync(join(tmpdir(), 'budget-')), 'b.json');
    writeFileSync(persistPath, '{nope');
    expect(createLimits({ ...base, persistPath }).spend().total).toBe(0);
  });
  it('rate buckets are independent', () => {
    const l = createLimits({ ...base, ratePerMinute: 100, paidPerMinute: 1 });
    expect([l.hit('a', 'paid'), l.hit('a', 'paid'), l.hit('a')]).toEqual([true, false, true]);
  });
});

describe('model output has no authority', () => {
  it('narrative drops sentences that are malformed, uncited or cite unknown events', () => {
    const bad = [
      { text: 'ok', cites: ['e1'] },
      { text: 'x'.repeat(500), cites: ['e1'] },
      { text: 'no cites', cites: 'e1' },
      { text: 'ghost', cites: ['e9'] },
    ] as unknown as Sentence[];
    const r = check(bad, new Set(['e1']));
    expect(r.accepted.map((s) => s.text)).toEqual(['ok']);
    expect(r.rejected).toHaveLength(3);
  });
  it('compile rejects oversized drafts', () => {
    const d = { teams: [], resources: [], objectives: [], contingencies: [], tasks: Array.from({ length: 100 }, () => ({ needs: [] })) } as never;
    expect(overCaps(d).length).toBe(1);
  });
});

describe('unbounded memory and paths', () => {
  it('ingress dedupe table is bounded and keeps queued entries', () => {
    const svc = new IngressService({ transport: { deliver: () => true }, maxEntries: 20 });
    for (let i = 0; i < 100; i++) {
      const r = svc.accept({ sourceId: `source-${String(i).padStart(4, '0')}`, request: { title: 'Spill' } });
      expect('full' in r).toBe(false);
    }
    const held = new IngressService({ transport: { deliver: () => false }, maxEntries: 5 });
    const results = Array.from({ length: 8 }, (_, i) => held.accept({ sourceId: `queued-${i}0000`, request: { title: 'Spill' } }));
    expect(results.filter((r) => 'full' in r)).toHaveLength(3);
  });
  it('voice cache never touches paths outside its directory', async () => {
    const c = new ClipCache(mkdtempSync(join(tmpdir(), 'clip-')));
    expect(await c.get('../../etc/passwd')).toBeNull();
    await c.put('../escape', new Uint8Array([1]));
    expect(await c.get('../escape')).toBeNull();
  });
});
