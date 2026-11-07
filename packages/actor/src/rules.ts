import { canonicalize, sha256 } from '@afterlink/protocol';
import type {
  ActorId,
  AnyEvent,
  ContingencyRule,
  Json,
  MissionState,
  ResourceId,
  TaskId,
  TaskRecord,
  TaskSpec,
  TransferId,
} from '@afterlink/protocol';
import type { PendingTransfer } from './types.ts';

/** Observation key a requester uses to ask a named holder for rights. */
export const TRANSFER_REQUEST_KEY = 'right.request';

export interface TransferRequest {
  by: ActorId;
  taskId: TaskId;
  resource: ResourceId;
  count: number;
  from: ActorId;
}

export function transferRequests(state: MissionState): TransferRequest[] {
  const out: TransferRequest[] = [];
  for (const o of state.observations[TRANSFER_REQUEST_KEY] ?? []) {
    const v = o.value as Record<string, Json> | null;
    if (!v || typeof v !== 'object') continue;
    const { taskId, resource, count, from } = v;
    if (typeof taskId !== 'string' || typeof resource !== 'string') continue;
    if (typeof count !== 'number' || typeof from !== 'string') continue;
    out.push({ by: o.source, taskId, resource, count, from });
  }
  return out;
}

/** The same request always names the same transfer, so it can be answered at most once. */
export function transferIdFor(r: TransferRequest): TransferId {
  return sha256(canonicalize(['transfer', r.taskId, r.resource, r.by, r.from])).slice(0, 22);
}

const ACTIVE = new Set(['claimed', 'accepted']);
const FINISHED = new Set(['completed', 'cancelled']);

export function isFinished(task: TaskRecord): boolean {
  return FINISHED.has(task.status);
}

export function isMine(task: TaskRecord, self: ActorId): boolean {
  return task.owner === self || (task.coveredBy ?? []).includes(self);
}

/** How many tokens of a resource this actor's own active work still needs. */
export function reservedFor(state: MissionState, self: ActorId, resource: ResourceId): number {
  let total = 0;
  for (const t of Object.values(state.tasks)) {
    if (!ACTIVE.has(t.status) || !isMine(t, self)) continue;
    const need = t.spec.needs.find((n) => n.resource === resource)?.count ?? 0;
    const spent = Object.values(state.tokens).filter((k) => k.committedTo === t.spec.id && k.resource === resource).length;
    total += Math.max(0, need - spent);
  }
  return total;
}

export function transfersAddressedTo(self: ActorId, state: MissionState, events: AnyEvent[]): PendingTransfer[] {
  const moving = Object.values(state.tokens).filter((t) => t.state === 'in-transit');
  if (!moving.length) return [];
  const open = new Set(moving.map((t) => t.transfer));
  const out: PendingTransfer[] = [];
  for (const e of events) {
    if (e.type !== 'right.offered' || e.body.to !== self || !open.has(e.body.transfer)) continue;
    const tokens = moving.filter((t) => t.transfer === e.body.transfer).map((t) => t.id);
    out.push({ transfer: e.body.transfer, tokens, from: e.actor });
  }
  return out;
}

/** The newest value of an observation key this replica holds, unless it has expired. */
export function heldValue(state: MissionState, key: string, now: number): Json | undefined {
  const held = state.observations[key];
  if (!held?.length) return undefined;
  const latest = held.reduce((a, b) =>
    b.observedAt > a.observedAt || (b.observedAt === a.observedAt && b.source > a.source) ? b : a,
  );
  if (latest.validForMs > 0 && now - latest.observedAt > latest.validForMs) return undefined;
  return latest.value;
}

export function activeRules(state: MissionState, now: number): ContingencyRule[] {
  return (state.capsule?.contingencies ?? []).filter((rule) => {
    const v = heldValue(state, rule.when.key, now);
    return v !== undefined && canonicalize(v) === canonicalize(rule.when.equals);
  });
}

/** Everyone in a connected group picks the same actor, so a rule spawns its tasks once per group. */
export function spawnerFor(ruleId: string, group: ActorId[]): ActorId | undefined {
  let best: ActorId | undefined;
  let bestHash = '';
  for (const a of group) {
    const h = sha256(`${ruleId}:${a}`);
    if (best === undefined || h < bestHash) {
      best = a;
      bestHash = h;
    }
  }
  return best;
}

/** One external reference always maps to one task, even if two devices ingest it while split. */
export function externalTaskId(ref: string): TaskId {
  return `ext-${sha256(ref).slice(0, 16)}`;
}

/** External specs are untrusted, and a signed malformed task would reach every replica. */
export function isTaskSpec(v: unknown): v is TaskSpec {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  const text = (k: string) => typeof s[k] === 'string';
  const strings = (k: string) => Array.isArray(s[k]) && (s[k] as unknown[]).every((c) => typeof c === 'string');
  const point = s.location as { x?: unknown; y?: unknown } | undefined;
  const needs = s.needs as { resource?: unknown; count?: unknown }[] | undefined;
  return (
    text('id') &&
    text('kind') &&
    text('title') &&
    text('brief') &&
    text('objective') &&
    text('locationName') &&
    (s.priority === 1 || s.priority === 2 || s.priority === 3) &&
    typeof point?.x === 'number' &&
    typeof point?.y === 'number' &&
    strings('requires') &&
    strings('dependsOn') &&
    Array.isArray(needs) &&
    needs.every((n) => typeof n?.resource === 'string' && Number.isInteger(n?.count) && (n.count as number) > 0) &&
    typeof s.reversible === 'boolean'
  );
}
