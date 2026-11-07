import { isTaskDone } from '@afterlink/mission';
import { canonicalize, sha256 } from '@afterlink/protocol';
import type { ActorId, Json, MissionState, ResourceId, TaskId, TaskRecord, TransferId } from '@afterlink/protocol';

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

/** Done work, including work whose record is in conflict. */
export function isFinished(task: TaskRecord): boolean {
  return isTaskDone(task) || task.status === 'cancelled';
}

export function isMine(task: TaskRecord, self: ActorId): boolean {
  return task.owner === self || (task.coveredBy ?? []).includes(self);
}
