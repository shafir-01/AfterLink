import type { ActorId, Json, KnowledgeState, Observation } from '@afterlink/protocol';

/** Device clocks drift. A report this far ahead of local time still counts as arrived. */
const CLOCK_SKEW_MS = 2_000;

export function sameValue(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const left = a as Record<string, Json>;
  const right = b as Record<string, Json>;
  return keys.every((k) => k in right && sameValue(left[k]!, right[k]!));
}

export function expired(o: Observation, now: number): boolean {
  return o.validForMs > 0 && now - o.observedAt > o.validForMs;
}

function arrived(o: Observation, now: number): boolean {
  return o.observedAt <= now + CLOCK_SKEW_MS;
}

/** Total order, so the answer never depends on the order observations were received in. */
function isNewer(a: Observation, b: Observation): boolean {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  if (a.source !== b.source) return a.source > b.source;
  return JSON.stringify(a.value) > JSON.stringify(b.value);
}

function newest(held: readonly Observation[]): Observation | undefined {
  let best: Observation | undefined;
  for (const o of held) if (!best || isNewer(o, best)) best = o;
  return best;
}

/** The report that decides what a key means now: the newest in date, else the newest held. */
export function leadReport(held: readonly Observation[], now: number): Observation | undefined {
  return newestInDate(held, now) ?? newest(held);
}

export function newestInDate(held: readonly Observation[], now: number): Observation | undefined {
  return newest(held.filter((o) => arrived(o, now) && !expired(o, now)));
}

/**
 * Does this actor know a fact, or only remember being told it?
 *
 * Each source counts once, by its newest report on the key. Reports from two sources that
 * are both in date and disagree leave the fact contradicted until one is superseded or expires.
 *
 * - pending: stamped for a time that has not arrived yet
 * - contradicted: superseded by its own source, or disputed by another source in date
 * - stale: past its validity window
 * - unreachable: past its window, and the source cannot be asked. Needs `reachable`.
 * - confirmed: two or more sources agree and are in date
 * - local: one source, in date, undisputed
 */
export function knowledgeState(
  obs: Observation,
  now: number,
  others: readonly Observation[],
  reachable?: readonly ActorId[],
): KnowledgeState {
  if (!arrived(obs, now)) return 'pending';
  const latest = new Map<ActorId, Observation>();
  for (const o of [obs, ...others]) {
    if (o.key !== obs.key || !arrived(o, now)) continue;
    const held = latest.get(o.source);
    if (!held || isNewer(o, held)) latest.set(o.source, o);
  }
  const current = latest.get(obs.source) ?? obs;
  if (!sameValue(current.value, obs.value)) return 'contradicted';
  const standing = [...latest.values()].filter((o) => !expired(o, now));
  if (standing.some((o) => !sameValue(o.value, obs.value))) return 'contradicted';
  if (expired(current, now)) return reachable && !reachable.includes(obs.source) ? 'unreachable' : 'stale';
  return standing.length >= 2 ? 'confirmed' : 'local';
}
