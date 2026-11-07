import { Author, EventLog, generateKeys, type ActorId, type AnyEvent, type KeyPair } from '@afterlink/protocol';
import { attachSync, MemoryNetwork, Mesh, VirtualClock, type MeshOptions, type SyncHandle, type SyncOptions } from '../src/index.ts';

export const MISSION = 'mission-mesh';

export function keysFor(n: number): KeyPair {
  return generateKeys(new Uint8Array(32).fill(n + 1));
}

export interface Node {
  id: ActorId;
  keys: KeyPair;
  mesh: Mesh;
  log: EventLog;
  author: Author;
  sync: SyncHandle;
  received: AnyEvent[];
  suspect: { invalid: AnyEvent[]; forks: AnyEvent[] }[];
  emit(reason: string): AnyEvent;
}

export interface Rig {
  clock: VirtualClock;
  net: MemoryNetwork;
  nodes: Node[];
  ids: ActorId[];
  settle(ms?: number): void;
  stop(): void;
}

export function rig(
  o: {
    size?: number;
    seed?: number;
    sync?: SyncOptions;
    mesh?: Partial<MeshOptions>;
    auth?: boolean;
    start?: boolean;
  } = {},
): Rig {
  const size = o.size ?? 4;
  const clock = new VirtualClock(1_000_000);
  const net = new MemoryNetwork({ seed: o.seed ?? 7, clock });
  const allKeys = Array.from({ length: size }, (_, i) => keysFor(i));
  const ids = allKeys.map((k) => k.publicKey);
  const nodes = allKeys.map((keys): Node => {
    const id = keys.publicKey;
    const log = new EventLog(MISSION);
    const author = new Author(keys, log);
    const mesh = new Mesh({
      self: id,
      peers: ids,
      signal: net.signal(id),
      connector: net.connector(id),
      room: 'test',
      seed: o.seed ?? 7,
      secretKey: o.auth ? keys.secretKey : undefined,
      ...o.mesh,
    });
    const received: AnyEvent[] = [];
    const suspect: Node['suspect'] = [];
    const sync = attachSync(mesh, log, (events) => received.push(...events), {
      onSuspect: (s) => suspect.push(s),
      ...o.sync,
    });
    const node: Node = {
      id,
      keys,
      mesh,
      log,
      author,
      sync,
      received,
      suspect,
      emit(reason) {
        const event = author.emit('task.released', { taskId: 'task', reason }, clock.now()) as unknown as AnyEvent;
        sync.nudge();
        return event;
      },
    };
    return node;
  });
  if (o.start !== false) for (const n of nodes) n.mesh.start();
  return {
    clock,
    net,
    nodes,
    ids,
    settle: (ms = 2000) => clock.advance(ms),
    stop() {
      for (const n of nodes) {
        n.sync.stop();
        n.mesh.stop();
      }
    },
  };
}

export const openPeers = (n: Node): ActorId[] =>
  n.mesh
    .links()
    .filter((l) => l.state === 'open')
    .map((l) => l.peer)
    .sort();

export const eventIds = (n: Node): string[] => n.log.all().map((e) => e.id);

export function expectConverged(nodes: Node[]): boolean {
  const first = JSON.stringify(eventIds(nodes[0]!));
  return nodes.every((n) => JSON.stringify(eventIds(n)) === first);
}

/** Counts wire messages crossing the mesh of every node, by type. */
export function tally(nodes: Node[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of nodes) {
    n.mesh.onMessage((_peer, msg) => {
      counts[msg.t] = (counts[msg.t] ?? 0) + 1;
      if (msg.t === 'events') counts.eventsCarried = (counts.eventsCarried ?? 0) + msg.events.length;
    });
  }
  return counts;
}

export { attachSync };
