export interface AiContext {
  limits: { take(name: string): unknown };
}

export function refusal(ctx: AiContext): { status: 429 | 503; reason: string } | null {
  const r = ctx.limits.take('claude');
  if (r === false) return { status: 429, reason: 'rate limited' };
  if (r && typeof r === 'object' && 'ok' in r && !(r as { ok: unknown }).ok) {
    const o = r as { status?: number; reason?: string };
    return { status: o.status === 503 ? 503 : 429, reason: o.reason ?? 'rate limited' };
  }
  return null;
}
