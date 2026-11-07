import type {
  ActorId,
  MissionState,
  NextStep,
  RefusalCode,
  ResourceId,
  TaskRecord,
  TaskSpec,
  TeamId,
  TokenId,
  TransferId,
} from '@afterlink/protocol';
import type { LedgerToken } from './ledger.ts';
import { capitalise, resourcePhrase } from './words.ts';

export type Refusal = { ok: false; code: RefusalCode; reason: string; next: NextStep[] };
export type Verdict = { ok: true } | Refusal;

function refuse(code: RefusalCode, reason: string, next: NextStep[]): Refusal {
  return { ok: false, code, reason, next };
}

/** A teammate by name, anyone else by team. */
function nameOf(state: MissionState, viewer: ActorId, actor: ActorId, team?: TeamId): string {
  const record = state.actors[actor];
  const teamId = record?.team ?? team;
  if (record && state.actors[viewer]?.team === teamId) return record.name;
  return state.capsule?.teams.find((t) => t.id === teamId)?.name ?? record?.name ?? 'another team';
}

function refusalFor(
  state: MissionState,
  actor: ActorId,
  token: LedgerToken,
  reachable: ActorId[] | undefined,
): Refusal | null {
  const what = resourcePhrase(state.capsule, token.resource);
  const What = capitalise(what);

  if (token.state === 'committed') {
    const task = token.committedTo ? state.tasks[token.committedTo]?.spec.title : undefined;
    return refuse('NO_RIGHT', `${What} is already committed${task ? ` to ${task}` : ''}.`, ['SUBSTITUTE', 'ESCALATE']);
  }

  if (token.state === 'in-transit') {
    if (token.to === actor) {
      return refuse('TOKEN_IN_TRANSIT', `${What} is on its way to you. Accept it first.`, ['WAIT_FOR_CONTACT']);
    }
    const recipient = token.to ? nameOf(state, actor, token.to) : null;
    if (token.from === actor && recipient) {
      return refuse('TOKEN_IN_TRANSIT', `You offered ${what} to ${recipient}. It stays locked until they answer.`, [
        'WAIT_FOR_CONTACT',
        'CARRY_UPDATE',
      ]);
    }
    return refuse('TOKEN_IN_TRANSIT', recipient ? `${What} is on its way to ${recipient}.` : `${What} is in transit.`, [
      'WAIT_FOR_CONTACT',
      'SUBSTITUTE',
    ]);
  }

  if (token.holder === actor) return null;
  if (token.holder === null) return refuse('NO_RIGHT', `${What} has no holder.`, ['ESCALATE']);

  const holder = nameOf(state, actor, token.holder, token.holderTeam);
  if (!reachable) return refuse('NO_RIGHT', `${What} is held by ${holder}.`, ['REQUEST_TRANSFER', 'SUBSTITUTE']);
  if (reachable.includes(token.holder)) {
    return refuse('NO_RIGHT', `${What} is held by ${holder}. Ask them to transfer it.`, ['REQUEST_TRANSFER']);
  }
  return refuse('NO_RIGHT', `${What} is held by ${holder}, who you cannot reach.`, [
    'WAIT_FOR_CONTACT',
    'CARRY_UPDATE',
    'SUBSTITUTE',
  ]);
}

/**
 * Whether this actor may spend these tokens now, judged on its own view. Pass `reachable` to have
 * the reason say whether the holder can be contacted. The first token that fails decides the
 * reason.
 */
export function canCommit(
  state: MissionState,
  actor: ActorId,
  tokens: TokenId[],
  opts: { reachable?: ActorId[] } = {},
): Verdict {
  for (const id of tokens) {
    const token = state.tokens[id];
    if (!token) return refuse('NO_RIGHT', `This mission has no right called ${id}.`, ['ESCALATE']);
    const refusal = refusalFor(state, actor, token, opts.reachable);
    if (refusal) return refusal;
  }
  return { ok: true };
}

/** An offer spends a token exactly as a commitment does, so the same rule gates both. */
export const canOffer = canCommit;

/** Up to `count` tokens this actor may spend now, in stable order. Fewer means not enough. */
export function findTokens(state: MissionState, actor: ActorId, resource: ResourceId, count: number): TokenId[] {
  return Object.values(state.tokens)
    .filter((t) => t.resource === resource && t.state === 'held' && t.holder === actor)
    .map((t) => t.id)
    .sort()
    .slice(0, Math.max(0, count));
}

/** Open transfers waiting on this actor's answer. */
export function pendingTransfers(
  state: MissionState,
  actor: ActorId,
): { transfer: TransferId; tokens: TokenId[]; from: ActorId }[] {
  const pending = new Map<TransferId, { transfer: TransferId; tokens: TokenId[]; from: ActorId }>();
  for (const token of Object.values(state.tokens) as LedgerToken[]) {
    if (token.state !== 'in-transit' || token.to !== actor || !token.transfer || !token.from) continue;
    const entry = pending.get(token.transfer);
    if (entry) entry.tokens.push(token.id);
    else pending.set(token.transfer, { transfer: token.transfer, tokens: [token.id], from: token.from });
  }
  return [...pending.values()];
}

/** Whether this actor's team has every capability the task requires. */
export function canPerform(state: MissionState, actor: ActorId, task: TaskSpec | TaskRecord): Verdict {
  const spec = 'spec' in task ? task.spec : task;
  const teamId = state.actors[actor]?.team;
  const team = state.capsule?.teams.find((t) => t.id === teamId);
  if (!team) return refuse('NO_CAPABILITY', 'This device is not on the mission roster.', ['ESCALATE']);

  const missing = spec.requires.filter((c) => !team.capabilities.includes(c));
  if (missing.length === 0) return { ok: true };
  const needs = missing.map((c) => c.replaceAll('-', ' ')).join(' and ');
  return refuse('NO_CAPABILITY', `${team.name} cannot do this. It needs ${needs}.`, ['SUBSTITUTE']);
}
