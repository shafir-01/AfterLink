import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Fleet, TEAMS } from './fleet.ts';

const root = resolve(__dirname, '../..');
const DECISION_PATH = ['protocol', 'authority', 'mission', 'planner', 'reconcile', 'actor', 'ferry'];
const FORBIDDEN = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bEventSource\b/, /new\s+WebSocket\b/, /@afterlink\/relay/, /anthropic/i, /elevenlabs/i, /\bn8n\b/i, /api\.claude/i];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

let fleet: Fleet;
let network: ReturnType<typeof vi.fn>;

beforeEach(() => {
  network = vi.fn(() => {
    throw new Error('no network');
  });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('WebSocket', network);
  vi.stubGlobal('XMLHttpRequest', network);
});
afterEach(() => {
  fleet?.stop();
  vi.unstubAllGlobals();
});

const done = (f: Fleet, id: string) => f.state().tasks[id]?.status === 'completed';

describe('no decision needs a central service', () => {
  it('decision packages contain no network call and no reference to an external service', () => {
    for (const pkg of DECISION_PATH) {
      for (const file of sources(join(root, 'packages', pkg, 'src'))) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN) expect(`${file}: ${pattern.test(text)}`).toBe(`${file}: false`);
      }
    }
  });

  it('with the hub dead, a new task is assigned and completed and a token is committed', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.net.killHub();
    expect(fleet.net.hubUp).toBe(false);
    await fleet.run(1000);
    fleet.node('medics').submitTask(fleet.task('after-kill', { requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }), { kind: 'human' });
    await fleet.run(10000);
    expect(done(fleet, 'after-kill')).toBe(true);
    const seen = TEAMS.map((t) => fleet.node(t).view().state.tasks['after-kill']?.status);
    expect(new Set(seen)).toEqual(new Set(['completed']));
    expect(network).not.toHaveBeenCalled();
  });

  it('with the hub dead, peers still exchange events over links that were already open', async () => {
    fleet = await Fleet.start();
    const open = fleet.net.paths().length;
    expect(open).toBe(6);
    fleet.net.killHub();
    await fleet.run(5000);
    expect(fleet.net.paths().length).toBe(open);
    fleet.node('supply').observe('stock.low', true);
    await fleet.run(1000);
    expect(fleet.node('medics').view().state.observations['stock.low']?.length).toBe(1);
  });

  it('the hub being up or dead changes no decision', async () => {
    const outcome = async (kill: boolean) => {
      const f = await Fleet.start({ autopilot: true });
      if (kill) f.net.killHub();
      await f.run(1000);
      f.node('medics').submitTask(f.task('same', { requires: ['first-aid'] }), { kind: 'human' });
      await f.run(15000);
      const st = f.state();
      f.stop();
      return Object.fromEntries(Object.values(st.tasks).map((t) => [t.spec.id, t.status]));
    };
    expect(await outcome(true)).toEqual(await outcome(false));
  });

  it('a device cut off from every peer and the hub still decides alone', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.net.killHub();
    fleet.split(['medics'], ['access', 'facilities', 'supply']);
    await fleet.run(1000);
    fleet.node('medics').submitTask(fleet.task('alone', { requires: ['first-aid'] }), { kind: 'human' });
    await fleet.run(10000);
    expect(fleet.node('medics').view().state.tasks['alone']?.status).toBe('completed');
  });

  it('a device that never met a peer says why it is waiting', async () => {
    fleet = await Fleet.start({ signal: false });
    expect(fleet.net.paths().length).toBe(0);
    const view = fleet.node('medics').view() as unknown as { phase: string; phaseReason: string | null };
    expect(view.phase).toBe('recovering');
    expect(view.phaseReason).toBeTruthy();
  });

  it('killing the observer does not lose what the mission did: restored HQ is told the interval', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.net.killHub();
    await fleet.run(1000);
    fleet.node('medics').submitTask(fleet.task('blind', { requires: ['first-aid'] }), { kind: 'human' });
    await fleet.run(10000);
    fleet.net.restoreHub();
    await fleet.run(10000);
    const seen = new Set(fleet.net.hubState()!.seen);
    const done = fleet.union().find((e) => e.type === 'task.completed' && e.body.taskId === 'blind')!;
    expect(seen.has(done.id)).toBe(true);
    const late = TEAMS.flatMap((t) => fleet.node(t).view().hqBackfilled);
    expect(late).toContain(done.id);
    const live = TEAMS.flatMap((t) => fleet.node(t).view().hqSeen);
    expect(live).not.toContain(done.id);
  });
});
