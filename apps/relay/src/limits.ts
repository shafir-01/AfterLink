export type Provider = 'claude' | 'elevenlabs';
export const PROVIDERS: Provider[] = ['claude', 'elevenlabs'];

export type Take = { ok: true } | { ok: false; status: 429 | 503; reason: 'disabled' | 'daily-budget' };

export interface LimitsOptions {
  aiEnabled: boolean;
  dailyAiCalls: number;
  ratePerMinute: number;
  now?: () => number;
}

export interface Limits {
  /** Call before any paid provider request. Counts the call only when allowed. */
  take(provider: Provider): Take;
  /** True when this IP may make another request now. */
  hit(ip: string): boolean;
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

  const rollDay = () => {
    const d = dayOf(now());
    if (d !== day) {
      day = d;
      calls = { claude: 0, elevenlabs: 0 };
    }
  };
  const total = () => calls.claude + calls.elevenlabs;

  return {
    take(provider) {
      rollDay();
      if (!aiEnabled) return { ok: false, status: 503, reason: 'disabled' };
      if (total() >= o.dailyAiCalls) return { ok: false, status: 429, reason: 'daily-budget' };
      calls[provider]++;
      return { ok: true };
    },
    hit(ip) {
      const t = now();
      if (t - lastSweep > 60_000) {
        for (const [k, w] of windows) if (t - w.start >= 60_000) windows.delete(k);
        lastSweep = t;
      }
      const w = windows.get(ip);
      if (!w || t - w.start >= 60_000) {
        windows.set(ip, { start: t, n: 1 });
        return true;
      }
      w.n++;
      return w.n <= o.ratePerMinute;
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
  return createLimits({
    aiEnabled: truthy(env.AFTERLINK_AI_ENABLED, true),
    dailyAiCalls: Number.isFinite(budget) && env.AFTERLINK_DAILY_AI_CALLS ? budget : 200,
    ratePerMinute: Number.isFinite(rate) && env.AFTERLINK_RATE_PER_MINUTE ? rate : 120,
  });
}
