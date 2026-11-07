import type { ActorId, MissionRecord, ResourceId, TaskId } from '@afterlink/protocol';
import type { RecordEntry, RecordWithTimeline } from './record.ts';

/**
 * Two computed baselines from a finished record.
 * centralOnlyCompleted: completed tasks whose every recorded step was seen by HQ when it happened.
 * lastWriteWinsDoubleBookings: within each partition episode, requests for an exclusive resource
 * from different groups that a last-write-wins store would each grant from its own view,
 * beyond what was free when the episode began.
 */
export function counterfactual(record: MissionRecord | RecordWithTimeline): { centralOnlyCompleted: number; lastWriteWinsDoubleBookings: number } {
  const timeline = record.timeline as RecordEntry[];

  const steps = new Map<TaskId, RecordEntry[]>();
  for (const e of timeline) if (e.taskId) (steps.get(e.taskId) ?? steps.set(e.taskId, []).get(e.taskId)!).push(e);
  let centralOnlyCompleted = 0;
  for (const list of steps.values()) if (list.some((e) => e.type === 'task.completed') && list.every((e) => !e.hiddenFromHq)) centralOnlyCompleted++;

  const issued = new Map<ResourceId, number>(record.conservation.map((c) => [c.resource, c.issued]));
  let lastWriteWinsDoubleBookings = 0;
  for (const ep of record.episodes) {
    const groupOf = new Map<ActorId, number>();
    ep.groups.forEach((g, i) => g.forEach((a) => groupOf.set(a, i)));
    const inEp = (e: RecordEntry) => e.at >= ep.from && (ep.to === null || e.at <= ep.to);
    const committedBefore = new Map<ResourceId, number>();
    for (const e of timeline) if (e.type === 'right.committed' && e.at < ep.from) for (const r of e.requests ?? []) committedBefore.set(r.resource, (committedBefore.get(r.resource) ?? 0) + r.count);

    const perResource = new Map<ResourceId, Map<number, Map<TaskId, number>>>();
    for (const e of timeline) {
      if (!e.requests || !inEp(e) || !e.taskId) continue;
      const g = groupOf.get(e.actor);
      if (g === undefined) continue;
      for (const r of e.requests) {
        const groups = perResource.get(r.resource) ?? new Map<number, Map<TaskId, number>>();
        const tasks = groups.get(g) ?? new Map<TaskId, number>();
        tasks.set(e.taskId, Math.max(tasks.get(e.taskId) ?? 0, r.count));
        groups.set(g, tasks);
        perResource.set(r.resource, groups);
      }
    }
    for (const [resource, groups] of perResource) {
      if (groups.size < 2) continue;
      const free = Math.max(0, (issued.get(resource) ?? 0) - (committedBefore.get(resource) ?? 0));
      let granted = 0;
      for (const tasks of groups.values()) granted += Math.min([...tasks.values()].reduce((s, n) => s + n, 0), free);
      lastWriteWinsDoubleBookings += Math.max(0, granted - free);
    }
  }
  return { centralOnlyCompleted, lastWriteWinsDoubleBookings };
}
