import type { ActorView } from '@afterlink/actor';
import type { CompactTask, CompactView } from '../bridge/protocol';

const REFUSALS_KEPT = 12;

export function compactView(view: ActorView, now: number): CompactView {
  const tasks: CompactTask[] = Object.values(view.state.tasks).map((task) => ({
    id: task.spec.id,
    title: task.spec.title,
    kind: task.spec.kind,
    status: task.status,
    priority: task.spec.priority,
    locationName: task.spec.locationName,
    location: task.spec.location,
    needs: task.spec.needs,
    owner: task.owner,
    coveredBy: task.coveredBy,
    updatedAt: task.updatedAt,
  }));
  return {
    self: view.self,
    at: now,
    signalUp: view.signalUp,
    reachable: view.reachable,
    links: view.links,
    eventCount: view.state.eventCount,
    tasks,
    myTasks: view.myTasks.map((task) => task.spec.id),
    nextAction: view.nextAction?.spec.id ?? null,
    tokens: Object.values(view.state.tokens),
    held: view.tokens.map((token) => token.id),
    refusals: view.refusals.slice(-REFUSALS_KEPT),
    lastDecision: view.lastDecision,
    conflicts: view.state.conflicts,
    horizon: view.horizon,
    lastHeard: view.lastHeard,
    summary: view.summary,
    pendingTransfers: view.pendingTransfers.length,
    storageError: view.storageError,
  };
}
