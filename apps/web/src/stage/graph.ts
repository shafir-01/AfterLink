import type { ActorId, LinkInfo, LinkState } from '@afterlink/protocol';

export type PairState = 'open' | 'forming' | 'cut';

export interface Pair {
  a: ActorId;
  b: ActorId;
  state: PairState;
}

export type LinkBook = Record<ActorId, LinkInfo[]>;

const pairState = (x?: LinkState, y?: LinkState): PairState => {
  if (x === 'open' && y === 'open') return 'open';
  if (x === 'severed' || y === 'severed') return 'cut';
  if ((x === 'closed' && y) || (y === 'closed' && x)) return 'cut';
  return 'forming';
};

/** A line exists only when both ends report it. Either end reporting a cut wins. */
export function readPairs(order: ActorId[], book: LinkBook): Pair[] {
  const out: Pair[] = [];
  order.forEach((a, i) => {
    for (const b of order.slice(i + 1)) {
      const ab = book[a]?.find((l) => l.peer === b)?.state;
      const ba = book[b]?.find((l) => l.peer === a)?.state;
      out.push({ a, b, state: pairState(ab, ba) });
    }
  });
  return out;
}

/** Devices that are not cut off from each other, in stage order. */
export function groupsOf(order: ActorId[], pairs: Pair[]): ActorId[][] {
  const root = new Map(order.map((a) => [a, a]));
  const find = (a: ActorId): ActorId => {
    const r = root.get(a) ?? a;
    return r === a ? a : find(r);
  };
  for (const p of pairs) if (p.state !== 'cut') root.set(find(p.a), find(p.b));
  const groups = new Map<ActorId, ActorId[]>();
  for (const a of order) {
    const r = find(a);
    groups.set(r, [...(groups.get(r) ?? []), a]);
  }
  return [...groups.values()];
}

export const pairKey = (a: ActorId, b: ActorId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const allOpen = (pairs: Pair[]): boolean => pairs.length > 0 && pairs.every((p) => p.state === 'open');
