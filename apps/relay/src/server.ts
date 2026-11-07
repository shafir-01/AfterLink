import { readFile, stat } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SignalMessage } from '@afterlink/protocol';
import { createContext, type RelayContext } from './context.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const MAX_SOCKETS_PER_IP = 32;
const MAX_FRAME_BYTES = 262_144;
const MAX_FRAMES_PER_WINDOW = 400;
const FRAME_WINDOW_MS = 10_000;
const MAX_HELLOS_PER_SOCKET = 10;

const KB = 1024;
const BODY_LIMITS: [RegExp, number][] = [
  [/^\/api\/voice\/transcribe$/, 9 * KB * KB],
  [/^\/api\/debrief\/narrate$/, KB * KB],
  [/^\/report\/debrief$/, KB * KB],
  [/^\/api\/mission\/compile$/, 64 * KB],
  [/^\/api\/triage$/, 32 * KB],
  [/^\/api\/voice\/brief$/, 16 * KB],
  [/^\/ingress\/request$/, 16 * KB],
];
const DEFAULT_BODY_LIMIT = 4 * KB;
const SUB_ROUTERS = ['ai', 'voice', 'ingress'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/**
 * Client address for limits. Forwarded headers are only trusted for the number of proxy hops the host
 * adds (one on Render), counted from the right, because the left side is written by the client.
 */
export function ipFrom(forwarded: string | undefined, socketAddr: string | undefined, hops = 0): string {
  if (hops > 0 && forwarded) {
    const parts = forwarded.split(',').map((x) => x.trim()).filter(Boolean);
    const pick = parts[Math.max(0, parts.length - hops)];
    if (pick) return pick.slice(0, 64);
  }
  return socketAddr || 'unknown';
}

export function trustedHops(env: NodeJS.ProcessEnv): number {
  const n = Number(env.AFTERLINK_TRUST_PROXY_HOPS);
  if (env.AFTERLINK_TRUST_PROXY_HOPS !== undefined && env.AFTERLINK_TRUST_PROXY_HOPS !== '' && Number.isInteger(n) && n >= 0) return n;
  return env.RENDER ? 1 : 0;
}

const digest = (v: string) => createHash('sha256').update(v).digest();
export const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function tokenOk(c: Context, ctx: RelayContext): boolean | null {
  const want = ctx.env.AFTERLINK_ADMIN_TOKEN;
  if (!want) return null;
  const auth = c.req.header('authorization') ?? '';
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : (c.req.header('x-admin-token') ?? '');
  return safeEqual(got, want);
}

async function loadSubRouters(app: Hono, ctx: RelayContext): Promise<void> {
  for (const name of SUB_ROUTERS) {
    for (const rel of [`./${name}/index.ts`, `./${name}.ts`]) {
      const file = resolve(here, rel);
      try {
        await stat(file);
      } catch {
        continue;
      }
      try {
        const mod = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
          register?: (a: Hono, c: RelayContext) => void;
        };
        if (typeof mod.register === 'function') {
          mod.register(app, ctx);
          ctx.routers.push(name);
        }
      } catch (e) {
        console.error(`router ${name} failed to load: ${(e as Error).message}`);
      }
      break;
    }
  }
}

export async function createApp(ctx: RelayContext, opts: { webDist?: string } = {}): Promise<Hono> {
  const app = new Hono();
  const webOrigins = (ctx.env.AFTERLINK_WEB_ORIGIN ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const hops = trustedHops(ctx.env);
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

  app.use(
    '*',
    cors({
      origin: (origin) => (origin && (webOrigins.includes(origin) || local.test(origin)) ? origin : null),
      allowHeaders: ['content-type', 'authorization', 'x-admin-token'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  );

  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const sock = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
    const ip = ipFrom(c.req.header('x-forwarded-for'), sock?.remoteAddress, hops);
    if (!ctx.limits.hit(ip)) return c.json({ error: 'rate-limited' }, 429, { 'retry-after': '60' });

    if (c.req.method === 'POST') {
      const path = c.req.path;
      const origin = c.req.header('origin');
      if (origin && !webOrigins.includes(origin) && !local.test(origin)) {
        let sameHost = false;
        try {
          sameHost = new URL(origin).host === c.req.header('host');
        } catch {
          sameHost = false;
        }
        if (!sameHost) return c.json({ error: 'origin not allowed' }, 403);
      }
      const bucket = path.startsWith('/admin/') ? 'admin' : /^\/(api|report)\//.test(path) ? 'paid' : null;
      if (bucket && !ctx.limits.hit(ip, bucket)) return c.json({ error: 'rate-limited' }, 429, { 'retry-after': '60' });
      const max = BODY_LIMITS.find(([re]) => re.test(path))?.[1] ?? DEFAULT_BODY_LIMIT;
      return bodyLimit({ maxSize: max, onError: (cc) => cc.json({ error: 'payload too large' }, 413) })(c, next);
    }
    return next();
  });

  app.get('/health', (c) => c.json({ ok: true, signal: ctx.hq.alive() }));

  app.get('/api/status', (c) => {
    const s = ctx.limits.spend();
    return c.json({
      ok: true,
      signal: ctx.hq.alive(),
      services: ctx.services(),
      routers: ctx.routers,
      ai: { enabled: s.aiEnabled, budget: s.budget, remaining: s.remaining },
      spend: { day: s.day, calls: s.calls, total: s.total },
      hq: ctx.hq.stats(),
    });
  });

  app.post('/admin/kill', (c) => {
    const ok = tokenOk(c, ctx);
    if (ok === null) return c.json({ error: 'admin disabled' }, 503);
    if (!ok) return c.json({ error: 'forbidden' }, 403);
    return c.json({ ok: true, signal: false, closed: ctx.hq.kill() });
  });
  app.post('/admin/restore', (c) => {
    const ok = tokenOk(c, ctx);
    if (ok === null) return c.json({ error: 'admin disabled' }, 503);
    if (!ok) return c.json({ error: 'forbidden' }, 403);
    ctx.hq.restore();
    return c.json({ ok: true, signal: true });
  });

  await loadSubRouters(app, ctx);

  const dist = resolve(opts.webDist ?? resolve(here, '../../web/dist'));
  let hasDist = false;
  try {
    hasDist = (await stat(join(dist, 'index.html'))).isFile();
  } catch {
    hasDist = false;
  }
  if (hasDist) {
    app.get('*', async (c) => {
      const path = c.req.path;
      if (/^\/(api|admin|ingress|report|signal|health)(\/|$)/.test(path)) return c.json({ error: 'not found' }, 404);
      let rel: string;
      try {
        rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
      } catch {
        return c.json({ error: 'bad request' }, 400);
      }
      const abs = resolve(dist, rel);
      if (abs !== dist && !abs.startsWith(dist + sep)) return c.json({ error: 'not found' }, 404);
      try {
        if ((await stat(abs)).isFile()) {
          const hashed = /[-.][A-Za-z0-9_-]{8,}\.\w+$/.test(abs);
          return c.body(new Uint8Array(await readFile(abs)), 200, {
            'content-type': MIME[extname(abs)] ?? 'application/octet-stream',
            'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
            'x-afterlink-relay': '1',
          });
        }
      } catch {
        // fall through to SPA fallback
      }
      if (extname(rel)) return c.json({ error: 'not found' }, 404);
      return c.body(new Uint8Array(await readFile(join(dist, 'index.html'))), 200, {
        'content-type': MIME['.html']!,
        'cache-control': 'no-cache',
      });
    });
  }

  app.onError((e, c) => {
    console.error(`request failed: ${e.name}`);
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));
  return app;
}

export function attachSignal(server: Server, ctx: RelayContext): { closeAll(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const hops = trustedHops(ctx.env);
  const perIp = new Map<string, number>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/signal') {
      socket.destroy();
      return;
    }
    const fwd = req.headers['x-forwarded-for'];
    const ip = ipFrom(Array.isArray(fwd) ? fwd.join(',') : fwd, req.socket.remoteAddress, hops);
    if (!ctx.hq.alive() || (perIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP || !ctx.limits.hit(ip)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const left = (perIp.get(ip) ?? 1) - 1;
        if (left <= 0) perIp.delete(ip);
        else perIp.set(ip, left);
      };
      const session = ctx.hq.open(
        (m) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
        },
        () => {
          release();
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1012, 'relay stopped');
        },
      );
      if (!session) {
        release();
        ws.close(1013, 'unavailable');
        return;
      }
      let windowStart = Date.now();
      let frames = 0;
      let hellos = 0;
      ws.on('message', (data) => {
        const t = Date.now();
        if (t - windowStart >= FRAME_WINDOW_MS) {
          windowStart = t;
          frames = 0;
        }
        if (++frames > MAX_FRAMES_PER_WINDOW) {
          ws.close(1008, 'too many messages');
          return;
        }
        try {
          const m = JSON.parse(data.toString()) as SignalMessage;
          if (m.t === 'ingress') return;
          if (m.t === 'hello' && ++hellos > MAX_HELLOS_PER_SOCKET) {
            ws.close(1008, 'too many joins');
            return;
          }
          session.receive(m);
        } catch {
          ws.close(1003, 'bad message');
        }
      });
      ws.on('close', () => {
        release();
        session.close();
      });
      ws.on('error', () => ws.terminate());
    });
  });

  return {
    closeAll() {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

export async function startServer(o: { port?: number; env?: NodeJS.ProcessEnv; ctx?: RelayContext; webDist?: string } = {}) {
  const ctx = o.ctx ?? (await createContext({ env: o.env }));
  const app = await createApp(ctx, { webDist: o.webDist });
  const server = createServer(getRequestListener(app.fetch));
  const sockets = attachSignal(server, ctx);
  const port = o.port ?? Number(ctx.env.PORT ?? 8787);
  await new Promise<void>((r) => server.listen(port, r));
  return {
    ctx,
    app,
    port: (server.address() as AddressInfo).port,
    async close() {
      sockets.closeAll();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;
if (isMain) {
  startServer().then((s) => console.log(`afterlink relay listening on :${s.port}`));
  const stop = () => process.exit(0);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
