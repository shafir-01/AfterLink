import { openDB, type IDBPDatabase } from 'idb';
import type { ActorId, AnyEvent, EventId, FaultPlan, MissionId } from '@afterlink/protocol';

export interface ActorIdentity {
  publicKey: ActorId;
  secretKey: string;
  mission: MissionId;
}

/** Device-local facts that cannot be derived from the event log. */
export interface ActorMeta {
  faults?: FaultPlan;
  /** Events delivered to the observer while they were happening. */
  hqLive?: EventId[];
  /** Events delivered to the observer only after a blind interval. */
  hqLate?: EventId[];
}

export interface StoredActor {
  identity: ActorIdentity;
  /** In write order, which is always a causally closed prefix of what this device knew. */
  events: AnyEvent[];
  meta: ActorMeta;
}

/**
 * Durable state of one device. `append` is ordered: writes land in call order, and a
 * returned promise resolves only once the events would survive a crash. A storage may
 * return nothing when the write is already durable.
 */
export interface ActorStorage {
  load(): Promise<StoredActor | null>;
  /** Discards anything held and binds the storage to one identity. */
  reset(identity: ActorIdentity): void | Promise<void>;
  append(events: AnyEvent[]): void | Promise<void>;
  saveMeta(meta: ActorMeta): void | Promise<void>;
  close?(): void;
}

/** Survives actor restarts for as long as the object is kept. */
export function createMemoryStorage(): ActorStorage {
  let held: StoredActor | null = null;
  return {
    load: async () => (held ? structuredClone(held) : null),
    reset(identity) {
      held = { identity: { ...identity }, events: [], meta: {} };
    },
    append(events) {
      if (!held) throw new Error('storage has no identity');
      held.events.push(...structuredClone(events));
    },
    saveMeta(meta) {
      if (!held) throw new Error('storage has no identity');
      held.meta = structuredClone(meta);
    },
  };
}

const IDENTITY = 'identity';
const META = 'meta';

export function createIdbStorage(namespace: string): ActorStorage {
  let opened: Promise<IDBPDatabase> | null = null;
  const db = () =>
    (opened ??= openDB(`afterlink-${namespace}`, 1, {
      upgrade(d) {
        d.createObjectStore('kv');
        d.createObjectStore('events', { autoIncrement: true });
      },
    }));

  return {
    async load() {
      const d = await db();
      const identity = (await d.get('kv', IDENTITY)) as ActorIdentity | undefined;
      if (!identity) return null;
      const events = (await d.getAll('events')) as AnyEvent[];
      const meta = ((await d.get('kv', META)) as ActorMeta | undefined) ?? {};
      return { identity, events, meta };
    },
    async reset(identity) {
      const d = await db();
      const tx = d.transaction(['kv', 'events'], 'readwrite', { durability: 'strict' });
      await tx.objectStore('events').clear();
      await tx.objectStore('kv').clear();
      await tx.objectStore('kv').put(identity, IDENTITY);
      await tx.done;
    },
    async append(events) {
      const d = await db();
      const tx = d.transaction('events', 'readwrite', { durability: 'strict' });
      for (const e of events) void tx.store.add(e);
      await tx.done;
    },
    async saveMeta(meta) {
      const d = await db();
      await d.put('kv', meta, META);
    },
    close() {
      void opened?.then((d) => d.close());
      opened = null;
    },
  };
}
