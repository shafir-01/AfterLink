import type { AnyEvent, EventId } from '@afterlink/protocol';

function byClock(a: AnyEvent, b: AnyEvent): number {
  return a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const causesOf = (e: AnyEvent): EventId[] => (e.prev ? [e.prev, ...e.parents] : e.parents);

/** Inserts into a list kept in descending clock order, so the lowest event pops first. */
function insertDescending(list: AnyEvent[], e: AnyEvent): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byClock(list[mid]!, e) > 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, e);
}

/**
 * The one order every replica walks: an event follows everything it names as a cause, and among
 * events whose causes are done the lowest lamport then lowest id goes first. Depends only on the
 * set of events. Clocks only break ties between concurrent events, and the ledger gives no such
 * tie any effect on who holds what.
 */
export function causalOrder(events: AnyEvent[]): AnyEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const waitingOn = new Map<EventId, number>();
  const effects = new Map<EventId, AnyEvent[]>();
  const ready: AnyEvent[] = [];

  for (const e of byId.values()) {
    let open = 0;
    for (const cause of new Set(causesOf(e))) {
      if (!byId.has(cause)) continue;
      open += 1;
      const list = effects.get(cause);
      if (list) list.push(e);
      else effects.set(cause, [e]);
    }
    waitingOn.set(e.id, open);
    if (open === 0) insertDescending(ready, e);
  }

  const ordered: AnyEvent[] = [];
  while (ready.length > 0) {
    const e = ready.pop()!;
    ordered.push(e);
    for (const effect of effects.get(e.id) ?? []) {
      const open = waitingOn.get(effect.id)! - 1;
      waitingOn.set(effect.id, open);
      if (open === 0) insertDescending(ready, effect);
    }
  }
  return ordered;
}

/** What each event could have known when it was signed, over one causally ordered history. */
export class CausalPast {
  private readonly ordered: AnyEvent[];
  private readonly position = new Map<EventId, number>();

  constructor(ordered: AnyEvent[]) {
    this.ordered = ordered;
    ordered.forEach((e, i) => this.position.set(e.id, i));
  }

  /** Nothing before `cause` in the walk can lead to it, so the search stops there. */
  includes(e: AnyEvent, cause: EventId): boolean {
    const floor = this.position.get(cause);
    if (floor === undefined) return false;
    const seen = new Set<EventId>();
    const stack = [e];
    while (stack.length > 0) {
      for (const id of causesOf(stack.pop()!)) {
        if (id === cause) return true;
        const at = this.position.get(id);
        if (at === undefined || at < floor || seen.has(id)) continue;
        seen.add(id);
        stack.push(this.ordered[at]!);
      }
    }
    return false;
  }
}
