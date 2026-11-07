import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { festivalCapsule, provision, scenarioBeats } from '@afterlink/mission';
import { canonicalize, generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, MissionCapsule, ProvisionBundle, TaskRecord, TaskSpec, TeamId } from '@afterlink/protocol';
import { createActor, createMemoryStorage, type ActorNode, type ActorOptions, type ActorStorage } from '../src/index.ts';

export const TEAMS = ['medics', 'access', 'facilities', 'supply'] as const;
export type Team = (typeof TEAMS)[number];

export const START = 1_750_000_000_000;

export function beatSpec(id: string): TaskSpec {
  const spec = scenarioBeats.find((b) => b.id === id)?.spec;
  if (!spec) throw new Error(`no task in beat ${id}`);
  return spec;
}

export interface FleetOptions {
  autopilot?: boolean;
  /** Drop the capsule tasks, for tests that want a quiet mission. */
  quiet?: boolean;
  seed?: number;
  start?: boolean;
  actor?: Partial<ActorOptions>;
}

/** Four real actors on a deterministic network in virtual time. */
export class Fleet {
  readonly clock = new VirtualClock(START);
  readonly net: MemoryNetwork;
  readonly capsule: MissionCapsule;
  readonly bundles: Record<TeamId, ProvisionBundle>;
  readonly storage: Record<Team, ActorStorage>;
  readonly actors = {} as Record<Team, ActorNode>;
  private readonly o: FleetOptions;

  constructor(o: FleetOptions = {}) {
    this.o = o;
    this.net = new MemoryNetwork({ seed: o.seed ?? 7, clock: this.clock });
    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer, { now: START });
    this.capsule = o.quiet ? { ...capsule, tasks: [] } : capsule;
    const { bundles } = provision(this.capsule, issuer, 'test-room');
    this.bundles = bundles;
    this.storage = Object.fromEntries(TEAMS.map((t) => [t, createMemoryStorage()])) as Record<Team, ActorStorage>;
    for (const t of TEAMS) this.actors[t] = this.make(t);
  }

  make(team: Team, extra: Partial<ActorOptions> = {}): ActorNode {
    const bundle = this.bundles[team]!;
    const id = bundle.actor.publicKey;
    return createActor({
      bundle,
      connector: this.net.connector(id),
      signal: this.net.signal(id),
      storage: this.storage[team],
      autopilot: this.o.autopilot ?? true,
      tickMs: 100,
      ...this.o.actor,
      ...extra,
    });
  }

  async start(): Promise<this> {
    for (const t of TEAMS) await this.actors[t].start();
    return this;
  }

  /** Starts the fleet and waits until everyone has joined and every link is open. */
  async connected(): Promise<this> {
    await this.start();
    this.until(() => TEAMS.every((t) => this.actors[t].view().reachable.length === 3), 'all links open');
    this.until(() => this.joined() === 4 && this.settledLogs(), 'everyone joined and in sync');
    this.quiet();
    return this;
  }

  private joined(): number {
    return new Set(this.actors.medics.events().filter((e) => e.type === 'actor.joined').map((e) => e.actor)).size;
  }

  id(team: Team): ActorId {
    return this.bundles[team]!.actor.publicKey;
  }

  teamOf(actor: ActorId | undefined): Team | undefined {
    return TEAMS.find((t) => this.id(t) === actor);
  }

  run(ms: number): void {
    this.clock.advance(ms);
  }

  until(done: () => boolean, what: string, limitMs = 120_000): void {
    for (let spent = 0; spent <= limitMs; spent += 50) {
      if (done()) return;
      this.clock.advance(50);
    }
    throw new Error(`gave up after ${limitMs}ms waiting for: ${what}`);
  }

  /** Lets a burst of sync finish, including any batch still waiting out its ack timeout. */
  quiet(): void {
    this.run(2000);
    this.until(() => this.settledLogs(), 'sync settles');
  }

  /** The stage route: every device is told who to refuse, and severs its own links. */
  split(a: readonly Team[], b: readonly Team[]): void {
    for (const t of a) this.actors[t].setFaults({ blocked: b.map((x) => this.id(x)) });
    for (const t of b) this.actors[t].setFaults({ blocked: a.map((x) => this.id(x)) });
  }

  unsplit(): void {
    for (const t of TEAMS) this.actors[t].setFaults({ blocked: [] });
  }

  task(id: string, from: Team = 'medics'): TaskRecord | undefined {
    return this.actors[from].view().state.tasks[id];
  }

  byTeam(id: string, from: Team = 'medics'): Team | undefined {
    return this.teamOf(this.task(id, from)?.owner);
  }

  settledLogs(): boolean {
    const [first, ...rest] = TEAMS.map((t) => canonicalize(this.actors[t].view().summary.heads));
    return rest.every((h) => h === first);
  }

  stop(): void {
    for (const t of TEAMS) this.actors[t].stop();
  }
}

export const eventsOf = (a: ActorNode, type: AnyEvent['type']): AnyEvent[] => a.events().filter((e) => e.type === type);

export const ownEvents = (a: ActorNode): AnyEvent[] => a.events().filter((e) => e.actor === a.id);

/** Every seq from 1 to the head exactly once, each linked to the one before: no gap, no fork, no duplicate. */
export function chainIsWhole(a: ActorNode): boolean {
  const own = ownEvents(a).sort((x, y) => x.seq - y.seq);
  return own.every((e, i) => e.seq === i + 1 && e.prev === (i === 0 ? null : own[i - 1]!.id));
}

/** Counts spends straight from signed events, independent of the ledger under test. */
export function spendsPerToken(events: AnyEvent[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const e of events) {
    if (e.type !== 'right.committed') continue;
    for (const t of e.body.tokens) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return count;
}
