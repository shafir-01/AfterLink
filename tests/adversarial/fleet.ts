import { createActor, createMemoryStorage, type ActorNode, type ActorStorage } from '@afterlink/actor';
import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { festivalCapsule, provision, reduce } from '@afterlink/mission';
import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, MissionCapsule, MissionState, ProvisionBundle, TaskSpec, TeamId } from '@afterlink/protocol';

export const TEAMS = ['medics', 'access', 'facilities', 'supply'] as const;

/** Storage whose contents can be copied and restored, as a device backup can be. */
export function snapshotStorage(): ActorStorage & { snapshot(): Promise<Snapshot> } {
  const inner = createMemoryStorage();
  return {
    ...inner,
    async snapshot() {
      const held = await inner.load();
      const mark = await inner.readMark();
      const build = async (m: Awaited<ReturnType<ActorStorage['readMark']>>) => {
        const copy = createMemoryStorage();
        if (held) {
          await copy.reset(held.identity);
          await copy.append(held.events, m ?? undefined);
          await copy.saveMeta(held.meta);
        }
        return copy;
      };
      return {
        /** The whole device image rolled back: the log and its high-water mark together. */
        wholeImage: () => build(mark),
        /** Only the log rolled back: the mark kept apart from it survived. */
        logOnly: async () => build(await inner.readMark()),
      };
    },
  };
}

export interface Snapshot {
  wholeImage(): Promise<ActorStorage>;
  logOnly(): Promise<ActorStorage>;
}

export interface FleetOptions {
  capsule?: (issuer: { publicKey: ActorId; secretKey: string }) => MissionCapsule;
  autopilot?: boolean;
  signal?: boolean;
  now?: Partial<Record<TeamId, (real: number) => number>>;
}

export class Fleet {
  readonly clock = new VirtualClock(1_700_000_000_000);
  readonly net = new MemoryNetwork({ clock: this.clock, seed: 11 });
  readonly issuer = generateKeys();
  readonly nodes = new Map<TeamId, ActorNode>();
  readonly storages = new Map<TeamId, ReturnType<typeof snapshotStorage>>();
  capsule!: MissionCapsule;
  bundles!: Record<TeamId, ProvisionBundle>;
  private options: FleetOptions = {};

  static async start(o: FleetOptions = {}): Promise<Fleet> {
    const f = new Fleet();
    f.options = o;
    f.capsule = o.capsule ? o.capsule(f.issuer) : festivalCapsule(f.issuer, { now: f.clock.now() });
    f.bundles = provision(f.capsule, f.issuer, 'fleet-room').bundles;
    for (const team of Object.keys(f.bundles)) await f.boot(team);
    await f.run(6000);
    return f;
  }

  id(team: TeamId): ActorId {
    return this.bundles[team]!.actor.publicKey;
  }

  node(team: TeamId): ActorNode {
    return this.nodes.get(team)!;
  }

  async boot(team: TeamId, storage?: ActorStorage): Promise<ActorNode> {
    const bundle = this.bundles[team]!;
    const id = bundle.actor.publicKey;
    const own = storage ?? this.storages.get(team) ?? snapshotStorage();
    if (!storage) this.storages.set(team, own as ReturnType<typeof snapshotStorage>);
    const skew = this.options.now?.[team];
    const node = createActor({
      bundle,
      connector: this.net.connector(id),
      signal: this.options.signal === false ? undefined : this.net.signal(id),
      storage: own,
      autopilot: this.options.autopilot ?? false,
      autopilotDelayMs: 100,
      tickMs: 200,
      now: skew ? () => skew(this.clock.now()) : undefined,
    });
    await node.start();
    this.nodes.set(team, node);
    return node;
  }

  /** Advances virtual time while letting promise work complete between steps. */
  async run(ms: number, step = 100): Promise<void> {
    for (let t = 0; t < ms; t += step) {
      this.clock.advance(step);
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  stop(): void {
    for (const n of this.nodes.values()) n.stop();
  }

  /** Every event signed by anyone, as held by anyone. */
  union(): AnyEvent[] {
    const all = new Map<string, AnyEvent>();
    for (const n of this.nodes.values()) for (const e of n.events()) all.set(e.id, e);
    return [...all.values()];
  }

  state(events = this.union()): MissionState {
    return reduce(events, this.bundles[TEAMS[0]]!.roster);
  }

  split(left: TeamId[], right: TeamId[]): void {
    this.net.partition([left.map((t) => this.id(t)), right.map((t) => this.id(t))]);
  }

  task(id: string, over: Partial<TaskSpec> = {}): TaskSpec {
    return {
      id,
      kind: 'assist',
      title: id,
      brief: 'Help',
      objective: this.capsule.objectives[0]!.id,
      priority: 2,
      location: { x: 10, y: 10 },
      locationName: 'Field',
      requires: [],
      needs: [],
      dependsOn: [],
      reversible: true,
      ...over,
    };
  }
}

/** Distinct promises per token: two different commitments of one token is a double spend. */
export function doubleSpends(events: AnyEvent[]): string[] {
  const seen = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.type !== 'right.committed') continue;
    for (const t of e.body.tokens) {
      const set = seen.get(t) ?? new Set<string>();
      set.add(`${e.actor}|${e.body.taskId}`);
      seen.set(t, set);
    }
  }
  return [...seen].filter(([, s]) => s.size > 1).map(([t]) => t);
}

export function forks(events: AnyEvent[]): string[] {
  const slots = new Map<string, Set<string>>();
  for (const e of events) {
    const k = `${e.actor}#${e.seq}`;
    slots.set(k, (slots.get(k) ?? new Set()).add(e.id));
  }
  return [...slots].filter(([, s]) => s.size > 1).map(([k]) => k);
}
