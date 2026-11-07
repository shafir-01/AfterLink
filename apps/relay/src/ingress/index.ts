import { timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { IngressService, ingressBody, type IngressTransport } from './service.ts';

export * from './service.ts';

export interface IngressContext {
  env: Record<string, string | undefined>;
  /** Path to connected devices. Provided by the relay core; without it every request queues. */
  ingress?: IngressTransport;
  fetch?: typeof fetch;
}

export const SECRET_HEADER = 'x-afterlink-ingress-secret';

const secretFrom = (env: IngressContext['env']) => env.AFTERLINK_INGRESS_SECRET || env.N8N_INGRESS_SECRET;

function secretOk(c: Context, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(c.req.header(SECRET_HEADER) ?? '');
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function debriefTarget(env: IngressContext['env']): string | null {
  const direct = env.N8N_WEBHOOK_URL || env.N8N_DEBRIEF_WEBHOOK_URL || env.AFTERLINK_N8N_WEBHOOK_URL;
  if (direct) return direct;
  if (env.N8N_BASE_URL) return `${env.N8N_BASE_URL.replace(/\/+$/, '')}/webhook/afterlink/debrief`;
  return null;
}

export function register(app: Hono, ctx: IngressContext): IngressService {
  const env = ctx.env;
  const doFetch = ctx.fetch ?? fetch;
  const transport: IngressTransport = ctx.ingress ?? { deliver: () => false };
  const service = new IngressService({ transport, objective: env.AFTERLINK_INGRESS_OBJECTIVE });
  const timer = setInterval(() => service.flush(), 3000);
  timer.unref?.();

  app.post('/ingress/request', async (c) => {
    const secret = secretFrom(env);
    if (!secret) return c.json({ error: 'ingress is not configured' }, 503);
    if (!secretOk(c, secret)) return c.json({ error: 'unauthorized' }, 401);
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const parsed = ingressBody.safeParse(json);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    }
    const result = service.accept(parsed.data);
    if ('full' in result) return c.json({ error: 'ingress queue is full' }, 503);
    const { entry, duplicate } = result;
    return c.json(
      { sourceId: entry.sourceId, taskId: entry.taskId, state: entry.state, duplicate, queued: service.queued() },
      entry.state === 'delivered' ? 200 : 202,
    );
  });

  app.post('/report/debrief', async (c) => {
    const target = debriefTarget(env);
    if (!target) return c.json({ published: false, error: 'n8n is not configured' }, 503);
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) return c.json({ error: 'a mission record is required' }, 400);
    const o = json as Record<string, unknown>;
    const payload = 'record' in o ? o : { record: o };
    try {
      const res = await doFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SECRET_HEADER]: secretFrom(env) ?? '' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      let body: object = {};
      try {
        body = JSON.parse(text) as object;
      } catch {
        body = { raw: text.slice(0, 200) };
      }
      if (!res.ok) return c.json({ published: false, status: res.status, error: 'n8n rejected the report' }, 502);
      return c.json({ published: true, ...body });
    } catch (e) {
      return c.json({ published: false, error: `n8n unreachable: ${(e as Error).message}` }, 502);
    }
  });

  return service;
}
