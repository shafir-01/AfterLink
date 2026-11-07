import type { MissionCapsule } from '@afterlink/protocol';
import { relayBase, relayService } from '../relay';

export interface Meta {
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
}
export interface Right { resource: string; name: string; basis: string; tokens: number; holders: string[] }

export type CompileResult =
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'questions'; questions: string[]; meta: Meta }
  | { kind: 'draft'; capsule: MissionCapsule; rights: Right[]; rejectedRights: string[]; meta: Meta };

export async function compileMission(
  objective: string,
  clarifications: { question: string; answer: string }[],
  issuer?: string,
  doFetch: typeof fetch = fetch,
): Promise<CompileResult> {
  if ((await relayService('claude', doFetch)) !== 'live') return { kind: 'unavailable' };
  let res: Response;
  try {
    res = await doFetch(`${relayBase()}/api/mission/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective, clarifications, issuer }),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (res.status === 503 || body.live === false) return { kind: 'unavailable' };
  if (res.status === 429) return { kind: 'error', message: 'Too many requests. Try again shortly.' };
  if (body.status === 'questions') return { kind: 'questions', questions: body.questions, meta: body.meta };
  if (body.status === 'draft') return { kind: 'draft', capsule: body.capsule, rights: body.rights, rejectedRights: body.rejectedRights, meta: body.meta };
  if (body.status === 'invalid') return { kind: 'error', message: `The draft was not valid: ${(body.errors as string[]).join('; ')}` };
  return { kind: 'error', message: typeof body.error === 'string' ? body.error : 'Something went wrong.' };
}
