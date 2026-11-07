import { BoardSystem } from './board.ts';
import { CentralSystem } from './central.ts';
import { hashSeed, Rng } from './rng.ts';
import { TIMING, generateScenario, type FamilyId, type Scenario } from './scenario.ts';
import { score, type RunMetrics } from './score.ts';
import { EPOCH, Sim, withVirtualRuntime } from './sim.ts';
import type { RunContext, SystemId, SystemUnderTest, TraceEntry } from './system.ts';

export interface RunRecord {
  family: FamilyId;
  seed: number;
  system: SystemId;
  metrics: RunMetrics;
  /** Real milliseconds the run took. */
  wallMs: number;
}

export interface RunOutput extends RunRecord {
  trace: TraceEntry[];
}

type Factory = (ctx: RunContext) => Promise<SystemUnderTest> | SystemUnderTest;

async function afterlink(ctx: RunContext): Promise<SystemUnderTest> {
  const { AfterLinkSystem } = await import('./afterlink.ts');
  return new AfterLinkSystem(ctx);
}

const FACTORIES: Record<SystemId, Factory> = {
  central: (ctx) => new CentralSystem(ctx),
  board: (ctx) => new BoardSystem(ctx),
  afterlink,
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

  const metrics = await withVirtualRuntime({ sim, rng: rng.fork('runtime'), epoch: EPOCH }, async () => {
    const system = await FACTORIES[systemId](ctx);
    await system.start();
    for (const incident of scenario.incidents) sim.at(incident.at, () => system.inject(incident));
    for (const step of scenario.faults) sim.at(step.at, () => system.apply(step));

    let reconcileMs: number | null = null;
    let bytesToReconcile: number | null = null;
    const { healAt } = scenario;
    if (healAt !== null) {
      let bytesAtHeal = 0;
      let probe = 0;
      sim.at(healAt, () => {
        bytesAtHeal = system.bytes();
        probe = sim.every(TIMING.tickMs / 4, () => {
          if (!system.isConverged()) return;
          reconcileMs = sim.now - healAt;
          bytesToReconcile = system.bytes() - bytesAtHeal;
          sim.cancel(probe);
        }, 1);
      });
    }

    await sim.run(scenario.horizonMs);
    const report = await system.report();
    const bytesTotal = system.bytes();
    system.stop();
    return score({ scenario, trace, report, reconcileMs, bytesToReconcile, bytesTotal });
  });

  return {
    family: scenario.family,
    seed: scenario.seed,
    system: systemId,
    metrics,
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
