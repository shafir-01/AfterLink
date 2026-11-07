import { describe, expect, it } from 'vitest';
import { generateScenario, type FamilyId } from '../src/scenario.ts';
import { runScenario, type RunOutput } from '../src/run.ts';

const real = (family: FamilyId, seed: number): Promise<RunOutput> => runScenario(generateScenario(family, seed), 'afterlink');

async function sum(family: FamilyId, seeds: number[], key: keyof RunOutput['metrics']): Promise<number> {
  let total = 0;
  for (const seed of seeds) total += (await real(family, seed)).metrics[key] as number;
  return total;
}

const SEEDS = [1, 2, 3, 4, 5, 6];

describe('AfterLink, real actors over the memory network', { timeout: 60_000 }, () => {
  it('finishes the connected workload as well as the baselines do', async () => {
    const s = generateScenario('connected', 1);
    const mine = await runScenario(s, 'afterlink');
    const central = await runScenario(s, 'central');
    expect(mine.metrics.tasksCompleted).toBeGreaterThanOrEqual(central.metrics.tasksCompleted - 1);
    expect(mine.metrics.converged).toBe(1);
    expect(mine.metrics.invariantViolations).toBe(0);
  });

  it('reproduces a run exactly from its seed, signatures and all', async () => {
    const a = await real('retry-storm', 7);
    const b = await real('retry-storm', 7);
    expect(a.trace).toEqual(b.trace);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('keeps deciding and finishing work after the hub dies', async () => {
    const { metrics } = await real('hub-death', 2);
    expect(metrics.decidedInWindow).toBe(1);
    expect(metrics.completedDuringOutage).toBeGreaterThan(5);
    expect(metrics.converged).toBe(1);
  });

  it('keeps working on both sides of a split with the hub dead, then converges', async () => {
    const { metrics, trace } = await real('hub-death-split', 4);
    const s = generateScenario('hub-death-split', 4);
    const window = s.windows[0]!;
    const workers = new Set(trace.filter((e) => e.kind === 'complete' && e.t > window.from + 60_000 && e.t < window.to).map((e) => e.actor));
    expect(workers.size).toBeGreaterThanOrEqual(2);
    expect(metrics.converged).toBe(1);
    expect(metrics.reconcileMs).not.toBeNull();
  });

  it('never double-books the one chair when both sides of a split want it', async () => {
    expect(await sum('exclusive-race', SEEDS, 'exclusiveDoubleBookings')).toBe(0);
    expect(await sum('exclusive-race', SEEDS, 'unsafeAllocationsRefused')).toBeGreaterThan(0);
  });

  it('never double-books when the link drops during a transfer', async () => {
    expect(await sum('transfer-disconnect', SEEDS, 'exclusiveDoubleBookings')).toBe(0);
    expect(await sum('transfer-disconnect', SEEDS, 'conservationBreaches')).toBe(0);
  });

  it('refuses irreversible work on stale knowledge', async () => {
    for (const seed of SEEDS) {
      const { metrics, trace } = await real('stale-observation', seed);
      expect(metrics.unsafeActions).toBe(0);
      expect(trace.some((e) => e.kind === 'refuse' && e.task === 'through-gate' && e.code === 'STALE_KNOWLEDGE')).toBe(true);
    }
  });

  it('recovers a restarted device with nothing lost or reissued', async () => {
    for (const seed of SEEDS) {
      const { metrics } = await real('restart-mid-partition', seed);
      expect(metrics.restartDefects).toBe(0);
      expect(metrics.converged).toBe(1);
    }
  });

  it('applies a ferried packet once, and the repeat changes nothing', async () => {
    const { metrics } = await real('ferry-twice', 6);
    expect(metrics.ferryNewFirst).toBeGreaterThan(0);
    expect(metrics.ferryNewSecond).toBe(0);
  });

  it('never starts work before its dependency is done', async () => {
    expect(await sum('incompatible-deps', SEEDS, 'dependencyViolations')).toBe(0);
  });

  it('rejects forged, tampered, outsider and replayed input, and surfaces an insider fork', async () => {
    const { attacks, metrics, violations } = await real('forged-replay', 3);
    const outcome = Object.fromEntries((attacks ?? []).map((a) => [a.attack, a.outcome]));
    expect(outcome['forged-signature']).toBe('rejected');
    expect(outcome['outsider-key']).toBe('rejected');
    expect(outcome['forged-packet']).toBe('rejected');
    expect(['rejected', 'no-effect']).toContain(outcome['replayed-events']);
    expect(outcome['replayed-packet']).toBe('no-effect');
    expect(outcome['insider-fork']).toBe('detected');
    expect(metrics.attacksAccepted).toBe(0);
    expect(violations).toContain('token-fork');
  });

  it('gives the same record when the whole history is replayed twice in random order', async () => {
    expect(await sum('membership-churn', SEEDS, 'replayDivergence')).toBe(0);
  });
});
