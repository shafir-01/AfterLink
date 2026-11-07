import { describe, expect, it } from 'vitest';
import { createActor, createMemoryStorage, type ActorNode } from '@afterlink/actor';
import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { generateKeys } from '@afterlink/protocol';
import type { ActorId, MissionState, SyncSummary, TaskId, TeamId } from '@afterlink/protocol';
import { festivalCapsule, provision, reduce, scenarioBeats, scenarioSplit, type DemoBeat } from '../src/index.ts';

const STEP_MS = 100;
const beat = (id: string): DemoBeat => scenarioBeats.find((b) => b.id === id)!;

/** Four real actors over a real mesh in virtual time, driven the way the stage drives them. */
async function stage(seed: number) {
  const clock = new VirtualClock(1_000_000);
  const network = new MemoryNetwork({ seed, clock, latencyMs: 5, signalLatencyMs: 5 });
  const issuer = generateKeys();
  const capsule = festivalCapsule(issuer, { now: clock.now() });
  const { bundles } = provision(capsule, issuer, 'live');
  const teams = capsule.teams.map((t) => t.id);
  const roster = bundles[teams[0]!]!.roster;
  const nodes = new Map<TeamId, ActorNode>(
    teams.map((team) => {
      const bundle = bundles[team]!;
      const id = bundle.actor.publicKey;
      return [
        team,
        createActor({
          bundle,
          connector: network.connector(id),
          signal: network.signal(id),
          storage: createMemoryStorage(),
          now: () => clock.now(),
          autopilot: true,
          autopilotDelayMs: 1500,
          tickMs: 500,
        }),
      ];
    }),
  );
  for (const node of nodes.values()) await node.start();

  const node = (team: TeamId) => nodes.get(team)!;
  const idOf = (team: TeamId): ActorId => bundles[team]!.actor.publicKey;
  const stateOf = (team: TeamId): MissionState => node(team).view().state;
  const taskOf = (team: TeamId, id: TaskId) => stateOf(team).tasks[id];

  async function until(what: string, done: () => boolean, maxMs = 30_000): Promise<void> {
    for (let spent = 0; spent <= maxMs; spent += STEP_MS) {
      if (done()) return;
      clock.advance(STEP_MS);
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  }

  const raise = (b: DemoBeat) => node(b.team).submitTask(b.spec!, { kind: 'human', ref: b.id });

  return { clock, network, capsule, teams, roster, node, idOf, stateOf, taskOf, until, raise };
}

async function playAllBeats(seed: number) {
  const s = await stage(seed);
  const { until, raise, node, idOf, taskOf, stateOf, teams, network } = s;
  const a = scenarioSplit.a;
  const b = scenarioSplit.b;
  const seen: string[] = [];

  await until('all links open', () => teams.every((t) => node(t).view().reachable.length === 3));

  // Connected.
  const faint = beat('connected-faint');
  raise(faint);
  await until('Medics finish the first call', () => teams.every((t) => taskOf(t, faint.spec!.id)?.status === 'completed'));
  expect(taskOf('access', faint.spec!.id)?.owner).toBe(idOf('medics'));
  seen.push('connected');

  // Central service gone: the peers carry on alone.
  network.killHub();
  await until('devices notice HQ is gone', () => teams.every((t) => !node(t).view().signalUp));
  const tent = beat('hq-down-quiet-tent');
  raise(tent);
  await until('a peer finishes the request', () => teams.every((t) => taskOf(t, tent.spec!.id)?.status === 'completed'));
  expect(taskOf('supply', tent.spec!.id)?.owner).toBe(idOf('access'));
  seen.push('hq-down');

  // Split the moment the held task is claimed, as the stage does.
  const water = beat('hq-down-queue-water');
  raise(water);
  await until('the water run is claimed everywhere', () => teams.every((t) => taskOf(t, water.spec!.id)?.owner !== undefined));
  const waterOwner = taskOf('medics', water.spec!.id)!.owner!;
  expect([idOf('supply'), idOf('facilities')]).toContain(waterOwner);
  const contact: Record<TeamId, SyncSummary> = Object.fromEntries(teams.map((t) => [t, node(t).view().summary]));
  for (const t of a) node(t).setFaults({ blocked: b.map(idOf) });
  for (const t of b) node(t).setFaults({ blocked: a.map(idOf) });
  await until('the links drop', () => teams.every((t) => node(t).view().reachable.length === 1));

  // Each group handles different work.
  const aed = beat('split-field-aed');
  const ramp = beat('split-hall-ramp');
  raise(aed);
  raise(ramp);
  await until('both groups finish their own work', () => taskOf('supply', aed.spec!.id)?.status === 'completed' && taskOf('facilities', ramp.spec!.id)?.status === 'completed');
  expect(taskOf('medics', aed.spec!.id)?.owner).toBe(idOf('supply'));
  expect(taskOf('access', ramp.spec!.id)?.owner).toBe(idOf('facilities'));
  expect(taskOf('access', aed.spec!.id)).toBeUndefined();
  expect(taskOf('medics', ramp.spec!.id)).toBeUndefined();
  seen.push('split');

  // The far group covers the water run while its owner finishes it anyway.
  const coverer = waterOwner === idOf('supply') ? 'facilities' : 'supply';
  await until('the far group covers the water run', () => taskOf(coverer, water.spec!.id)?.coveredBy?.includes(idOf(coverer)) === true);

  // Refused without the chair, allocated with it.
  const refused = beat('contested-upper-stand');
  const granted = beat('contested-hall-chair');
  raise(refused);
  raise(granted);
  await until('the chair request is refused', () => taskOf('medics', refused.spec!.id)?.decisions.some((d) => d.outcome === 'REFUSED') === true);
  const refusal = taskOf('medics', refused.spec!.id)!.decisions.find((d) => d.outcome === 'REFUSED')!;
  expect(refusal.refusal).toBe('NO_RIGHT');
  expect(refusal.next?.length).toBeGreaterThan(0);
  expect(refusal.reason.length).toBeGreaterThan(0);
  await until('the chair is committed', () => stateOf('access').tokens['evac-chair#1']?.committedTo === granted.spec!.id);
  expect(stateOf('medics').tokens['evac-chair#1']?.state).toBe('held');
  seen.push('contested');

  // The far group must finish before the news arrives, or the ferry tells it the job is done.
  await until('the far group finishes the water run', () => taskOf(coverer, water.spec!.id)?.status === 'completed');

  // The gate news crosses the gap by hand and gives the far group work.
  const ferry = beat('ferry-north-gate');
  const gate = ferry.observation!;
  node(ferry.team).observe(gate.key, gate.value, { subject: gate.subject });
  await until('the sender records the news', () => stateOf(ferry.team).tasks['west-gate-reroute'] !== undefined);
  await until('the sender is settled', () => stateOf('medics').tasks['west-gate-reroute'] !== undefined);
  expect(stateOf('access').tasks['west-gate-reroute']).toBeUndefined();
  expect(taskOf('supply', 'west-gate-reroute')?.owner).toBeUndefined();
  const packet = node(ferry.team).buildFerry(contact.access);
  const result = node('access').ingestFerry(packet);
  expect(result.newEvents).toBeGreaterThan(0);
  await until('Access finishes the reroute', () => taskOf('access', 'west-gate-reroute')?.status === 'completed');
  expect(taskOf('access', 'west-gate-reroute')?.owner).toBe(idOf('access'));
  seen.push('ferry');

  // Restore links and signalling, then wait for one history.
  network.restoreHub();
  for (const t of teams) node(t).setFaults({ blocked: [] });
  await until('every replica holds the same events', () => {
    const heads = teams.map((t) => JSON.stringify(node(t).view().summary.heads));
    return teams.every((t) => node(t).view().reachable.length === 3) && new Set(heads).size === 1;
  }, 60_000);
  seen.push('restored');

  return { ...s, seen, waterId: water.spec!.id, waterOwner, coverer };
}

describe('the beats on real actors', () => {
  it.each([1, 2, 3, 4])('produce the whole story in order (seed %i)', async (seed) => {
    const { seen, teams, stateOf, node, roster, waterId, waterOwner, coverer, idOf } = await playAllBeats(seed);
    expect(seen).toEqual(['connected', 'hq-down', 'split', 'contested', 'ferry', 'restored']);

    const states = teams.map(stateOf);
    const final = states[0]!;
    for (const s of states) expect(s).toEqual(final);
    expect(reduce(node('medics').events(), roster)).toEqual(final);

    const duplicates = final.conflicts.filter((c) => c.kind === 'duplicate-effort');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toMatchObject({ severity: 'policy', taskId: waterId });
    expect(duplicates[0]!.events).toHaveLength(2);
    expect(final.conflicts.filter((c) => c.severity === 'violation')).toEqual([]);
    expect(final.conflicts).toHaveLength(1);

    expect(final.tasks[waterId]).toMatchObject({ status: 'completed', owner: waterOwner, coveredBy: [idOf(coverer)] });
    expect(final.tokens['evac-chair#1']).toMatchObject({ state: 'committed', committedTo: 'hall-chair', holder: idOf('access') });
    expect(final.tasks['west-gate-reroute']?.status).toBe('completed');
  });
});
