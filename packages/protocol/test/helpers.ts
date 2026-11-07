import { Author, EventLog, generateKeys, type AnyEvent, type KeyPair } from '../src/index.ts';

export const MISSION = 'mission-test';

export function seededKeys(n: number): KeyPair {
  return generateKeys(new Uint8Array(32).fill(n + 1));
}

export function note(reason: string): { taskId: string; reason: string } {
  return { taskId: 'task', reason };
}

export type Step = { kind: 'emit'; device: number } | { kind: 'sync'; from: number; to: number };

/**
 * Plays devices that write locally and sync pairwise, returning every event produced.
 * Each device only knows what reached it. Mapping two devices to one identity makes
 * that identity equivocate, which is how forks arise in these histories.
 */
export function playHistory(
  devices: number,
  steps: Step[],
  identity: (device: number) => number = (device) => device,
): { logs: EventLog[]; events: AnyEvent[] } {
  const logs = Array.from({ length: devices }, () => new EventLog(MISSION));
  const authors = logs.map((log, device) => new Author(seededKeys(identity(device)), log));
  const events: AnyEvent[] = [];
  steps.forEach((step, i) => {
    if (step.kind === 'emit') {
      events.push(authors[step.device % devices]!.emit('task.released', note(`step ${i}`), i) as unknown as AnyEvent);
    } else {
      const from = logs[step.from % devices]!;
      const to = logs[step.to % devices]!;
      to.ingestMany(from.missingFor(to.summary()));
    }
  });
  return { logs, events };
}

export const ids = (events: AnyEvent[]): string[] => events.map((e) => e.id);

/** Every dependency of every event appears earlier in the list. */
export function isCausal(events: AnyEvent[]): boolean {
  const seen = new Set<string>();
  for (const e of events) {
    const deps = e.prev ? [e.prev, ...e.parents] : e.parents;
    if (!deps.every((id) => seen.has(id))) return false;
    seen.add(e.id);
  }
  return true;
}

/** Comparable view of everything a replica should agree on. */
export function fingerprint(log: EventLog): unknown {
  return {
    order: ids(log.all()),
    heads: log.heads(),
    summary: log.summary(),
    forks: log.forks().map((f) => ({ actor: f.actor, seq: f.seq, ids: ids(f.events) })),
    lamport: log.lamport(),
  };
}
