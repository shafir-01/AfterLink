import { pendingTransfers } from '@afterlink/authority';
import type { AnyEvent, DecisionRecord, TaskRecord } from '@afterlink/protocol';
import { isFinished, isMine } from './rules.ts';
import type { ActorView } from './types.ts';

function byUrgency(a: TaskRecord, b: TaskRecord): number {
  return (
    Number(isFinished(a)) - Number(isFinished(b)) ||
    a.spec.priority - b.spec.priority ||
    (a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0)
  );
}

function decisionOf(e: AnyEvent): DecisionRecord | null {
  switch (e.type) {
    case 'task.claimed':
    case 'task.covered':
    case 'task.deferred':
    case 'task.refused':
      return e.body.decision;
    default:
      return null;
  }
}

export type ViewInput = Omit<
  ActorView,
  'myTasks' | 'nextAction' | 'tokens' | 'refusals' | 'lastDecision' | 'pendingTransfers'
> & { events: AnyEvent[] };

export function buildView({ events, ...rest }: ViewInput): ActorView {
  const self = rest.self.id;
  const { state } = rest;
  const myTasks = Object.values(state.tasks)
    .filter((t) => isMine(t, self))
    .sort(byUrgency);

  const refusals: DecisionRecord[] = [];
  let lastDecision: DecisionRecord | null = null;
  for (const e of events) {
    if (e.actor !== self) continue;
    const d = decisionOf(e);
    if (!d) continue;
    lastDecision = d;
    if (e.type === 'task.refused') refusals.push(d);
  }

  return {
    ...rest,
    myTasks,
    nextAction: myTasks.find((t) => !isFinished(t)) ?? null,
    tokens: Object.values(state.tokens).filter((t) => t.holder === self && t.state === 'held'),
    refusals,
    lastDecision,
    pendingTransfers: pendingTransfers(state, self),
  };
}
