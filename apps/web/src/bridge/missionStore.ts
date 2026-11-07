import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventId, MissionCapsule, PartitionEpisode, ProvisionBundle, TeamId } from '@afterlink/protocol';

/** Hand-offs between routes in the same browser: what the stage saved for /#/debrief, what /#/compose approved. */
export interface DebriefInput {
  events: AnyEvent[];
  hqSeen: EventId[];
  episodes: PartitionEpisode[];
}

/** The key that signs missions from this browser. A capsule can only be issued by the key named on it. */
export interface Organiser {
  publicKey: ActorId;
  secretKey: string;
}

/** A mission already issued to real phones. Kept so a reload never re-keys devices in the field. */
export interface LeadMission {
  room: string;
  name: string;
  bundles: Record<TeamId, ProvisionBundle>;
}

const DATABASE = 'afterlink-stage';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const saveDebriefInput = (input: DebriefInput) => run('readwrite', (store) => store.put(input, 'debrief'));
export const loadDebriefInput = () => run<DebriefInput | undefined>('readonly', (store) => store.get('debrief'));
export const saveApprovedCapsule = (capsule: MissionCapsule) => run('readwrite', (store) => store.put(capsule, 'capsule'));
export const loadApprovedCapsule = () => run<MissionCapsule | undefined>('readonly', (store) => store.get('capsule'));
export const clearApprovedCapsule = () => run('readwrite', (store) => store.delete('capsule'));
export const saveLeadMission = (mission: LeadMission) => run('readwrite', (store) => store.put(mission, 'lead'));
export const loadLeadMission = () => run<LeadMission | undefined>('readonly', (store) => store.get('lead'));
export const clearLeadMission = () => run('readwrite', (store) => store.delete('lead'));

export async function organiserKeys(): Promise<Organiser> {
  const saved = await run<Organiser | undefined>('readonly', (store) => store.get('organiser'));
  if (saved) return saved;
  const keys = generateKeys();
  await run('readwrite', (store) => store.put(keys, 'organiser'));
  return keys;
}
