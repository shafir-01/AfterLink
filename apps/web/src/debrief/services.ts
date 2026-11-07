import type { MissionRecord } from '@afterlink/protocol';

const base = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_RELAY_URL ?? '').replace(/\/$/, '');

export type Remote<T> = { s: 'idle' } | { s: 'busy' } | { s: 'live'; value: T } | { s: 'unavailable'; reason: string };

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(res.status === 404 || res.status === 503 || res.status === 501 ? 'Service not configured' : msg.slice(0, 120) || `Error ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

const reasonOf = (e: unknown) => (e instanceof TypeError ? 'Relay not reachable' : e instanceof Error ? e.message : 'Unavailable');

export async function narrate(record: MissionRecord): Promise<Remote<string>> {
  try {
    const j = (await post('/api/debrief/narrate', { record })) as Record<string, unknown>;
    const text = [j.narrative, j.text, j.report].find((x) => typeof x === 'string' && x.trim()) as string | undefined;
    return text ? { s: 'live', value: text } : { s: 'unavailable', reason: 'The service returned no report' };
  } catch (e) { return { s: 'unavailable', reason: reasonOf(e) }; }
}

export async function sendReport(record: MissionRecord, narrative: string | null): Promise<Remote<string>> {
  try {
    await post('/report/debrief', { record, narrative });
    return { s: 'live', value: 'Sent' };
  } catch (e) { return { s: 'unavailable', reason: reasonOf(e) }; }
}

const found = import.meta.glob('../../../../docs/results/headline.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export function measuredRuns(): { label: string; value: string }[] {
  const data = Object.values(found)[0];
  if (!data || typeof data !== 'object') return [];
  const rows: { label: string; value: string }[] = [];
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const label = (prefix ? prefix + ' ' : '') + k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') rows.push({ label, value: String(v) });
      else if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) walk(v as Record<string, unknown>, k);
    }
  };
  walk(data as Record<string, unknown>, '');
  return rows.slice(0, 8);
}
