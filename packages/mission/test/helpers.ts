import { Author, EventLog, generateKeys } from '@afterlink/protocol';
import type { ActorId, DecisionRecord, MissionCapsule, Outcome, ProvisionBundle, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';
import { festivalCapsule, provision, reduce } from '../src/index.ts';

export interface Device {
  id: ActorId;
  team: TeamId;
  log: EventLog;
  author: Author;
  bundle: ProvisionBundle;
}

export function decision(actor: ActorId, taskId: TaskId, outcome: Outcome = 'ACCEPTED', extra: Partial<DecisionRecord> = {}): DecisionRecord {
  return { id: `${actor}:${taskId}:${outcome}`, actor, taskId, outcome, reason: 'Test decision.', policy: 'test', reachable: [], horizon: {}, inputs: [], ...extra };
}

export function spec(id: TaskId, extra: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    kind: 'water-run',
    title: `Task ${id}`,
    brief: 'Do the thing.',
    objective: 'safety',
    priority: 1,
    location: { x: 10, y: 10 },
    locationName: 'Somewhere',
    requires: ['haul'],
    needs: [],
    dependsOn: [],
    reversible: true,
    ...extra,
  };
}

export function world(customise?: (c: MissionCapsule) => MissionCapsule) {
  const issuer = generateKeys();
  const base = festivalCapsule(issuer, { now: 1_000 });
  const capsule = customise ? customise(base) : base;
  const { genesis, bundles } = provision(capsule, issuer, 'room');
  const roster = bundles.medics!.roster;
  const device = (team: TeamId): Device => {
    const bundle = bundles[team]!;
    const log = new EventLog(capsule.id);
    log.ingest(genesis);
    return { id: bundle.actor.publicKey, team, log, author: new Author(bundle.actor, log), bundle };
  };
  const devices = { medics: device('medics'), access: device('access'), facilities: device('facilities'), supply: device('supply') };
  return { issuer, capsule, genesis, bundles, roster, ...devices, all: Object.values(devices) };
}

/** Two-way anti-entropy between peers. */
export function sync(...peers: Device[]): void {
  for (const a of peers) for (const b of peers) if (a !== b) a.log.ingestMany(b.log.all());
}

export function stateOf(d: Device) {
  return reduce(d.log.all(), d.bundle.roster);
}

export function claim(d: Device, taskId: TaskId) {
  return d.author.emit('task.claimed', { taskId, decision: decision(d.id, taskId) }, 2_000);
}

export function cover(d: Device, taskId: TaskId) {
  return d.author.emit('task.covered', { taskId, decision: decision(d.id, taskId) }, 2_000);
}

export function accept(d: Device, taskId: TaskId) {
  return d.author.emit('task.accepted', { taskId, via: 'tap' }, 2_000);
}

export function complete(d: Device, taskId: TaskId, evidence = 'Done.') {
  return d.author.emit('task.completed', { taskId, evidence, via: 'tap' }, 2_000);
}

export function create(d: Device, s: TaskSpec) {
  return d.author.emit('task.created', { spec: s, source: { kind: 'human' } }, 2_000);
}
