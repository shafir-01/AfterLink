import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Provider = 'claude' | 'elevenlabs';
export const PROVIDERS: Provider[] = ['claude', 'elevenlabs'];

export type Take = { ok: true } | { ok: false; status: 429 | 503; reason: 'disabled' | 'daily-budget' };

export type Bucket = 'default' | 'paid' | 'admin';

export interface LimitsOptions {
  aiEnabled: boolean;
  dailyAiCalls: number;
  ratePerMinute: number;
  /** Per-IP requests per minute on routes that cost money or reach third parties. */
  paidPerMinute?: number;
  adminPerMinute?: number;
  /** When set, the day's spend is saved here and restored after a restart. */
  persistPath?: string;
  now?: () => number;
}

const MAX_WINDOWS = 50_000;

export interface Limits {
  /** Call before any paid provider request. Counts the call only when allowed. */
  take(provider: Provider): Take;
  /** True when this IP may make another request now in the given bucket. */
  hit(ip: string, bucket?: Bucket): boolean;
  spend(): { day: string; calls: Record<Provider, number>; total: number; budget: number; remaining: number; aiEnabled: boolean };
  setAiEnabled(on: boolean): void;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

export function createLimits(o: LimitsOptions): Limits {
  const now = o.now ?? Date.now;
  let aiEnabled = o.aiEnabled;
  let day = dayOf(now());
  let calls: Record<Provider, number> = { claude: 0, elevenlabs: 0 };
  const windows = new Map<string, { start: number; n: number }>();
  let lastSweep = now();
  const limitOf: Record<Bucket, number> = { default: o.ratePerMinute, paid: o.paidPerMinute ?? 10, admin: o.adminPerMinute ?? 10 };

  const persist = () => {
    if (!o.persistPath) return;
    try {
      mkdirSync(dirname(o.persistPath), { recursive: true });
      const tmp = `${o.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ day, calls }));
      renameSync(tmp, o.persistPath);
    } catch {
      // spend still counts in memory when the disk is read-only
    }
  };
  if (o.persistPath) {
    try {
      const saved = JSON.parse(readFileSync(o.persistPath, 'utf8')) as { day?: unknown; calls?: Partial<Record<Provider, unknown>> };
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
      if (saved.day === day) calls = { claude: n(saved.calls?.claude), elevenlabs: n(saved.calls?.elevenlabs) };
    } catch {
      // no saved spend yet
    }
  }

  const rollDay = () => {
    const d = dayOf(now());
    if (d !== day) {
      day = d;
      calls = { claude: 0, elevenlabs: 0 };
      persist();
    }
  };
  const total = () => calls.claude + calls.elevenlabs;

  return {
    take(provider) {
      rollDay();
      if (!aiEnabled) return { ok: false, status: 503, reason: 'disabled' };
      if (total() >= o.dailyAiCalls) return { ok: false, status: 429, reason: 'daily-budget' };
      calls[provider]++;
      persist();
      return { ok: true };
    },
    hit(ip, bucket = 'default') {
      const t = now();
      if (t - lastSweep > 60_000 || windows.size > MAX_WINDOWS) {
        for (const [k, w] of windows) if (t - w.start >= 60_000) windows.delete(k);
        lastSweep = t;
        while (windows.size > MAX_WINDOWS) windows.delete(windows.keys().next().value as string);
      }
      const key = `${bucket}|${ip}`;
      const w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        windows.set(key, { start: t, n: 1 });
        return true;
      }
      w.n++;
      return w.n <= limitOf[bucket];
    },
    spend() {
      rollDay();
      return { day, calls: { ...calls }, total: total(), budget: o.dailyAiCalls, remaining: Math.max(0, o.dailyAiCalls - total()), aiEnabled };
    },
    setAiEnabled(on) {
      aiEnabled = on;
    },
  };
}

const truthy = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : !/^(0|false|off|no)$/i.test(v));

export function limitsFromEnv(env: NodeJS.ProcessEnv): Limits {
  const budget = Number(env.AFTERLINK_DAILY_AI_CALLS);
  const rate = Number(env.AFTERLINK_RATE_PER_MINUTE);
  const paid = Number(env.AFTERLINK_PAID_RATE_PER_MINUTE);
  const persistent = env.AFTERLINK_BUDGET_FILE || (env.RENDER || env.NODE_ENV === 'production' ? join(process.cwd(), '.afterlink-cache', 'budget.json') : undefined);
  return createLimits({
    aiEnabled: truthy(env.AFTERLINK_AI_ENABLED, true),
    dailyAiCalls: Number.isFinite(budget) && env.AFTERLINK_DAILY_AI_CALLS ? budget : 200,
    ratePerMinute: Number.isFinite(rate) && env.AFTERLINK_RATE_PER_MINUTE ? rate : 120,
    paidPerMinute: Number.isFinite(paid) && env.AFTERLINK_PAID_RATE_PER_MINUTE ? paid : 10,
    persistPath: persistent,
  });
}
