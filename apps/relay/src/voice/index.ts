import type { Context, Hono } from 'hono';
import { join } from 'node:path';
import { ClipCache, clipKey } from './cache.js';
import { STT_MODEL, TTS_MODEL, voiceFor } from './voices.js';

export interface VoiceContext {
  limits: { take(name: string): unknown };
}

const API = 'https://api.elevenlabs.io/v1';
const MAX_TEXT = 1200;
const MAX_AUDIO = 8 * 1024 * 1024;

async function take(ctx: VoiceContext): Promise<boolean> {
  const v = await ctx.limits.take('elevenlabs');
  if (v === false) return false;
  if (v && typeof v === 'object') {
    const o = v as { ok?: boolean; allowed?: boolean };
    return o.ok !== false && o.allowed !== false;
  }
  return true;
}

export function register(app: Hono, ctx: VoiceContext): void {
  const cache = new ClipCache(process.env.VOICE_CACHE_DIR ?? join(process.cwd(), '.afterlink-cache', 'voice'));
  const inflight = new Map<string, Promise<Uint8Array | { error: 429 | 502 }>>();

  const audio = (c: Context, bytes: Uint8Array, source: 'cache' | 'live', voice: string) =>
    c.body(bytes as unknown as ArrayBuffer, 200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=86400',
      'X-Voice-Source': source,
      'X-Voice-Voice': voice,
      'X-Voice-Model': TTS_MODEL,
    });

  app.post('/api/voice/brief', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; role?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const role = typeof body?.role === 'string' ? body.role : 'system';
    if (!text || text.length > MAX_TEXT) return c.json({ error: `text must be 1 to ${MAX_TEXT} characters` }, 400);

    const voice = voiceFor(role);
    const k = clipKey(TTS_MODEL, voice.id, text);
    const hit = await cache.get(k);
    if (hit) return audio(c, hit, 'cache', voice.name);

    if (!(await take(ctx))) return c.json({ live: false, error: 'rate limited' }, 429);
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return c.json({ live: false }, 503);

    let job = inflight.get(k);
    if (!job) {
      job = (async () => {
        const res = await fetch(`${API}/text-to-speech/${voice.id}?output_format=mp3_44100_64`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: voice.settings }),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => null);
        if (!res) return { error: 502 as const };
        if (!res.ok) return { error: res.status === 429 ? (429 as const) : (502 as const) };
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_AUDIO) return { error: 502 as const };
        await cache.put(k, bytes);
        return bytes;
      })().finally(() => inflight.delete(k));
      inflight.set(k, job);
    }
    const out = await job;
    if (out instanceof Uint8Array) return audio(c, out, 'live', voice.name);
    return c.json({ live: false, error: 'speech synthesis failed' }, out.error);
  });

  app.post('/api/voice/transcribe', async (c) => {
    let file: Blob | null = null;
    const type = c.req.header('content-type') ?? '';
    if (type.startsWith('multipart/form-data')) {
      const parsed = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
      if (parsed.file instanceof Blob) file = parsed.file;
    } else if (type.startsWith('audio/') || type.startsWith('video/')) {
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength) file = new Blob([buf], { type: type.split(';')[0] });
    }
    if (!file || file.size === 0) return c.json({ error: 'audio required' }, 400);
    if (file.size > MAX_AUDIO) return c.json({ error: 'audio too large' }, 413);

    const lang = c.req.query('language');
    if (lang !== undefined && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) return c.json({ error: 'invalid language' }, 400);

    if (!(await take(ctx))) return c.json({ live: false, error: 'rate limited' }, 429);
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return c.json({ live: false }, 503);

    const form = new FormData();
    form.append('model_id', STT_MODEL);
    form.append('file', file, 'speech.webm');
    if (lang) form.append('language_code', lang);
    const res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form, signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!res || !res.ok) return c.json({ live: false, error: 'transcription failed' }, 502);
    const json = (await res.json().catch(() => ({}))) as { text?: string; language_code?: string };
    return c.json({ live: true, text: (json.text ?? '').trim(), language: json.language_code ?? null, model: STT_MODEL });
  });
}
