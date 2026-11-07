import { festivalCapsule, provision } from '@afterlink/mission';
import { Author, EventLog, generateKeys } from '@afterlink/protocol';
import type { AnyEvent, DecisionRecord, EventBodies, EventId, EventType, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';
import type { RosterEntry } from '../src/index.ts';

const T0 = Date.UTC(2026, 10, 7, 14, 0, 0);

const spec = (id: TaskId, requires: string[], needs: TaskSpec['needs'], priority: 1 | 2 | 3 = 2): TaskSpec => ({
  id,
  kind: 'field',
  title: id,
  brief: id,
  objective: 'safety',
  priority,
  location: { x: 1, y: 1 },
  locationName: 'Field',
  requires,
  needs,
  dependsOn: [],
  reversible: true,
});

export interface Peer {
  team: TeamId;
  log: EventLog;
  author: Author;
  emit<T extends EventType>(type: T, body: EventBodies[T]): AnyEvent;
  decide(taskId: TaskId, over?: Partial<DecisionRecord>): DecisionRecord;
}

export interface Run {
  peers: Record<TeamId, Peer>;
  roster: RosterEntry[];
  hqSeen: EventId[];
  events: AnyEvent[];
  issuer: { publicKey: string; secretKey: string };
  sync(...teams: TeamId[]): void;
  emitted: Record<string, AnyEvent>;
}

/**
 * A complete mission under real keys: joined, split into two groups that keep working,
 * a contested task, a finished transfer, an unanswered transfer, then healed.
 */
export function buildRun(): Run {
  const issuer = generateKeys();
  const capsule = festivalCapsule(issuer, { now: T0 });
  const { genesis, bundles } = provision(capsule, issuer, 'room');
  let wall = T0;

  const peers: Record<TeamId, Peer> = {};
  for (const [team, bundle] of Object.entries(bundles)) {
    const log = new EventLog(capsule.id);
    log.ingest(genesis as unknown as AnyEvent);
    const author = new Author(bundle.actor, log);
    peers[team] = {
      team,
      log,
      author,
      emit: (type, body) => author.emit(type, body, (wall += 1000)) as unknown as AnyEvent,
      decide: (taskId, over = {}) => ({
        id: `${team}-${taskId}-${log.size}`,
        actor: bundle.actor.publicKey,
        taskId,
        outcome: 'ACCEPTED',
        reason: 'Closest capable team.',
        policy: 'nearest-capable',
        reachable: [],
        horizon: Object.fromEntries(Object.entries(log.summary().heads).map(([a, h]) => [a, h.seq])),
        inputs: [],
        ...over,
      }),
    };
  }
  const sync = (...teams: TeamId[]) => {
    for (let pass = 0; pass < 2; pass++) {
      for (const a of teams) for (const b of teams) if (a !== b) peers[a]!.log.ingestMany(peers[b]!.log.missingFor(peers[a]!.log.summary()));
    }
  };
  const all = Object.keys(peers);
  const roster = bundles.medics!.roster;
  const { medics, supply, access, facilities } = peers as Record<'medics' | 'supply' | 'access' | 'facilities', Peer>;
  const actorOf = (team: TeamId) => bundles[team]!.actor.publicKey;
  const emitted: Record<string, AnyEvent> = {};

  for (const team of all) {
    const b = bundles[team]!;
    peers[team]!.emit('actor.joined', { team, name: b.name, credential: b.credential });
  }
  sync(...all);

  medics.emit('task.claimed', { taskId: 'open-first-aid', decision: medics.decide('open-first-aid') });
  medics.emit('task.accepted', { taskId: 'open-first-aid', via: 'tap' });
  medics.emit('task.completed', { taskId: 'open-first-aid', evidence: 'Post open', via: 'tap' });
  medics.emit('task.created', { spec: spec('queue-water', ['haul'], [], 1), source: { kind: 'human' } });
  supply.log.ingestMany(medics.log.missingFor(supply.log.summary()));
  supply.emit('task.claimed', { taskId: 'queue-water', decision: supply.decide('queue-water') });
  sync(...all);
  const hqSeen = medics.log.all().map((e) => e.id);

  for (const a of ['medics', 'supply']) for (const b of ['access', 'facilities']) {
    peers[a]!.emit('link.changed', { peer: actorOf(b), state: 'severed', transport: 'memory' });
    peers[b]!.emit('link.changed', { peer: actorOf(a), state: 'severed', transport: 'memory' });
  }

  supply.emit('task.created', { spec: spec('field-aed', ['stock'], [{ resource: 'aed', count: 1 }]), source: { kind: 'human' } });
  emitted.commit = supply.emit('right.committed', { tokens: ['aed#2'], taskId: 'field-aed' });
  supply.emit('task.claimed', { taskId: 'field-aed', decision: supply.decide('field-aed') });
  supply.emit('task.accepted', { taskId: 'field-aed', via: 'tap' });
  emitted.done = supply.emit('task.completed', { taskId: 'field-aed', evidence: 'AED at the field', via: 'tap' });
  supply.emit('task.accepted', { taskId: 'queue-water', via: 'tap' });
  supply.emit('task.completed', { taskId: 'queue-water', evidence: 'Water delivered', via: 'tap' });

  emitted.offer = supply.emit('right.offered', { transfer: 'cart-to-medics', tokens: ['cart#1'], to: actorOf('medics') });
  sync('medics', 'supply');
  emitted.answer = medics.emit('right.accepted', { transfer: 'cart-to-medics' });
  medics.emit('task.refused', {
    taskId: 'clear-north-path',
    decision: medics.decide('clear-north-path', { outcome: 'REFUSED', refusal: 'NO_CAPABILITY', reason: 'Medics cannot repair.' }),
  });
  sync('medics', 'supply');

  access.emit('task.created', { spec: spec('hall-chair', ['mobility'], [{ resource: 'evac-chair', count: 1 }], 1), source: { kind: 'human' } });
  access.emit('right.committed', { tokens: ['evac-chair#1'], taskId: 'hall-chair' });
  access.emit('task.claimed', { taskId: 'hall-chair', decision: access.decide('hall-chair') });
  access.emit('task.accepted', { taskId: 'hall-chair', via: 'tap' });
  access.emit('task.completed', { taskId: 'hall-chair', evidence: 'Carried down', via: 'tap' });
  sync('access', 'facilities');
  facilities.emit('task.covered', { taskId: 'queue-water', decision: facilities.decide('queue-water', { reason: 'Owner out of reach.' }) });
  facilities.emit('task.accepted', { taskId: 'queue-water', via: 'tap' });
  facilities.emit('task.completed', { taskId: 'queue-water', evidence: 'Water delivered', via: 'tap' });
  facilities.emit('task.claimed', { taskId: 'connect-water', decision: facilities.decide('connect-water') });
  facilities.emit('task.accepted', { taskId: 'connect-water', via: 'tap' });
  facilities.emit('task.completed', { taskId: 'connect-water', evidence: 'Tap tested', via: 'tap' });
  facilities.emit('right.offered', { transfer: 'cart-to-access', tokens: ['cart#2'], to: actorOf('access') });
  sync('access', 'facilities');

  sync(...all);
  for (const a of ['medics', 'supply']) for (const b of ['access', 'facilities']) {
    peers[a]!.emit('link.changed', { peer: actorOf(b), state: 'open', transport: 'memory' });
    peers[b]!.emit('link.changed', { peer: actorOf(a), state: 'open', transport: 'memory' });
  }
  sync(...all);

  return { peers, roster, hqSeen, events: medics.log.all(), issuer, sync, emitted };
}

/** Deterministic shuffle, so a failure reproduces. */
export function shuffled<T>(items: T[], seed = 7): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
