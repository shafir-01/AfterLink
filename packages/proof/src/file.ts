import { canonicalize, sha256 } from '@afterlink/protocol';
import type { AnyEvent, EventEnvelope, EventId, MissionCapsule, MissionId, ProvisionBundle } from '@afterlink/protocol';
import { missionFingerprint } from './fingerprint.ts';

export const FORMAT = 'afterlink.mission';
export const FILE_EXTENSION = '.afterlink';

export type RosterEntry = ProvisionBundle['roster'][number];

/**
 * A complete, self-contained mission history. Events and credentials carry their own signatures.
 * `seal` commits to the event set, the roster and the observer log, so accidental damage to the
 * unsigned parts is visible. It is a checksum, not a signature: anyone can recompute it.
 */
export interface MissionFile {
  format: typeof FORMAT;
  v: 1;
  mission: MissionId;
  capsule: MissionCapsule;
  roster: RosterEntry[];
  /** Event ids the observer received as they happened, or null when no observer log was kept. */
  hqSeen: EventId[] | null;
  seal: string;
  events: AnyEvent[];
}

export interface ExportOptions {
  hqSeen?: EventId[] | null;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareEvents(a: AnyEvent, b: AnyEvent): number {
  return a.lamport - b.lamport || compareText(a.actor, b.actor) || a.seq - b.seq || compareText(a.id, b.id);
}

const byActor = (a: RosterEntry, b: RosterEntry): number => compareText(a.actor, b.actor);

export function sealOf(root: string, roster: RosterEntry[], hqSeen: EventId[] | null): string {
  return sha256(
    canonicalize({
      purpose: 'afterlink-seal',
      root,
      roster: [...roster].sort(byActor),
      hqSeen: hqSeen === null ? null : [...new Set(hqSeen)].sort(),
    }),
  );
}

/** Credentials travel inside the signed join events, so a roster can be rebuilt from history alone. */
export function rosterFrom(events: AnyEvent[]): RosterEntry[] {
  const roster = new Map<string, RosterEntry>();
  for (const e of events) {
    if (e.type !== 'actor.joined') continue;
    const { name, team, credential } = e.body;
    roster.set(e.actor, { actor: e.actor, team, name, custodian: credential.custodian, credential });
  }
  return [...roster.values()].sort(byActor);
}

/** One event per line after the header, so a file can be read, compared and diffed by hand. */
export function encodeFile(file: MissionFile): string {
  const { events, ...header } = file;
  const head = canonicalize(header).slice(0, -1);
  return `${head},"events":[\n${events.map((e) => canonicalize(e)).join(',\n')}\n]}\n`;
}

export function exportMission(events: AnyEvent[], roster: RosterEntry[] = rosterFrom(events), opts: ExportOptions = {}): string {
  const unique = [...new Map(events.map((e) => [e.id, e])).values()].sort(compareEvents);
  const genesis = unique.find((e): e is EventEnvelope<'mission.issued'> => e.type === 'mission.issued');
  if (!genesis) throw new Error('Nothing to export: this history has no mission.issued event');
  const hqSeen = opts.hqSeen === undefined || opts.hqSeen === null ? null : [...new Set(opts.hqSeen)].sort();
  const sorted = [...roster].sort(byActor);
  return encodeFile({
    format: FORMAT,
    v: 1,
    mission: genesis.mission,
    capsule: genesis.body.capsule,
    roster: sorted,
    hqSeen,
    seal: sealOf(missionFingerprint(unique), sorted, hqSeen),
    events: unique,
  });
}
