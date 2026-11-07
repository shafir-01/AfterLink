import { reduce } from '@afterlink/mission';
import type { AnyEvent, ProvisionBundle, TaskId } from '@afterlink/protocol';
import { buildMissionRecord } from '@afterlink/reconcile';
import type { DebriefInput } from '../bridge/missionStore';
import { cleanSeed } from './seed';

export const CHAIR = 'evac-chair';

export interface Counters {
  finished: number;
  refused: number;
  cuts: number;
}

export interface EndSummary extends Counters {
  line: string;
  /** Incidents the stream raised, and how many of them were still not done at the buzzer. */
  raised: number;
  stopped: number;
  /** True when this came from the devices' own logs, so the debrief and verifier can open it. */
  recorded: boolean;
}

export interface Best {
  score: number;
  seed: string;
}

export interface Share {
  seed: string;
  score: number;
}

const BEST_KEY = 'afterlink.play.best';
const MAX_SCORE = 999;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function cutLine(cuts: number): string {
  return cuts ? `You cut ${plural(cuts, 'link')}.` : 'You cut nothing.';
}

export function endLine(a: { cuts: number; finished: number; chairSafe: boolean }): string {
  return `${cutLine(a.cuts)} They finished ${plural(a.finished, 'task')} ${a.chairSafe ? 'and never promised' : 'but promised'} the chair twice.`;
}

function rosterOf(events: AnyEvent[]): ProvisionBundle['roster'] {
  return events.flatMap((e) =>
    e.type === 'actor.joined' ? [{ actor: e.actor, team: e.body.team, name: e.body.name, custodian: e.body.credential.custodian, credential: e.body.credential }] : [],
  );
}

/** The end of a run, read from the devices' own logs by the same reconstruction the debrief uses. */
export function summarize(input: DebriefInput, run: { cuts: number; raised: TaskId[] }): EndSummary {
  const state = reduce(input.events, rosterOf(input.events));
  const record = buildMissionRecord({ events: input.events, state, hqSeen: input.hqSeen, episodes: input.episodes });
  const done = new Set(record.timeline.flatMap((e) => (e.type === 'task.completed' && e.taskId ? [e.taskId] : [])));
  const forked = record.conflicts.some((c) => c.kind === 'token-fork' && c.tokenId?.startsWith(CHAIR));
  const balanced = record.conservation.filter((row) => row.resource === CHAIR).every((row) => row.ok);
  const finished = done.size;
  return {
    line: endLine({ cuts: run.cuts, finished, chairSafe: !forked && balanced }),
    cuts: run.cuts,
    finished,
    refused: record.refusedUnsafe,
    raised: run.raised.length,
    stopped: run.raised.filter((id) => !done.has(id)).length,
    recorded: true,
  };
}

/** When the logs cannot be read, the end card says only what the live counters saw. */
export function summarizeLive(counters: Counters, raised: number): EndSummary {
  return { ...counters, line: `${cutLine(counters.cuts)} They finished ${plural(counters.finished, 'task')}.`, raised, stopped: 0, recorded: false };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readBest(store: Storage | null = storage()): Best | null {
  try {
    const best = JSON.parse(store?.getItem(BEST_KEY) ?? 'null') as Partial<Best> | null;
    const seed = cleanSeed(best?.seed);
    return seed && Number.isInteger(best?.score) ? { seed, score: best!.score! } : null;
  } catch {
    return null;
  }
}

export function writeBest(best: Best, store: Storage | null = storage()): void {
  try {
    store?.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    /* Private windows can refuse storage. The run still counts on screen. */
  }
}

/** Carries the seed and the score, and nothing about the mission itself. */
export function shareUrl(share: Share, at: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${at.origin}${at.pathname}#/?seed=${share.seed}&score=${share.score}`;
}

export function readShare(hash: string): Share | null {
  const query = hash.indexOf('?');
  if (query < 0) return null;
  const params = new URLSearchParams(hash.slice(query + 1));
  const seed = cleanSeed(params.get('seed'));
  const raw = params.get('score');
  const score = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
  return seed && score !== null && score <= MAX_SCORE ? { seed, score } : null;
}

export type Shared = 'shared' | 'copied' | 'failed';

export async function shareRun(share: Share): Promise<Shared> {
  const url = shareUrl(share);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'AfterLink', text: `I stopped ${share.score}. Beat it.`, url });
      return 'shared';
    }
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch (e) {
    return e instanceof DOMException && e.name === 'AbortError' ? 'shared' : 'failed';
  }
}
