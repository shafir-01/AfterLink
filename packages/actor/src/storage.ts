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
  /** Ferry packets already taken in, so a replayed scan changes nothing. */
  ferrySeen?: string[];
}

/** The furthest point of its own chain this identity may have published. */
export interface HighWaterMark {
  actor: ActorId;
  mission: MissionId;
  seq: number;
  id: EventId;
}

export interface StoredActor {
  identity: ActorIdentity;
  /** In write order, which is always a causally closed prefix of what this device knew. */
  events: AnyEvent[];
  meta: ActorMeta;
}

/**
 * Durable state of one device. `append` is ordered and atomic: a batch lands whole, in call
 * order, and a returned promise resolves only once it would survive a crash. A storage may
 * return nothing when the write is already durable.
 */
export interface ActorStorage {
  /** Exclusive use of this identity on this device. False means another runtime has it. */
  acquire(): Promise<boolean>;
  load(): Promise<StoredActor | null>;
  /** Discards the log and binds the storage to one identity. The mark outlives this. */
  reset(identity: ActorIdentity): void | Promise<void>;
  /** The mark, when given, must be durable before this completes. */
  append(events: AnyEvent[], mark?: HighWaterMark): void | Promise<void>;
  /** Kept apart from the log, so it can reveal that the log went backwards. */
  readMark(): Promise<HighWaterMark | null>;
  saveMeta(meta: ActorMeta): void | Promise<void>;
  /** Releases the identity. */
  close?(): void;
}

/** Survives actor restarts for as long as the object is kept. */
export function createMemoryStorage(): ActorStorage {
  let held: StoredActor | null = null;
  let mark: HighWaterMark | null = null;
  let taken = false;
  return {
    acquire: async () => {
      if (taken) return false;
      taken = true;
      return true;
    },
    load: async () => (held ? structuredClone(held) : null),
    reset(identity) {
      held = { identity: { ...identity }, events: [], meta: {} };
    },
    append(events, next) {
      if (!held) throw new Error('storage has no identity');
      held.events.push(...structuredClone(events));
      if (next) mark = { ...next };
    },
    readMark: async () => (mark ? { ...mark } : null),
    saveMeta(meta) {
      if (!held) throw new Error('storage has no identity');
      held.meta = structuredClone(meta);
    },
    close() {
      taken = false;
    },
  };
}

const IDENTITY = 'identity';
const META = 'meta';
const MARK = 'mark';
/** Long enough for a reload to release the lock, short enough not to stall a real duplicate. */
const LOCK_WAIT_MS = 2000;

function readLocalMark(key: string): HighWaterMark | null {
  try {
    const text = globalThis.localStorage?.getItem(key);
    return text ? (JSON.parse(text) as HighWaterMark) : null;
  } catch {
    return null;
  }
}

function writeLocalMark(key: string, mark: HighWaterMark): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(mark));
  } catch {
    // The mark is also written to its own database. One surviving copy is enough.
  }
}

export function createIdbStorage(namespace: string): ActorStorage {
  const name = `afterlink-${namespace}`;
  const markName = `afterlink-mark-${namespace}`;
  let opened: Promise<IDBPDatabase> | null = null;
  let markOpened: Promise<IDBPDatabase> | null = null;
  let unlock: (() => void) | null = null;

  const db = () =>
    (opened ??= openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore('kv');
        d.createObjectStore('events', { autoIncrement: true });
      },
    }));
  const markDb = () =>
    (markOpened ??= openDB(markName, 1, {
      upgrade(d) {
        d.createObjectStore('kv');
      },
    }));

  return {
    acquire() {
      const locks = globalThis.navigator?.locks;
      if (!locks) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const held = new Promise<void>((release) => (unlock = release));
        locks
          .request(name, { signal: AbortSignal.timeout(LOCK_WAIT_MS) }, () => {
            resolve(true);
            return held;
          })
          .catch(() => resolve(false));
      });
    },
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
    async append(events, mark) {
      const d = await db();
      const tx = d.transaction('events', 'readwrite', { durability: 'strict' });
      for (const e of events) void tx.store.add(e);
      await tx.done;
      if (!mark) return;
      writeLocalMark(markName, mark);
      const m = await markDb();
      const markTx = m.transaction('kv', 'readwrite', { durability: 'strict' });
      await markTx.store.put(mark, MARK);
      await markTx.done;
    },
    async readMark() {
      const stored = ((await (await markDb()).get('kv', MARK)) as HighWaterMark | undefined) ?? null;
      const local = readLocalMark(markName);
      if (!stored || !local) return stored ?? local;
      return local.seq > stored.seq ? local : stored;
    },
    async saveMeta(meta) {
      const d = await db();
      await d.put('kv', meta, META);
    },
    close() {
      unlock?.();
      unlock = null;
      void opened?.then((d) => d.close());
      void markOpened?.then((d) => d.close());
      opened = markOpened = null;
    },
  };
}
