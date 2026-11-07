import type { ActorId, AnyEvent, EventId, TaskId } from '@afterlink/protocol';
import { orderEvents } from './ledger.ts';

export interface Knowledge {
  actor: ActorId;
  atLamport: number;
  known: EventId[];
  unseen: EventId[];
  horizon: Record<ActorId, number>;
  completedKnown: TaskId[];
  completedUnseen: TaskId[];
}

/** What an actor could have known at a Lamport time: its own events plus everything causally behind them. */
export function whoKnewWhat(events: AnyEvent[], actor: ActorId, atLamport: number): Knowledge {
  const order = orderEvents(events);
  const byId = new Map(order.map((e) => [e.id, e]));
  const known = new Set<EventId>();
  const stack = order.filter((e) => e.actor === actor && e.lamport <= atLamport).map((e) => e.id);
  while (stack.length) {
    const id = stack.pop()!;
    if (known.has(id)) continue;
    const e = byId.get(id);
    if (!e) continue;
    known.add(id);
    if (e.prev) stack.push(e.prev);
    for (const p of e.parents) stack.push(p);
  }
  const horizon: Record<ActorId, number> = {};
  const completedKnown: TaskId[] = [];
  const completedUnseen: TaskId[] = [];
  const unseen: EventId[] = [];
  for (const e of order) {
    if (known.has(e.id)) {
      horizon[e.actor] = Math.max(horizon[e.actor] ?? 0, e.seq);
      if (e.type === 'task.completed') completedKnown.push(e.body.taskId);
    } else if (e.lamport <= atLamport) {
      unseen.push(e.id);
      if (e.type === 'task.completed') completedUnseen.push(e.body.taskId);
    }
  }
  return { actor, atLamport, known: order.filter((e) => known.has(e.id)).map((e) => e.id), unseen, horizon, completedKnown, completedUnseen };
}
