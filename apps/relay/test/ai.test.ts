import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const create = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error { status = 500; }
  class Anthropic {
    static APIError = APIError;
    messages = { create };
  }
  return { default: Anthropic };
});

const validate = vi.hoisted(() => vi.fn());
vi.mock('@afterlink/mission', () => ({ validateCapsule: validate }));

import { register } from '../src/ai/index.js';

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 };
const reply = (obj: unknown) => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: JSON.stringify(obj) }] });

function build(take: () => unknown = () => true) {
  const app = new Hono();
  const taken: string[] = [];
  register(app, { limits: { take: (n: string) => (taken.push(n), take()) } });
  const call = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, taken };
}

const objective = 'Medics and Access run the day. We have 2 evacuation chairs, both held by Access.';
const draft = (basis = '2 evacuation chairs') => ({
  name: 'Day', objective, objectives: [{ id: 'o1', title: 'Safe day', rank: 1 }],
  teams: [{ id: 'access', name: 'Access', capabilities: ['mobility'], home: { x: 1, y: 1 } }],
  resources: [{ id: 'chair', name: 'Evacuation chair', basis, tokens: [{ id: 'chair#1', holderTeam: 'access' }, { id: 'chair#2', holderTeam: 'access' }] }],
  tasks: [{ id: 't1', kind: 'move', title: 'Move', brief: 'Go', objective: 'o1', priority: 1, location: { x: 1, y: 1 }, locationName: 'Gate', requires: [], needs: [{ resource: 'chair', count: 1 }], dependsOn: [], reversible: true }],
  contingencies: [], fallback: { coverAfterMs: 1000, coverMaxPriority: 1, humanApprovalKinds: [] },
});

beforeEach(() => {
  create.mockReset();
  validate.mockReset();
  validate.mockImplementation((c) => ({ ok: true, capsule: c }));
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('availability and limits', () => {
  it('returns 503 live:false without a key and never calls the model', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { call, taken } = build();
    const res = await call('/api/triage', { text: 'x' });
    expect(res.status).toBe(503);
    expect((await res.json()).live).toBe(false);
    expect(taken).toEqual(['claude']);
    expect(create).not.toHaveBeenCalled();
  });

  it('takes the claude limit first and returns 429 when refused', async () => {
    const { call } = build(() => ({ ok: false }));
    expect((await call('/api/triage', { text: 'x' })).status).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('compile', () => {
  it('returns a draft with model, latency, usage and rights needing approval', async () => {
    create.mockResolvedValueOnce(reply({ questions: [], capsule: draft() }));
    const res = await build().call('/api/mission/compile', { objective, issuer: 'issuer-key' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('draft');
    expect(body.approvalRequired).toBe(true);
    expect(body.rights[0]).toMatchObject({ resource: 'chair', tokens: 2 });
    expect(body.meta).toMatchObject({ model: 'claude-sonnet-5-5', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10 } });
    expect(typeof body.meta.latencyMs).toBe('number');
    const arg = create.mock.calls[0][0];
    expect(arg.model).toBe('claude-sonnet-5-5');
    expect(arg.max_tokens).toBeLessThanOrEqual(16000);
    expect(arg.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('strips rights the organiser did not describe', async () => {
    create.mockResolvedValueOnce(reply({ questions: [], capsule: draft('5 defibrillators') }));
    const body = await (await build().call('/api/mission/compile', { objective, issuer: 'issuer-key' })).json();
    expect(body.rights).toEqual([]);
    expect(body.rejectedRights).toEqual(['chair']);
    expect(body.approvalRequired).toBe(false);
    const passed = validate.mock.calls[0][0];
    expect(passed.resources).toEqual([]);
    expect(passed.tasks[0].needs).toEqual([]);
  });

  it('returns clarifying questions', async () => {
    create.mockResolvedValueOnce(reply({ questions: ['Which team holds the AED?'], capsule: null }));
    const body = await (await build().call('/api/mission/compile', { objective, issuer: 'issuer-key' })).json();
    expect(body).toMatchObject({ status: 'questions', questions: ['Which team holds the AED?'] });
    expect(validate).not.toHaveBeenCalled();
  });

  it('retries once with the errors, then succeeds', async () => {
    validate.mockReturnValueOnce({ ok: false, errors: ['tasks[0].objective unknown'] });
    create.mockResolvedValueOnce(reply({ questions: [], capsule: draft() })).mockResolvedValueOnce(reply({ questions: [], capsule: draft() }));
    const body = await (await build().call('/api/mission/compile', { objective, issuer: 'issuer-key' })).json();
    expect(body.status).toBe('draft');
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[1][0].messages)).toContain('tasks[0].objective unknown');
    expect(body.meta.usage.inputTokens).toBe(200);
  });

  it('returns the errors after a second invalid draft', async () => {
    validate.mockReturnValue({ ok: false, errors: ['bad'] });
    create.mockResolvedValue(reply({ questions: [], capsule: draft() }));
    const res = await build().call('/api/mission/compile', { objective, issuer: 'issuer-key' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ status: 'invalid', errors: ['bad'] });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty objective', async () => {
    expect((await build().call('/api/mission/compile', { objective: '  ' })).status).toBe(400);
  });
});

describe('triage', () => {
  it('returns a typed draft and flags what is unknown', async () => {
    create.mockResolvedValueOnce(reply({
      kind: 'medical', title: 'Fainting', brief: 'Go to the gate', objective: 'o1', priority: 1, location: null, locationName: null,
      requires: ['first-aid', 'telepathy'], needs: [{ resource: 'aed', count: 1 }, { resource: 'jetpack', count: 1 }], reversible: false,
      source: 'someone fainted', unknowns: [{ field: 'location', note: 'Ask where' }],
    }));
    const body = await (await build().call('/api/triage', { text: 'someone fainted', context: { objectives: [{ id: 'o1', title: 'x' }], resources: ['aed'], capabilities: ['first-aid'] } })).json();
    expect(body.spec.requires).toEqual(['first-aid']);
    expect(body.spec.needs).toEqual([{ resource: 'aed', count: 1 }]);
    expect(body.spec.location).toBeNull();
    expect(body.unknowns.map((u: { field: string }) => u.field)).toEqual(['location', 'requires', 'needs']);
    expect(body.meta.model).toBe('claude-sonnet-5-5');
  });
});

describe('narrate', () => {
  const record = {
    mission: 'm', events: 2, actors: 2, episodes: [], doneWhileHqBlind: 1, refusedUnsafe: 0, duplicatesPrevented: 0, conflicts: [], conservation: [], unknowns: [],
    timeline: [
      { at: 1, lamport: 1, actor: 'a', team: 'x', event: 'e1', type: 'task.claimed', label: 'Claimed', hiddenFromHq: false },
      { at: 2, lamport: 2, actor: 'a', team: 'x', event: 'e2', type: 'task.completed', label: 'Done', hiddenFromHq: true },
    ],
  };

  it('keeps cited sentences and rejects claims not in the record', async () => {
    const sentences = [{ text: 'A task was claimed.', cites: ['e1'] }, { text: 'A drone helped.', cites: ['e99'] }, { text: 'It went well.', cites: [] }];
    create.mockResolvedValueOnce(reply({ sentences })).mockResolvedValueOnce(reply({ sentences }));
    const body = await (await build().call('/api/debrief/narrate', { record })).json();
    expect(body.narrative).toBe('A task was claimed.');
    expect(body.rejected.map((r: { text: string }) => r.text)).toEqual(['A drone helped.', 'It went well.']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry when every sentence is grounded', async () => {
    create.mockResolvedValueOnce(reply({ sentences: [{ text: 'Work finished while HQ was blind.', cites: ['e2'] }] }));
    const body = await (await build().call('/api/debrief/narrate', { record })).json();
    expect(body.rejected).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
