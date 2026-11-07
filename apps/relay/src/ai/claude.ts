import Anthropic from '@anthropic-ai/sdk';
import type { Context, Hono } from 'hono';
import { refusal, type AiContext } from './types.js';

export const MODEL = 'claude-sonnet-5-5';

export interface CallMeta {
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}

export class ModelError extends Error {
  constructor(message: string, readonly status: 422 | 502) {
    super(message);
  }
}

let cached: { key: string; client: Anthropic } | null = null;

export function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!cached || cached.key !== key) cached = { key, client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 }) };
  return cached.client;
}

export function emptyMeta(): CallMeta {
  return { model: MODEL, latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
}

export function addMeta(a: CallMeta, b: CallMeta): CallMeta {
  return {
    model: b.model,
    latencyMs: a.latencyMs + b.latencyMs,
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
      cacheReadTokens: a.usage.cacheReadTokens + b.usage.cacheReadTokens,
      cacheWriteTokens: a.usage.cacheWriteTokens + b.usage.cacheWriteTokens,
    },
  };
}

export interface JsonCall {
  system: string;
  messages: Anthropic.MessageParam[];
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface JsonResult {
  data: unknown;
  text: string;
  meta: CallMeta;
}

export async function callJson(client: Anthropic, call: JsonCall): Promise<JsonResult> {
  const started = Date.now();
  let res: Anthropic.Message;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: call.maxTokens,
      system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
      messages: call.messages,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: call.schema } },
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) throw new ModelError(`Model request failed (${e.status ?? 'network'})`, 502);
    throw e;
  }
  const meta: CallMeta = {
    model: res.model || MODEL,
    latencyMs: Date.now() - started,
    usage: {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    },
  };
  if (res.stop_reason === 'refusal') throw new ModelError('The model declined this request', 422);
  if (res.stop_reason === 'max_tokens') throw new ModelError('The model output was cut off', 502);
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    return { data: JSON.parse(text), text, meta };
  } catch {
    throw new ModelError('The model returned malformed output', 502);
  }
}

export function post<T>(
  app: Hono,
  ctx: AiContext,
  path: string,
  run: (client: Anthropic, body: T, charge: () => boolean) => Promise<{ status?: 200 | 422; body: Record<string, unknown> }>,
  parse: (raw: unknown) => T | string,
): void {
  app.post(path, async (c: Context) => {
    const raw = await c.req.json().catch(() => undefined);
    const parsed = parse(raw);
    if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
    const blocked = refusal(ctx);
    if (blocked) return c.json(blocked.status === 503 ? { live: false, error: blocked.reason } : { error: blocked.reason }, blocked.status);
    const client = getClient();
    if (!client) return c.json({ live: false, error: 'AI service is not configured' }, 503);
    try {
      const out = await run(client, parsed, () => refusal(ctx) === null);
      return c.json({ live: true, ...out.body }, out.status ?? 200);
    } catch (e) {
      if (e instanceof ModelError) return c.json({ live: true, error: e.message }, e.status);
      throw e;
    }
  });
}

export const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
