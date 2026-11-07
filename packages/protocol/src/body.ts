import type { EventType } from './types.ts';

type Check = (v: unknown) => boolean;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const anything: Check = () => true;
const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number';
const bool: Check = (v) => typeof v === 'boolean';
const optional = (check: Check): Check => (v) => v === undefined || check(v);
const list = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
const record = (check: Check): Check => (v) => isObject(v) && Object.values(v).every(check);
const shape = (fields: Record<string, Check>): Check => (v) =>
  isObject(v) && Object.entries(fields).every(([key, check]) => check(v[key]));

const point = shape({ x: num, y: num });

const taskSpec = shape({
  id: str,
  kind: str,
  title: str,
  brief: str,
  objective: str,
  priority: num,
  location: point,
  locationName: str,
  requires: list(str),
  needs: list(shape({ resource: str, count: num })),
  dependsOn: list(str),
  reversible: bool,
  reliesOn: optional(list(str)),
  deadlineMs: optional(num),
});

const decision = shape({
  id: str,
  actor: str,
  taskId: str,
  outcome: str,
  refusal: optional(str),
  next: optional(list(str)),
  reason: str,
  policy: str,
  reachable: list(str),
  horizon: record(num),
  inputs: list(shape({ key: str, ageMs: num, state: str })),
  tokens: optional(list(str)),
  candidates: optional(list(shape({ actor: str, team: str, score: num, note: str }))),
});

const capsule = shape({
  id: str,
  version: num,
  name: str,
  objective: str,
  objectives: list(shape({ id: str, title: str, rank: num })),
  teams: list(shape({ id: str, name: str, capabilities: list(str), home: point })),
  resources: list(shape({ id: str, name: str, tokens: list(shape({ id: str, holderTeam: str })) })),
  tasks: list(taskSpec),
  contingencies: list(
    shape({
      id: str,
      when: shape({ key: str, equals: anything }),
      then: shape({ blockKinds: optional(list(str)), spawn: optional(list(taskSpec)), note: str }),
    }),
  ),
  fallback: shape({ coverAfterMs: num, coverMaxPriority: num, humanApprovalKinds: list(str) }),
  issuer: str,
  issuedAt: num,
});

const credential = shape({ mission: str, actor: str, team: str, custodian: bool, sig: str });

const observation = shape({
  key: str,
  value: anything,
  subject: str,
  observedAt: num,
  validForMs: num,
  source: str,
});

const taskDecision = shape({ taskId: str, decision });

/**
 * The closed set of event types and the body each must carry. Reducers read bodies without
 * checking them, so one signed junk body would otherwise break every replica on every fold.
 * Unknown extra fields pass, which keeps additive contract changes compatible.
 */
const BODIES: Record<EventType, Check> = {
  'mission.issued': shape({ capsule }),
  'actor.joined': shape({ team: str, name: str, credential }),
  'task.created': shape({ spec: taskSpec, source: shape({ kind: str, ref: optional(str) }) }),
  'task.claimed': taskDecision,
  'task.accepted': shape({ taskId: str, via: str }),
  'task.completed': shape({ taskId: str, evidence: str, via: str }),
  'task.deferred': taskDecision,
  'task.refused': taskDecision,
  'task.released': shape({ taskId: str, reason: str }),
  'task.covered': taskDecision,
  'right.committed': shape({ tokens: list(str), taskId: str }),
  'right.offered': shape({ transfer: str, tokens: list(str), to: str }),
  'right.accepted': shape({ transfer: str }),
  'right.declined': shape({ transfer: str }),
  'observation.recorded': shape({ observation }),
  'link.changed': shape({ peer: str, state: str, transport: str }),
  'ferry.received': shape({ packetId: str, from: str, events: num, newEvents: num }),
  'conflict.resolved': shape({ conflictId: str, resolution: str, keep: list(str) }),
};

export function bodyError(type: string, body: unknown): string | null {
  if (!Object.hasOwn(BODIES, type)) return `unknown event type ${type}`;
  return BODIES[type as EventType](body) ? null : `malformed ${type} body`;
}
