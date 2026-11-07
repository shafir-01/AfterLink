import { describe, expect, it } from 'vitest';
import { createActor, createMemoryStorage, type ActorNode } from '@afterlink/actor';
import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { festivalCapsule, provision, scenarioBeats, scenarioSplit, type DemoBeat } from '@afterlink/mission';
import { generateKeys, type ActorId, type SyncSummary, type TaskId, type TeamId } from '@afterlink/protocol';
import { exportMission, tamperByte, verifyMission } from '../src/index.ts';

const STEP_MS = 100;
const beat = (id: string): DemoBeat => scenarioBeats.find((b) => b.id === id)!;

/** Four real actors over a real mesh: HQ killed, peers split, a ferry crossing, then restored. */
async function playMission(seed: number) {
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
        createActor({ bundle, connector: network.connector(id), signal: network.signal(id), storage: createMemoryStorage(), now: () => clock.now(), autopilot: true, autopilotDelayMs: 1500, tickMs: 500 }),
      ];
    }),
  );
  for (const node of nodes.values()) await node.start();

  const node = (team: TeamId) => nodes.get(team)!;
  const idOf = (team: TeamId): ActorId => bundles[team]!.actor.publicKey;
  const taskOf = (team: TeamId, id: TaskId) => node(team).view().state.tasks[id];
  const raise = (b: DemoBeat) => node(b.team).submitTask(b.spec!, { kind: 'human', ref: b.id });
  const until = async (what: string, done: () => boolean, maxMs = 30_000) => {
    for (let spent = 0; spent <= maxMs; spent += STEP_MS) {
      if (done()) return;
      clock.advance(STEP_MS);
      await new Promise((r) => setImmediate(r));
    }
    throw new Error(`Timed out waiting for: ${what}`);
  };

  await until('links', () => teams.every((t) => node(t).view().reachable.length === 3));
  const faint = beat('connected-faint');
  raise(faint);
  await until('first call', () => teams.every((t) => taskOf(t, faint.spec!.id)?.status === 'completed'));

  network.killHub();
  await until('HQ gone', () => teams.every((t) => !node(t).view().signalUp));
  const tent = beat('hq-down-quiet-tent');
  raise(tent);
  await until('tent', () => teams.every((t) => taskOf(t, tent.spec!.id)?.status === 'completed'));

  const water = beat('hq-down-queue-water');
  raise(water);
  await until('water claimed', () => teams.every((t) => taskOf(t, water.spec!.id)?.owner !== undefined));
  const contact: Record<TeamId, SyncSummary> = Object.fromEntries(teams.map((t) => [t, node(t).view().summary]));
  for (const t of scenarioSplit.a) node(t).setFaults({ blocked: scenarioSplit.b.map(idOf) });
  for (const t of scenarioSplit.b) node(t).setFaults({ blocked: scenarioSplit.a.map(idOf) });
  await until('split', () => teams.every((t) => node(t).view().reachable.length === 1));

  const aed = beat('split-field-aed');
  const ramp = beat('split-hall-ramp');
  raise(aed);
  raise(ramp);
  await until('both groups work', () => taskOf('supply', aed.spec!.id)?.status === 'completed' && taskOf('facilities', ramp.spec!.id)?.status === 'completed');

  const owner = taskOf('medics', water.spec!.id)!.owner!;
  const coverer = owner === idOf('supply') ? 'facilities' : 'supply';
  await until('cover', () => taskOf(coverer, water.spec!.id)?.coveredBy?.includes(idOf(coverer)) === true);

  const refused = beat('contested-upper-stand');
  const granted = beat('contested-hall-chair');
  raise(refused);
  raise(granted);
  await until('refusal', () => taskOf('medics', refused.spec!.id)?.decisions.some((d) => d.outcome === 'REFUSED') === true);
  await until('chair', () => node('access').view().state.tokens['evac-chair#1']?.committedTo === granted.spec!.id);
  await until('cover done', () => taskOf(coverer, water.spec!.id)?.status === 'completed');

  const ferry = beat('ferry-north-gate');
  const gate = ferry.observation!;
  node(ferry.team).observe(gate.key, gate.value, { subject: gate.subject });
  await until('news recorded', () => taskOf(ferry.team, 'west-gate-reroute') !== undefined);
  await until('news shared', () => taskOf('medics', 'west-gate-reroute') !== undefined);
  node('access').ingestFerry(node(ferry.team).buildFerry(contact.access));
  await until('reroute', () => taskOf('access', 'west-gate-reroute')?.status === 'completed');

  network.restoreHub();
  for (const t of teams) node(t).setFaults({ blocked: [] });
  await until('one history', () => {
    const heads = teams.map((t) => JSON.stringify(node(t).view().summary.heads));
    return teams.every((t) => node(t).view().reachable.length === 3) && new Set(heads).size === 1;
  }, 60_000);

  const hqSeen = [...new Set(teams.flatMap((t) => node(t).view().hqSeen))];
  for (const n of nodes.values()) n.stop();
  return { teams, roster, node, hqSeen };
}

describe('certificates from real actors', () => {
  it.each([1, 2, 3])('every replica exports a file that verifies to one fingerprint (seed %i)', async (seed) => {
    const { teams, roster, node, hqSeen } = await playMission(seed);
    const files = teams.map((t) => exportMission(node(t).events(), roster, { hqSeen }));
    const verdicts = files.map((f) => verifyMission(f));

    for (const v of verdicts) {
      expect(v.checks.filter((c) => c.status !== 'pass').map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
      expect(v.ok).toBe(true);
    }
    expect(new Set(files).size).toBe(1);
    expect(new Set(verdicts.map((v) => v.root)).size).toBe(1);
    expect(verdicts[0]!.words).toHaveLength(6);

    const { visibility } = verdicts[0]!;
    expect(visibility?.blind.map((b) => b.taskId)).toEqual(expect.arrayContaining(['field-aed', 'hall-ramp', 'hall-chair', 'west-gate-reroute']));
    expect(visibility?.blind.map((b) => b.taskId)).not.toContain('faint-main-stage');
    expect(verdicts[0]!.notes.join(' ')).toMatch(/both finished/);

    const flip = tamperByte(new TextEncoder().encode(files[0]!));
    const tampered = verifyMission(flip.bytes);
    expect(tampered.ok).toBe(false);
    expect(tampered.failure?.reason).toBeTruthy();
  }, 60_000);
});
