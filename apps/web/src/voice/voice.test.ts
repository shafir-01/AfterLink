import { describe, expect, it } from 'vitest';
import type { MissionCapsule } from '@afterlink/protocol';
import { parseUtterance } from './intents.ts';
import { packItems, refusalSegments, roleBriefingText } from './phrases.ts';
import { memoryStore } from './clipStore.ts';
import { VoicePack, type Player } from './pack.ts';

const capsule = {
  id: 'm', version: 1, objective: 'Keep the festival safe',
  teams: [
    { id: 'medics', name: 'Medics', capabilities: ['first-aid'], home: { x: 0, y: 0 } },
    { id: 'supply', name: 'Supply', capabilities: ['haul'], home: { x: 1, y: 1 } },
  ],
  resources: [{ id: 'evac-chair', name: 'Evacuation chair', tokens: [{ id: 'evac-chair#1', holderTeam: 'supply' }] }],
  tasks: [{ id: 't1', title: 'Collapsed visitor', brief: 'Go to the main stage.' }],
} as unknown as MissionCapsule;

describe('intents', () => {
  it('maps utterances', () => {
    expect(parseUtterance('Accept')).toEqual({ kind: 'intent', intent: 'accept' });
    expect(parseUtterance("I can't do that")).toEqual({ kind: 'intent', intent: 'cannot' });
    expect(parseUtterance("I can't accept")).toEqual({ kind: 'intent', intent: 'cannot' });
    expect(parseUtterance("It's done")).toEqual({ kind: 'intent', intent: 'complete' });
    expect(parseUtterance('what next?')).toEqual({ kind: 'intent', intent: 'next' });
    expect(parseUtterance('banana')).toEqual({ kind: 'unknown' });
  });
  it('reads yes and no only when a confirmation is pending', () => {
    expect(parseUtterance('yes', true)).toEqual({ kind: 'reply', reply: 'yes' });
    expect(parseUtterance('cancel', true)).toEqual({ kind: 'reply', reply: 'no' });
    expect(parseUtterance('yes')).toEqual({ kind: 'unknown' });
  });
});

describe('phrases', () => {
  it('composes the no-right refusal', () => {
    expect(refusalSegments('NO_RIGHT', { resource: 'evac-chair', team: 'Supply' }).join(' ')).toBe(
      'That needs the evacuation chair. Supply holds it, and you cannot reach them.',
    );
  });
  it('pack covers briefings, task briefs, phrases and refusals', () => {
    const texts = packItems(capsule, 'medics').map((i) => i.text);
    expect(texts).toContain(roleBriefingText(capsule, 'supply'));
    expect(texts).toContain('Collapsed visitor. Go to the main stage.');
    expect(texts).toContain('Network lost. You can keep working.');
    expect(texts).toContain('That needs the evacuation chair. Supply holds it, and you cannot reach them.');
  });
});

describe('VoicePack', () => {
  const played: Blob[] = [];
  const player: Player = { play: async (b) => void played.push(b), stop() {} };
  let fetches = 0;
  const mk = (ok = true) =>
    new VoicePack({
      store: memoryStore(), player,
      fetchImpl: (async () => { fetches++; return ok ? new Response(new Blob([new Uint8Array([1, 2])], { type: 'audio/mpeg' })) : new Response('', { status: 503 }); }) as typeof fetch,
    });

  it('labels live, then cached, and plays cached with no connection', async () => {
    const p = mk();
    expect((await p.speak('Task accepted', 'medics', true)).source).toBe('live');
    const before = fetches;
    expect((await p.speak('Task accepted', 'medics', false)).source).toBe('cached');
    expect(fetches).toBe(before);
  });
  it('prepare stores everything so it is playable offline', async () => {
    const p = mk();
    const r = await p.prepare(capsule, 'medics', true);
    expect(r.failed).toBe(0);
    expect(await p.has('Network lost. You can keep working.', 'medics')).toBe(true);
  });
  it('speaks a refusal from segments, and falls back to captions when nothing is cached offline', async () => {
    const p = mk();
    const parts = refusalSegments('NO_RIGHT', { resource: 'evac-chair', team: 'Supply' });
    await p.clip(parts[0], 'medics', true);
    await p.clip(parts[1], 'medics', true);
    played.length = 0;
    const r = await p.speakSequence(parts, 'medics', false);
    expect(r.source).toBe('cached');
    expect(played.length).toBe(2);
    const cold = await mk().speakSequence(parts, 'medics', false);
    expect(cold.source).toBe('captioned');
    expect(cold.caption).toContain('Supply holds it');
  });
  it('captions only when the provider is down and nothing is cached', async () => {
    expect((await mk(false).speak('Hello there', 'medics', true)).source).toBe('captioned');
  });
});
