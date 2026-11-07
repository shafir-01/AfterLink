import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { TaskSpec } from '@afterlink/protocol';
import { callJson, post, str } from './claude.js';
import type { AiContext } from './types.js';

const strings = { type: 'array', items: { type: 'string' } };
const schema = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'title', 'brief', 'objective', 'priority', 'location', 'locationName', 'requires', 'needs', 'reversible', 'source', 'unknowns'],
  properties: {
    kind: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' },
    objective: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    priority: { type: 'integer', enum: [1, 2, 3] },
    location: { anyOf: [{ type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } }, { type: 'null' }] },
    locationName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    requires: strings,
    needs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['resource', 'count'], properties: { resource: { type: 'string' }, count: { type: 'integer' } } } },
    reversible: { type: 'boolean' },
    source: { type: 'string' },
    unknowns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['field', 'note'], properties: { field: { type: 'string' }, note: { type: 'string' } } } },
  },
};

const SYSTEM = `You convert a free-text incident report from a university festival into one structured task draft for volunteer teams.

Rules:
- Use only facts in the report. Never invent a location, count, name or resource.
- Anything you cannot determine from the report becomes null or a safe default, and must be listed in "unknowns" with the field name and a short note on what to ask.
- "source" is a short verbatim quote from the report that the task is based on.
- Use only capability and resource ids from the provided context lists. If the report implies one that is not listed, leave it out and add it to unknowns.
- Use only objective ids from the context. If none fits, set objective to null.
- Priority 1 means life or safety at risk now, 2 means soon, 3 means routine. If unclear, choose 2 and list priority in unknowns.
- "brief" is one short spoken instruction for the field. Plain wording.`;

interface Ctx { objectives: { id: string; title: string }[]; resources: string[]; capabilities: string[] }
interface Body { text: string; context: Ctx }

const DEFAULT_CAPABILITIES = ['first-aid', 'mobility', 'repair', 'haul'];

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str).slice(0, 50) : []);

function parseBody(raw: unknown): Body | string {
  const r = raw as { text?: unknown; context?: Partial<Ctx> } | undefined;
  if (!r || !str(r.text)) return 'text is required';
  if (r.text.length > 4000) return 'text is too long';
  const c = r.context ?? {};
  const objectives = Array.isArray(c.objectives) ? c.objectives.flatMap((o) => (str(o?.id) && str(o?.title) ? [{ id: o.id, title: o.title }] : [])).slice(0, 20) : [];
  const capabilities = strList(c.capabilities);
  return { text: r.text, context: { objectives, resources: strList(c.resources), capabilities: capabilities.length ? capabilities : DEFAULT_CAPABILITIES } };
}

export type TaskDraft = Omit<TaskSpec, 'location' | 'locationName' | 'objective'> & {
  location: TaskSpec['location'] | null;
  locationName: string | null;
  objective: string | null;
};

export function registerTriage(app: Hono, ctx: AiContext): void {
  post<Body>(app, ctx, '/api/triage', async (client, body) => {
    const prompt = `Context:\n${JSON.stringify(body.context)}\n\nIncident report:\n${body.text}`;
    const out = await callJson(client, { system: SYSTEM, messages: [{ role: 'user', content: prompt }], schema, maxTokens: 2000 });
    const d = out.data as Record<string, unknown> & {
      requires: string[]; needs: { resource: string; count: number }[]; objective: string | null;
      unknowns: { field: string; note: string }[]; source: string;
    };
    const unknowns = [...d.unknowns];
    const caps = new Set(body.context.capabilities);
    const res = new Set(body.context.resources);
    const objs = new Set(body.context.objectives.map((o) => o.id));
    const requires = d.requires.filter((c) => caps.has(c));
    if (requires.length < d.requires.length) unknowns.push({ field: 'requires', note: 'A capability not defined for this mission was dropped' });
    const needs = d.needs.filter((n) => res.has(n.resource));
    if (needs.length < d.needs.length) unknowns.push({ field: 'needs', note: 'A resource not defined for this mission was dropped' });
    const objective = d.objective && objs.has(d.objective) ? d.objective : null;
    if (d.objective && !objective) unknowns.push({ field: 'objective', note: 'The objective is not defined for this mission' });
    const { source, unknowns: _ignored, ...rest } = d;
    const spec = { ...rest, id: `triage-${randomUUID().slice(0, 8)}`, requires, needs, objective, dependsOn: [] } as unknown as TaskDraft;
    const { kind, priority, reversible } = spec;
    return { body: { kind, priority, requires, needs, reversible, spec, source, unknowns, meta: out.meta } };
  }, parseBody);
}
