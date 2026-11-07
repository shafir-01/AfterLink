import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import type {
  ActorId,
  AnyEvent,
  EventBodies,
  EventEnvelope,
  EventId,
  EventType,
  MissionCapsule,
  MissionState,
  TaskRecord,
  TaskSpec,
  TeamId,
} from '@afterlink/protocol';
import { deriveTokens, type DerivedTokens, type LedgerToken } from '../src/index.ts';

export const MEDICS = 'actor-medics';
export const ACCESS = 'actor-access';
export const FACILITIES = 'actor-facilities';
export const SUPPLY = 'actor-supply';
export const ISSUER = 'actor-issuer';
export const CREW = [MEDICS, ACCESS, FACILITIES, SUPPLY];

export const custodians: Record<TeamId, ActorId> = {
  medics: MEDICS,
  access: ACCESS,
  facilities: FACILITIES,
  supply: SUPPLY,
};

export function task(id: string, requires: string[] = []): TaskSpec {
  return {
    id,
    kind: 'field',
    title: id,
    brief: id,
    objective: 'safety',
    priority: 1,
    location: { x: 0, y: 0 },
    locationName: 'Main field',
    requires,
    needs: [],
    dependsOn: [],
    reversible: true,
  };
}

export const capsule: MissionCapsule = {
  v: 1,
  id: 'mission-1',
  version: 1,
  name: 'Field day',
  objective: 'Keep everyone safe',
  objectives: [{ id: 'safety', title: 'Safety', rank: 1 }],
  teams: [
    { id: 'medics', name: 'Medics', capabilities: ['first-aid'], home: { x: 0, y: 0 } },
    { id: 'access', name: 'Access', capabilities: ['mobility'], home: { x: 10, y: 0 } },
    { id: 'facilities', name: 'Facilities', capabilities: ['repair'], home: { x: 20, y: 0 } },
    { id: 'supply', name: 'Supply', capabilities: ['haul'], home: { x: 30, y: 0 } },
  ],
  resources: [
    { id: 'evac-chair', name: 'Evacuation chair', tokens: [{ id: 'evac-chair#1', holderTeam: 'access' }] },
    {
      id: 'aed',
      name: 'AED',
      tokens: [
        { id: 'aed#1', holderTeam: 'medics' },
        { id: 'aed#2', holderTeam: 'medics' },
      ],
    },
    {
      id: 'cart',
      name: 'Cart',
      tokens: [
        { id: 'cart#1', holderTeam: 'supply' },
        { id: 'cart#2', holderTeam: 'supply' },
        { id: 'cart#3', holderTeam: 'facilities' },
      ],
    },
  ],
  tasks: [],
  contingencies: [],
  fallback: { coverAfterMs: 60000, coverMaxPriority: 2, humanApprovalKinds: [] },
  issuer: ISSUER,
  issuedAt: 0,
};

export const allTokens = capsule.resources.flatMap((r) => r.tokens.map((t) => t.id));

export function stateOf(derived: DerivedTokens, tasks: Record<string, TaskRecord> = {}): MissionState {
  const names: Record<ActorId, string> = { [MEDICS]: 'Noor', [ACCESS]: 'Sam', [FACILITIES]: 'Lee', [SUPPLY]: 'Ana' };
  const actors = Object.fromEntries(
    Object.entries(custodians).map(([team, id]) => [
      id,
      { id, team, name: names[id]!, lastSeq: 0, lastSeenWall: 0 },
    ]),
  );
  return {
    mission: capsule.id,
    capsule,
    actors,
    tasks,
    tokens: derived.tokens,
    observations: {},
    conflicts: derived.violations,
    eventCount: 0,
  };
}

/**
 * One replica running one identity, with the envelope rules a real log enforces: per-actor seq and
 * hash chain, Lamport above everything seen, parents naming the heads of other actors.
 */
export class Device {
  readonly events = new Map<EventId, AnyEvent>();
  private seq = 0;
  private prev: EventId | null = null;
  private clock = 0;
  private heads = new Map<ActorId, EventId>();

  constructor(readonly actor: ActorId) {}

  emit<T extends EventType>(type: T, body: EventBodies[T], overrides: Partial<EventEnvelope<T>> = {}): EventEnvelope<T> {
    this.seq += 1;
    this.clock += 1;
    const unsigned = {
      v: 1 as const,
      mission: capsule.id,
      actor: this.actor,
      seq: this.seq,
      prev: this.prev,
      parents: [...this.heads].filter(([a]) => a !== this.actor).map(([, id]) => id).sort(),
      lamport: this.clock,
      wall: 0,
      type,
      body,
      ...overrides,
    };
    const id = createHash('sha256').update(JSON.stringify(unsigned)).digest('base64url');
    const e = { ...unsigned, id, sig: 'test' } as EventEnvelope<T>;
    this.prev = id;
    this.keep(e as unknown as AnyEvent);
    return e;
  }

  commit(tokens: string[], taskId: string) {
    return this.emit('right.committed', { tokens, taskId });
  }

  offer(tokens: string[], to: ActorId, transfer: string) {
    return this.emit('right.offered', { transfer, tokens, to });
  }

  accept(transfer: string) {
    return this.emit('right.accepted', { transfer });
  }

  decline(transfer: string) {
    return this.emit('right.declined', { transfer });
  }

  receive(events: Iterable<AnyEvent>): void {
    for (const e of events) this.keep(e);
  }

  /** A second device running the same key, as after a cloned install. */
  clone(): Device {
    const twin = new Device(this.actor);
    twin.receive(this.events.values());
    twin.seq = this.seq;
    twin.prev = this.prev;
    return twin;
  }

  all(): AnyEvent[] {
    return [...this.events.values()];
  }

  derived(): DerivedTokens {
    return deriveTokens(capsule, this.all(), custodians);
  }

  state(): MissionState {
    return stateOf(this.derived());
  }

  private keep(e: AnyEvent): void {
    if (this.events.has(e.id)) return;
    this.events.set(e.id, e);
    this.clock = Math.max(this.clock, e.lamport);
    this.heads.set(e.actor, e.id);
  }
}

export function crew(): Record<ActorId, Device> {
  return Object.fromEntries(CREW.map((id) => [id, new Device(id)]));
}

export function exchange(...devices: Device[]): void {
  const union = devices.flatMap((d) => d.all());
  for (const d of devices) d.receive(union);
}

export function derive(events: AnyEvent[]): DerivedTokens {
  return deriveTokens(capsule, events, custodians);
}

export function token(derived: DerivedTokens, id: string): LedgerToken {
  return derived.tokens[id]!;
}

/** An independent replay of one chain: every step must be a move its signer was entitled to make. */
export function expectLegalChain(t: LedgerToken, events: Map<EventId, AnyEvent>): void {
  const team = capsule.resources.flatMap((r) => r.tokens).find((x) => x.id === t.id)!.holderTeam;
  let holder: ActorId | null = custodians[team] ?? null;
  let state: LedgerToken['state'] = 'held';
  let open: { transfer: string; from: ActorId; to: ActorId } | null = null;

  for (const id of t.chain) {
    const e = events.get(id);
    expect(e, 'chain names a known event').toBeDefined();
    if (!e || e.type === 'mission.issued') continue;
    if (e.type === 'right.committed') {
      expect(state).toBe('held');
      expect(e.actor).toBe(holder);
      expect(e.body.tokens).toContain(t.id);
      state = 'committed';
    } else if (e.type === 'right.offered') {
      expect(state).toBe('held');
      expect(e.actor).toBe(holder);
      expect(e.body.tokens).toContain(t.id);
      state = 'in-transit';
      open = { transfer: e.body.transfer, from: e.actor, to: e.body.to };
      holder = null;
    } else if (e.type === 'right.accepted' || e.type === 'right.declined') {
      expect(state).toBe('in-transit');
      expect(e.body.transfer).toBe(open!.transfer);
      expect(e.actor).toBe(open!.to);
      holder = e.type === 'right.accepted' ? open!.to : open!.from;
      state = 'held';
      open = null;
    } else {
      expect.unreachable(`unexpected ${e.type} in chain`);
    }
  }
  expect(t.state).toBe(state);
  expect(t.holder).toBe(holder);
}
