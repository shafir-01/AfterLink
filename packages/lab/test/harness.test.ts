import { describe, expect, it } from 'vitest';
import { FAMILIES, generateScenario, labWorld, type Scenario } from '../src/scenario.ts';
import { Rng, hashSeed } from '../src/rng.ts';
import { score } from '../src/score.ts';
import { Sim, withVirtualRuntime } from '../src/sim.ts';
import { summarize, wilson } from '../src/stats.ts';
import { emptyReport, type TraceEntry } from '../src/system.ts';

describe('Sim', () => {
  it('runs timers in time order, then insertion order', async () => {
    const sim = new Sim();
    const seen: string[] = [];
    sim.at(20, () => { seen.push('b'); });
    sim.at(10, () => { seen.push('a'); });
    sim.at(20, () => { seen.push('c'); });
    await sim.run(100);
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(sim.now).toBe(100);
  });

  it('repeats until cancelled, and a cancelled timer never fires', async () => {
    const sim = new Sim();
    let ticks = 0;
    const id = sim.every(10, () => {
      ticks++;
      if (ticks === 3) sim.cancel(id);
    });
    const dropped = sim.at(5, () => { throw new Error('should not fire'); });
    sim.cancel(dropped);
    await sim.run(100);
    expect(ticks).toBe(3);
  });

  it('drives timers, clocks and randomness inside a virtual runtime, and restores them after', async () => {
    const sim = new Sim();
    const realNow = Date.now;
    const realRandom = Math.random;
    const realTimeout = setTimeout;
    let fired = -1;
    await withVirtualRuntime({ sim, rng: new Rng(1), epoch: 1000 }, async () => {
      setTimeout(() => { fired = Date.now(); }, 250);
      expect(Date.now()).toBe(1000);
      await sim.run(300);
      const a = Math.random();
      expect(a).toBeGreaterThanOrEqual(0);
    });
    expect(fired).toBe(1250);
    expect(Date.now).toBe(realNow);
    expect(Math.random).toBe(realRandom);
    expect(setTimeout).toBe(realTimeout);
  });
});

describe('Rng', () => {
  it('is reproducible and forks independently', () => {
    const a = new Rng(hashSeed('x', 1));
    const b = new Rng(hashSeed('x', 1));
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(new Rng(5).fork('a').next()).not.toBe(new Rng(5).fork('b').next());
  });

  it('stays in range and keeps every item when shuffling', () => {
    const r = new Rng(9);
    for (let i = 0; i < 500; i++) {
      const n = r.int(3, 7);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(7);
    }
    expect(r.shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('stats', () => {
  it('computes the mean and a t interval', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.sd).toBeCloseTo(1.5811, 3);
    expect(s.ci95?.lo).toBeCloseTo(3 - (2.776 * 1.5811) / Math.sqrt(5), 2);
  });

  it('reports missing values instead of treating them as zero', () => {
    const s = summarize([null, 4, null, 6]);
    expect(s).toMatchObject({ n: 2, missing: 2, mean: 5 });
    expect(summarize([null]).mean).toBeNull();
  });

  it('gives a real upper bound when a count is zero in every run', () => {
    const s = summarize(new Array(200).fill(0));
    expect(s.nonZeroRuns).toBe(0);
    expect(s.nonZeroShare95?.lo).toBe(0);
    expect(s.nonZeroShare95?.hi).toBeCloseTo(0.0188, 3);
  });

  it('matches a known Wilson interval', () => {
    const w = wilson(50, 100);
    expect(w?.lo).toBeCloseTo(0.4038, 3);
    expect(w?.hi).toBeCloseTo(0.5962, 3);
  });
});

describe('scenarios', () => {
  it.each(FAMILIES)('%s is reproducible and well formed', (family) => {
    const a = generateScenario(family, 42);
    expect(generateScenario(family, 42)).toEqual(a);
    expect(generateScenario(family, 43)).not.toEqual(a);
    const ids = a.incidents.map((i) => i.spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of a.faults) {
      expect(f.at).toBeGreaterThanOrEqual(0);
      expect(f.at).toBeLessThanOrEqual(a.horizonMs);
    }
    for (const i of a.incidents) {
      expect(i.at).toBeLessThanOrEqual(a.horizonMs);
      expect(i.reporter).toBeGreaterThanOrEqual(0);
      expect(i.reporter).toBeLessThan(a.world.teams.length);
    }
    expect(a.windows.length).toBeGreaterThan(0);
  });

  it('every task can be done by some team', () => {
    for (const family of FAMILIES) {
      const s = generateScenario(family, 11);
      for (const i of s.incidents) {
        expect(s.world.teams.some((t) => i.spec.requires.every((r) => t.capabilities.includes(r)))).toBe(true);
      }
    }
  });
});

function scenarioWith(partial: Partial<Scenario>): Scenario {
  return {
    family: 'connected',
    seed: 1,
    world: labWorld({ chairs: 1 }),
    incidents: [],
    faults: [],
    windows: [{ from: 100, to: 200 }],
    cutAt: 100,
    healAt: 200,
    horizonMs: 300,
    truth: [],
    notes: [],
    ...partial,
  };
}

const spec = (id: string, extra: object = {}) => ({
  id, kind: 'k', title: id, brief: 'b', objective: 'o', priority: 2 as const, location: { x: 0, y: 0 }, locationName: 'z',
  requires: [], needs: [], dependsOn: [], reversible: true, ...extra,
});
const incident = (id: string, at: number, extra: object = {}) => ({ at, reporter: 0, spec: spec(id, extra), durationMs: 10 });

function scored(s: Scenario, trace: TraceEntry[], report = emptyReport()) {
  return score({ scenario: s, trace, report, reconcileMs: null, bytesToReconcile: null, observerBytesToReconcile: null, bytesTotal: 0 });
}

describe('score', () => {
  it('counts each task once, and only inside the window', () => {
    const s = scenarioWith({ incidents: [incident('a', 90, { priority: 1 }), incident('b', 90), incident('c', 90)] });
    const m = scored(s, [
      { t: 150, kind: 'complete', actor: 0, task: 'a' },
      { t: 160, kind: 'complete', actor: 1, task: 'a' },
      { t: 170, kind: 'complete', actor: 1, task: 'b' },
      { t: 250, kind: 'complete', actor: 1, task: 'c' },
    ]);
    expect(m.tasksCompleted).toBe(3);
    expect(m.completedDuringOutage).toBe(2);
    expect(m.p1CompletedDuringOutage).toBe(1);
    expect(m.duplicateEffortTasks).toBe(1);
  });

  it('measures the first decision from the cut and leaves it empty when there was none', () => {
    const s = scenarioWith({ incidents: [incident('a', 90)] });
    expect(scored(s, [{ t: 130, kind: 'assign', actor: 0, task: 'a', via: 'plan' }]).firstDecisionMs).toBe(30);
    const none = scored(s, [{ t: 50, kind: 'assign', actor: 0, task: 'a', via: 'plan' }]);
    expect(none.firstDecisionMs).toBeNull();
    expect(none.decidedInWindow).toBe(0);
  });

  it('counts a token committed to two tasks as a double-booking, unless a worker walked away', () => {
    const s = scenarioWith({ incidents: [incident('a', 90), incident('b', 90)] });
    const both: TraceEntry[] = [
      { t: 120, kind: 'commit', actor: 0, task: 'a', token: 'evac-chair#1' },
      { t: 121, kind: 'commit', actor: 2, task: 'b', token: 'evac-chair#1' },
    ];
    expect(scored(s, both).exclusiveDoubleBookings).toBe(1);
    expect(scored(s, [...both, { t: 122, kind: 'abandon', actor: 2, task: 'b' }]).exclusiveDoubleBookings).toBe(0);
  });

  it('flags irreversible work started on a fact that was false at the time', () => {
    const truth = [{ at: 0, key: 'g', value: true }, { at: 140, key: 'g', value: false }];
    const s = scenarioWith({ truth, incidents: [incident('a', 90, { reversible: false, reliesOn: ['g'] }), incident('b', 90, { reversible: true, reliesOn: ['g'] })] });
    expect(scored(s, [{ t: 130, kind: 'start', actor: 0, task: 'a' }]).unsafeActions).toBe(0);
    expect(scored(s, [{ t: 150, kind: 'start', actor: 0, task: 'a' }]).unsafeActions).toBe(1);
    expect(scored(s, [{ t: 150, kind: 'start', actor: 0, task: 'b' }]).unsafeActions).toBe(0);
  });

  it('flags work started before its dependency finished', () => {
    const s = scenarioWith({ incidents: [incident('p', 90), incident('c', 90, { dependsOn: ['p'] })] });
    const trace: TraceEntry[] = [
      { t: 110, kind: 'start', actor: 0, task: 'c' },
      { t: 150, kind: 'complete', actor: 1, task: 'p' },
    ];
    expect(scored(s, trace).dependencyViolations).toBe(1);
  });

  it('confirms a refusal only when truth shows the alternative was unsafe', () => {
    const s = scenarioWith({ incidents: [incident('a', 90, { needs: [{ resource: 'evac-chair', count: 1 }] }), incident('b', 90, { needs: [{ resource: 'evac-chair', count: 1 }] })] });
    const refuse: TraceEntry = { t: 120, kind: 'refuse', actor: 2, task: 'b', code: 'NO_RIGHT' };
    const counted = scored(s, [refuse]);
    expect(counted.unsafeAllocationsRefused).toBe(1);
    expect(counted.refusalsConfirmedByTruth).toBe(0);
    const confirmed = scored(s, [refuse, { t: 121, kind: 'commit', actor: 0, task: 'a', token: 'evac-chair#1' }]);
    expect(confirmed.refusalsConfirmedByTruth).toBe(1);
  });

  it('adds every violation class to the total and keeps absent checks out of it', () => {
    const s = scenarioWith({});
    const report = { ...emptyReport(), lostCompletions: 2, conservationBreaches: 1, unauthorisedCommits: 1, replayDivergence: 1, attacks: [{ attack: 'x', outcome: 'accepted' as const }] };
    expect(scored(s, [], report).invariantViolations).toBe(6);
    expect(scored(s, [], emptyReport()).invariantViolations).toBe(0);
  });
});
