import { AfterLinkSystem } from './afterlink.ts';
import { BoardSystem } from './board.ts';
import { CentralSystem } from './central.ts';
import { hashSeed, Rng } from './rng.ts';
import { TIMING, generateScenario, type FamilyId, type Scenario } from './scenario.ts';
import { score, type RunMetrics } from './score.ts';
import { EPOCH, Sim, withVirtualRuntime } from './sim.ts';
import type { AttackResult, RunContext, SystemId, SystemUnderTest, TraceEntry } from './system.ts';

export interface RunRecord {
  family: FamilyId;
  seed: number;
  system: SystemId;
  metrics: RunMetrics;
  /** Outcome of each attack, when the family has any. */
  attacks?: AttackResult[];
  /** Violation kinds the system raised, when it raised any. */
  violations?: string[];
  /** Real milliseconds the run took. */
  wallMs: number;
}

export interface RunOutput extends RunRecord {
  trace: TraceEntry[];
}

/** How often convergence is checked after the heal. */
const PROBE_MS = 100;

/** Messages in flight at the horizon get this long to land before a run counts as not converged. */
const DRAIN_MS = 60_000;

const FACTORIES: Record<SystemId, (ctx: RunContext) => SystemUnderTest> = {
  central: (ctx) => new CentralSystem(ctx),
  board: (ctx) => new BoardSystem(ctx),
  afterlink: (ctx) => new AfterLinkSystem(ctx),
};

export async function runScenario(scenario: Scenario, systemId: SystemId): Promise<RunOutput> {
  const started = performance.now();
  const sim = new Sim();
  const rng = new Rng(hashSeed('system', scenario.family, scenario.seed, systemId));
  const trace: TraceEntry[] = [];
  const durations = new Map(scenario.incidents.map((i) => [i.spec.id, i.durationMs]));
  const ctx: RunContext = {
    scenario,
    sim,
    rng,
    trace: (entry) => trace.push(entry),
    durationOf: (task) => durations.get(task) ?? TIMING.minDurationMs,
  };

  const { metrics, attacks, violations } = await withVirtualRuntime({ sim, rng: rng.fork('runtime'), epoch: EPOCH }, async () => {
    const system = FACTORIES[systemId](ctx);
    await system.start();
    for (const incident of scenario.incidents) sim.at(incident.at, () => system.inject(incident));
    for (const step of scenario.faults) sim.at(step.at, () => system.apply(step));

    let reconcileMs: number | null = null;
    let bytesToReconcile: number | null = null;
    let observerBytesToReconcile: number | null = null;
    const { healAt } = scenario;
    if (healAt !== null) {
      let bytesAtHeal = 0;
      let observerAtHeal = 0;
      let probe = 0;
      sim.at(healAt, () => {
        bytesAtHeal = system.bytes();
        observerAtHeal = system.observerBytes();
        probe = sim.every(PROBE_MS, () => {
          if (!system.isConverged()) return;
          reconcileMs = sim.now - healAt;
          bytesToReconcile = system.bytes() - bytesAtHeal;
          observerBytesToReconcile = system.observerBytes() - observerAtHeal;
          sim.cancel(probe);
        }, 1);
      });
    }

    await sim.run(scenario.horizonMs);
    for (let waited = 0; waited < DRAIN_MS && !system.isConverged(); waited += 1_000) await sim.run(sim.now + 1_000);
    const report = await system.report();
    const bytesTotal = system.bytes();
    system.stop();
    return {
      metrics: score({ scenario, trace, report, reconcileMs, bytesToReconcile, observerBytesToReconcile, bytesTotal }),
      attacks: report.attacks,
      violations: report.violations,
    };
  });

  return {
    family: scenario.family,
    seed: scenario.seed,
    system: systemId,
    metrics,
    ...(attacks.length ? { attacks } : {}),
    ...(violations.length ? { violations } : {}),
    wallMs: Math.round(performance.now() - started),
    trace,
  };
}

/** Every system faces the identical scenario: same incidents, same durations, same fault schedule. */
export async function runSeed(family: FamilyId, seed: number, systems: SystemId[]): Promise<RunRecord[]> {
  const scenario = generateScenario(family, seed);
  const out: RunRecord[] = [];
  for (const system of systems) {
    const { trace: _trace, ...record } = await runScenario(scenario, system);
    out.push(record);
  }
  return out;
}
