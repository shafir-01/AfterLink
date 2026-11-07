import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActor, createMemoryStorage, type ActorNode } from '@afterlink/actor';
import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { festivalCapsule, provision, scenarioBeats, scenarioSplit } from '@afterlink/mission';
import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, MissionState, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';

const START = 1_800_000_000_000;
const TEAMS = ['medics', 'access', 'facilities', 'supply'];

function beat(taskId: TaskId): TaskSpec {
  return scenarioBeats.find((b) => b.spec?.id === taskId)!.spec!;
}

/** Four real actors over real links in virtual time, each planning only from its own view. */
class Fleet {
  readonly clock = new VirtualClock(START);
  readonly actors: Record<TeamId, ActorNode> = {};
  readonly coverAfterMs: number;

  constructor() {
    const net = new MemoryNetwork({ seed: 11, clock: this.clock });
    const issuer = generateKeys();
    const capsule = { ...festivalCapsule(issuer, { now: START }), tasks: [] };
    this.coverAfterMs = capsule.fallback.coverAfterMs;
    const { bundles } = provision(capsule, issuer, 'room');
    for (const team of TEAMS) {
      const bundle = bundles[team]!;
      const id = bundle.actor.publicKey;
      this.actors[team] = createActor({
        bundle,
        connector: net.connector(id),
        signal: net.signal(id),
        storage: createMemoryStorage(),
        autopilot: false,
        tickMs: 100,
      });
    }
  }

  async connect(): Promise<void> {
    for (const team of TEAMS) await this.actors[team]!.start();
    this.until(() => TEAMS.every((t) => this.actors[t]!.view().reachable.length === 3), 'links open');
  }

  until(done: () => boolean, what: string, limitMs = 60_000): void {
    for (let spent = 0; spent <= limitMs; spent += 50) {
      if (done()) return;
      this.clock.advance(50);
    }
    throw new Error(`gave up waiting for: ${what}`);
  }

  id(team: TeamId): ActorId {
    return this.actors[team]!.id;
  }

  split(): void {
    const { a, b } = scenarioSplit;
    for (const t of a) this.actors[t]!.setFaults({ blocked: b.map((x) => this.id(x)) });
    for (const t of b) this.actors[t]!.setFaults({ blocked: a.map((x) => this.id(x)) });
    this.until(() => this.actors[a[0]!]!.view().reachable.length === a.length - 1, 'split');
  }

  heal(): void {
    for (const t of TEAMS) this.actors[t]!.setFaults({ blocked: [] });
  }

  state(team: TeamId): MissionState {
    return this.actors[team]!.view().state;
  }

  events(team: TeamId, type: AnyEvent['type'], by?: TeamId): AnyEvent[] {
    return this.actors[team]!.events().filter((e) => e.type === type && (!by || e.actor === this.id(by)));
  }

  stop(): void {
    for (const t of TEAMS) this.actors[t]!.stop();
  }
}

function violations(state: MissionState): string[] {
  return state.conflicts.filter((c) => c.severity === 'violation').map((c) => c.summary);
}

describe('on real actors', () => {
  let fleet: Fleet;

  beforeEach(async () => {
    fleet = new Fleet();
    await fleet.connect();
  });

  afterEach(() => fleet.stop());

  it('refuses once across a minute of ticks, then gets the right when contact returns', () => {
    fleet.split();
    fleet.actors.medics!.submitTask(beat('upper-stand-carry'), { kind: 'human' });
    fleet.until(() => fleet.events('medics', 'task.refused').length > 0, 'refusal');
    fleet.clock.advance(60_000);

    const refusals = fleet.events('medics', 'task.refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ body: { decision: { refusal: 'NO_RIGHT', reason: 'Cannot start: Access holds the evacuation chair and cannot be reached.' } } });
    expect(fleet.state('medics').tasks['upper-stand-carry']?.owner).toBeUndefined();

    fleet.heal();
    fleet.until(() => fleet.state('medics').tasks['upper-stand-carry']?.owner === fleet.id('medics'), 'claim after transfer');
    expect(fleet.state('medics').tokens['evac-chair#1']?.holder).toBe(fleet.id('medics'));
    expect(fleet.events('medics', 'right.accepted', 'medics')).toHaveLength(1);
    expect(violations(fleet.state('medics'))).toEqual([]);
  });

  it('hands a declined task to the next team, and the one who declined stays out', () => {
    const spec: TaskSpec = { ...beat('queue-water'), id: 'heavy', priority: 2 };
    fleet.actors.medics!.submitTask(spec, { kind: 'human' });
    fleet.until(() => !!fleet.state('medics').tasks.heavy?.owner, 'first claim');
    const first = fleet.state('medics').tasks.heavy!.owner!;
    const [from, to] = first === fleet.id('supply') ? ['supply', 'facilities'] : ['facilities', 'supply'];
    fleet.until(() => !!fleet.state(from!).tasks.heavy?.owner, 'owner sees its claim');

    expect(fleet.actors[from!]!.declineTask('heavy', 'Our hands are full.')).toBe(true);
    fleet.until(() => fleet.state('medics').tasks.heavy?.owner === fleet.id(to!), 'handed on');
    fleet.clock.advance(20_000);

    expect(fleet.events('medics', 'task.claimed', from)).toHaveLength(1);
    expect(fleet.state('medics').tasks.heavy?.owner).toBe(fleet.id(to!));
    expect(violations(fleet.state('medics'))).toEqual([]);
  });

  it('covers across a split only after the mission window, using real link silence', () => {
    fleet.actors.medics!.submitTask(beat('queue-water'), { kind: 'human' });
    fleet.until(() => !!fleet.state('medics').tasks['queue-water']?.owner, 'claim');
    const owner = fleet.state('medics').tasks['queue-water']!.owner!;
    const other = owner === fleet.id('supply') ? 'facilities' : 'supply';
    fleet.until(() => !!fleet.state(other).tasks['queue-water']?.owner, 'claim reaches the far side');

    fleet.split();
    fleet.clock.advance(fleet.coverAfterMs - 1_500);
    expect(fleet.events(other, 'task.covered')).toEqual([]);

    fleet.until(() => fleet.events(other, 'task.covered').length > 0, 'cover', fleet.coverAfterMs + 2_000);
    fleet.clock.advance(20_000);
    expect(fleet.events(other, 'task.covered')).toHaveLength(1);
    expect(fleet.state(other).tasks['queue-water']?.coveredBy).toEqual([fleet.id(other)]);
    expect(violations(fleet.state(other))).toEqual([]);
  });
});
