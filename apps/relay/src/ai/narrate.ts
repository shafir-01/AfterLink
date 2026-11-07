import type { Hono } from 'hono';
import type { MissionRecord } from '@afterlink/protocol';
import { addMeta, callJson, emptyMeta, post } from './claude.js';
import type { AiContext } from './types.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['sentences'],
  properties: {
    sentences: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['text', 'cites'], properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } },
    },
  },
};

const SYSTEM = `You write a short plain-language after-action narrative of a volunteer mission from a supplied record.

Rules:
- Every sentence states exactly one fact that is present in the record, and cites at least one event id from the record's timeline or conflicts in "cites".
- Never state anything the record does not show: no causes, intentions, people or numbers beyond what the events and counts say. If the record has unknowns, you may mention that they remain unknown.
- Between 4 and 10 sentences, chronological, no headings, no lists, no jargon.
- Event ids must be copied exactly.`;

const MAX_TIMELINE = 300;

interface Body { record: MissionRecord }

function parseBody(raw: unknown): Body | string {
  const r = (raw as { record?: MissionRecord } | undefined)?.record;
  if (!r || typeof r !== 'object' || !Array.isArray(r.timeline) || !Array.isArray(r.conflicts)) return 'record is required';
  return { record: r };
}

export interface Sentence { text: string; cites: string[] }
export interface Rejected { text: string; reason: string }

export function check(sentences: Sentence[], known: Set<string>): { accepted: Sentence[]; rejected: Rejected[] } {
  const accepted: Sentence[] = [];
  const rejected: Rejected[] = [];
  for (const s of sentences) {
    if (!s.cites.length) rejected.push({ text: s.text, reason: 'no event cited' });
    else if (s.cites.some((c) => !known.has(c))) rejected.push({ text: s.text, reason: 'cites an event that is not in the record' });
    else accepted.push(s);
  }
  return { accepted, rejected };
}

export function registerNarrate(app: Hono, ctx: AiContext): void {
  post<Body>(app, ctx, '/api/debrief/narrate', async (client, { record }) => {
    const timeline = record.timeline.slice(0, MAX_TIMELINE);
    const known = new Set([...timeline.map((t) => t.event), ...record.conflicts.flatMap((c) => c.events)]);
    const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: `Record:\n${JSON.stringify({ ...record, timeline })}` }];
    let meta = emptyMeta();
    let last: { accepted: Sentence[]; rejected: Rejected[] } = { accepted: [], rejected: [] };
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await callJson(client, { system: SYSTEM, messages, schema, maxTokens: 2000 });
      meta = addMeta(meta, out.meta);
      last = check((out.data as { sentences: Sentence[] }).sentences, known);
      if (!last.rejected.length) break;
      messages.push(
        { role: 'assistant', content: out.text },
        { role: 'user', content: `These sentences were rejected: ${JSON.stringify(last.rejected)}. Return the full narrative again using only facts supported by cited event ids in the record.` },
      );
    }
    return {
      body: {
        narrative: last.accepted.map((s) => s.text).join(' '),
        sentences: last.accepted,
        rejected: last.rejected,
        truncated: record.timeline.length > MAX_TIMELINE,
        meta,
      },
    };
  }, parseBody);
}
