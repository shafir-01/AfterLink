import { describe, expect, it } from 'vitest';
import { generateScenario } from '../src/scenario.ts';
import { runScenario } from '../src/run.ts';

describe('baselines are competent when nothing is wrong', () => {
  it('central finishes the connected workload with no double booking', async () => {
    const s = generateScenario('connected', 1);
    const { metrics } = await runScenario(s, 'central');
    expect(metrics.tasksCompleted).toBeGreaterThan(0.7 * metrics.tasksReported);
    expect(metrics.exclusiveDoubleBookings).toBe(0);
    expect(metrics.converged).toBe(1);
  });

  it('the board finishes the connected workload and converges', async () => {
    const s = generateScenario('connected', 1);
    const { metrics } = await runScenario(s, 'board');
    expect(metrics.tasksCompleted).toBeGreaterThan(0.7 * metrics.tasksReported);
    expect(metrics.converged).toBe(1);
  });
});

describe('baselines react to faults for the stated reasons', () => {
  it('central keeps its queued work going through hub death but decides nothing new', async () => {
    const s = generateScenario('hub-death', 2);
    const { metrics, trace } = await runScenario(s, 'central');
    const window = s.windows[0]!;
    expect(trace.some((e) => e.kind === 'assign' && e.t > window.from && e.t < window.to)).toBe(false);
    expect(metrics.firstDecisionMs).toBeNull();
    expect(metrics.converged).toBe(1);
  });

  it('central keeps working for the group that can reach the hub', async () => {
    const s = generateScenario('two-groups', 3);
    const { trace } = await runScenario(s, 'central');
    const window = s.windows[0]!;
    expect(trace.some((e) => e.kind === 'assign' && e.t > window.from + 10_000 && e.t < window.to)).toBe(true);
  });

  it('the board keeps deciding through a split', async () => {
    const s = generateScenario('hub-death-split', 4);
    const { metrics } = await runScenario(s, 'board');
    expect(metrics.firstDecisionMs).not.toBeNull();
    expect(metrics.completedDuringOutage).toBeGreaterThan(0);
    expect(metrics.converged).toBe(1);
  });

  it('the board double books the single chair when both sides ask for it', async () => {
    const s = generateScenario('exclusive-race', 5);
    const { metrics } = await runScenario(s, 'board');
    expect(metrics.exclusiveDoubleBookings).toBeGreaterThan(0);
  });

  it('central never double books under the race', async () => {
    const s = generateScenario('exclusive-race', 5);
    const { metrics } = await runScenario(s, 'central');
    expect(metrics.exclusiveDoubleBookings).toBe(0);
  });

  it('the board starts irreversible work on a fact that has become false', async () => {
    let unsafe = 0;
    for (let seed = 0; seed < 8; seed++) {
      const { metrics } = await runScenario(generateScenario('stale-observation', seed), 'board');
      unsafe += metrics.unsafeActions;
    }
    expect(unsafe).toBeGreaterThan(0);
  });

  it('a duplicated ferry import changes nothing on the board', async () => {
    const { metrics } = await runScenario(generateScenario('ferry-twice', 6), 'board');
    expect(metrics.ferryNewSecond).toBe(0);
  });
});

describe('determinism', () => {
  it('the same seed gives the same trace', async () => {
    const s = generateScenario('retry-storm', 7);
    const a = await runScenario(s, 'board');
    const b = await runScenario(s, 'board');
    expect(a.trace).toEqual(b.trace);
    expect(a.metrics).toEqual(b.metrics);
  });
});
