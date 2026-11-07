/**
 * The relay is optional. The stage never needs it and a static host may have none at all, so anything
 * that wants a relay service asks here first. A missing relay then costs one quiet check, not a failed
 * request per call. An asleep relay answers too slowly for the timeout, and that counts as unreachable.
 */
export type RelayService = 'claude' | 'elevenlabs' | 'n8n';
export type RelayAvailability = 'live' | 'not-configured' | 'unreachable';

type Services = Partial<Record<RelayService, boolean>>;

const CHECK_TIMEOUT_MS = 4_000;
const REMEMBER_LIVE_MS = 60_000;
const REMEMBER_DOWN_MS = 15_000;

const env = (import.meta as { env?: Record<string, unknown> }).env ?? {};

export function relayBase(): string {
  return String(env.VITE_RELAY_URL ?? '').replace(/\/$/, '');
}

async function check(doFetch: typeof fetch): Promise<Services | null> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  try {
    const base = relayBase();
    if (!base && !env.DEV) {
      const shell = await doFetch(`${String(env.BASE_URL ?? '/')}build.json`, { cache: 'no-store', signal });
      if (!shell.headers.has('x-afterlink-relay')) return null;
    }
    const res = await doFetch(`${base}/api/status`, { signal });
    if (!res.ok) return null;
    return ((await res.json()) as { services?: Services }).services ?? null;
  } catch {
    return null;
  }
}

let last: { until: number; services: Promise<Services | null> } | null = null;

function services(doFetch: typeof fetch): Promise<Services | null> {
  if (last && Date.now() < last.until) return last.services;
  const entry = { until: Date.now() + CHECK_TIMEOUT_MS, services: check(doFetch) };
  void entry.services.then((found) => {
    entry.until = Date.now() + (found ? REMEMBER_LIVE_MS : REMEMBER_DOWN_MS);
  });
  last = entry;
  return entry.services;
}

export async function relayService(name: RelayService, doFetch: typeof fetch = (...a) => fetch(...a)): Promise<RelayAvailability> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'unreachable';
  const found = await services(doFetch);
  if (!found) return 'unreachable';
  return found[name] ? 'live' : 'not-configured';
}
