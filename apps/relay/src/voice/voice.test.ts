import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from './index.js';
import { VOICE_ROLES, voiceFor } from './voices.js';

const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
let calls: { url: string; init: RequestInit }[] = [];
let taken: string[] = [];

function app(allow = true) {
  const a = new Hono();
  register(a, { limits: { take: (n: string) => (taken.push(n), allow) } });
  return a;
}

beforeEach(() => {
  calls = [];
  taken = [];
  process.env.VOICE_CACHE_DIR = mkdtempSync(join(tmpdir(), 'voice-'));
  process.env.ELEVENLABS_API_KEY = 'test-key';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('speech-to-text')) return new Response(JSON.stringify({ text: ' accept the task ', language_code: 'en' }));
    return new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ELEVENLABS_API_KEY;
});

const post = (a: Hono, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('voice brief', () => {
  it('returns 503 live:false without a key', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const r = await post(app(), '/api/voice/brief', { text: 'Hello', role: 'medics' });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ live: false });
    expect(taken).toEqual(['elevenlabs']);
  });

  it('synthesises with the flash model and the team voice, then serves from cache', async () => {
    const a = app();
    const r1 = await post(a, '/api/voice/brief', { text: 'Task accepted', role: 'medics' });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-voice-source')).toBe('live');
    expect(new Uint8Array(await r1.arrayBuffer())).toEqual(mp3);
    expect(calls[0]!.url).toContain(`/text-to-speech/${voiceFor('medics').id}`);
    expect(JSON.parse(calls[0]!.init.body as string).model_id).toBe('eleven_flash_v2_5');
    const r2 = await post(a, '/api/voice/brief', { text: 'Task accepted', role: 'medics' });
    expect(r2.headers.get('x-voice-source')).toBe('cache');
    expect(calls.length).toBe(1);
    const fresh = await post(app(), '/api/voice/brief', { text: 'Task accepted', role: 'medics' });
    expect(fresh.headers.get('x-voice-source')).toBe('cache');
    expect(calls.length).toBe(1);
  });

  it('rejects bad input and rate limits', async () => {
    expect((await post(app(), '/api/voice/brief', { text: '' })).status).toBe(400);
    expect((await post(app(false), '/api/voice/brief', { text: 'x' })).status).toBe(429);
  });

  it('reports upstream failure as live:false', async () => {
    vi.stubGlobal('fetch', async () => new Response('no', { status: 500 }));
    const r = await post(app(), '/api/voice/brief', { text: 'Fail case', role: 'supply' });
    expect(r.status).toBe(502);
    expect((await r.json()).live).toBe(false);
  });
});

describe('voice transcribe', () => {
  it('forwards raw audio to speech-to-text', async () => {
    const r = await app().request('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2, 3]) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ live: true, text: 'accept the task' });
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((calls[0]!.init.body as FormData).get('model_id')).toBe('scribe_v2');
  });

  it('400 without audio, 503 without key', async () => {
    const empty = await app().request('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array() });
    expect(empty.status).toBe(400);
    delete process.env.ELEVENLABS_API_KEY;
    const r = await app().request('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1]) });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ live: false });
  });
});

describe('voices', () => {
  it('gives every team a distinct voice', () => {
    const ids = VOICE_ROLES.map((r) => voiceFor(r).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
