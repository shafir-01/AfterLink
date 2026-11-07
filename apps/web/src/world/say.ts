import type { ActorId } from '@afterlink/protocol';
import type { StageEvent, StageState } from '../stage/contract';
import { plainReason } from './knowledge';

/** One plain sentence for each moment, for people who cannot see the map. */
export function sentence(e: StageEvent, state: StageState): string | null {
  const name = (id: ActorId) => state.seats.find((d) => d.id === id)?.name ?? 'A team';
  const task = (id: string) => state.truth.tasks.find((t) => t.id === id)?.title ?? 'a task';
  switch (e.kind) {
    case 'link':
      if (e.state === 'cut') return `Link between ${name(e.a)} and ${name(e.b)} closed.`;
      if (e.state === 'open') return `Link between ${name(e.a)} and ${name(e.b)} is back.`;
      return null;
    case 'hq':
      return e.alive ? 'HQ is back.' : 'HQ is down.';
    case 'request':
      return `New request: ${e.title}. ${name(e.actor)} heard it.`;
    case 'claimed':
      return `${name(e.actor)} took: ${task(e.taskId)}.`;
    case 'done':
      return `${name(e.actor)} finished: ${task(e.taskId)}.`;
    case 'refused':
      return e.protective ? `${name(e.actor)} refused. ${plainReason(e.reason)}` : null;
    case 'allocated':
      return `${e.resource} allocated to ${name(e.actor)}.`;
    case 'carried':
      return `The courier reached ${name(e.to)}. ${e.newEvents} signed ${e.newEvents === 1 ? 'event' : 'events'} verified.`;
    default:
      return null;
  }
}

/** Says what the split looks like whenever the groups change. */
export function groupsSentence(state: StageState): string {
  if (state.groups.length < 2) return 'All teams can reach each other.';
  const names = state.groups.map((g) => g.map((id) => state.seats.find((d) => d.id === id)?.name ?? '').join(' and '));
  return `${state.groups.length} groups: ${names.join('; ')}.`;
}
