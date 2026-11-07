import type { TaskId } from '@afterlink/protocol';
import { saveDebriefInput, type DebriefInput } from '../bridge/missionStore';
import type { StageState } from '../stage/contract';
import type { PlayController } from './contract';
import { DareBoard, type Dare, type DareId } from './dares';
import { buildDeck, gapAfter, type Incident } from './incidents';
import { readBest, readShare, summarize, summarizeLive, writeBest, type Best, type Counters, type EndSummary, type Share } from './score';
import { newSeed } from './seed';

export type PlayPhase = 'idle' | 'starting' | 'running' | 'collecting' | 'ended';

export interface PlaySnapshot {
  phase: PlayPhase;
  /** True from the moment a run is asked for until its end card closes. */
  active: boolean;
  seed: string | null;
  seconds: number;
  leftMs: number;
  counters: Counters;
  dares: Dare[];
  /** The newest hint or outcome, one short line. */
  note: string | null;
  end: EndSummary | null;
  best: Best | null;
  newBest: boolean;
  /** Seed and score from a shared link. */
  challenge: Share | null;
  failure: string | null;
}

export interface PlayDeps {
  now(): number;
  every(ms: number, fn: () => void): () => void;
  save(input: DebriefInput): Promise<unknown>;
  newSeed(): string;
  loadBest(): Best | null;
  storeBest(best: Best): void;
  hash(): string;
}

export const RUN_LENGTHS = [60, 90, 120];
const DEFAULT_SECONDS = 90;
const TICK_MS = 200;
const LEAD_IN_MS = 1500;
/** No new trouble at the very end: an incident raised at the buzzer proves nothing about the player. */
const QUIET_TAIL_MS = 6000;
const START_WAIT_MS = 40_000;
const COLLECT_WAIT_MS = 8000;

const browserDeps: PlayDeps = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  },
  save: saveDebriefInput,
  newSeed: () => newSeed(),
  loadBest: () => readBest(),
  storeBest: (best) => writeBest(best),
  hash: () => window.location.hash,
};

const zero: Counters = { finished: 0, refused: 0, cuts: 0 };

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** One timed run. Every incident enters through a real device and every number is read back from the devices. */
export class PlayEngine {
  private readonly listeners = new Set<() => void>();
  private readonly deps: PlayDeps;
  private current: PlaySnapshot;
  private deck: Incident[] = [];
  private cursor = 0;
  private nextAt = 0;
  private endsAt = 0;
  private waitUntil = 0;
  private fromRun = 0;
  private stageRun = 0;
  private ending = 0;
  private raised: TaskId[] = [];
  private board: DareBoard | null = null;
  private stopTick: (() => void) | null = null;
  private stopListening: (() => void) | null = null;

  constructor(
    private readonly controller: PlayController,
    deps: Partial<PlayDeps> = {},
  ) {
    this.deps = { ...browserDeps, ...deps };
    this.current = {
      phase: 'idle',
      active: false,
      seed: null,
      seconds: DEFAULT_SECONDS,
      leftMs: DEFAULT_SECONDS * 1000,
      counters: zero,
      dares: [],
      note: null,
      end: null,
      best: this.deps.loadBest(),
      newBest: false,
      challenge: readShare(this.deps.hash()),
      failure: null,
    };
  }

  snapshot = (): PlaySnapshot => this.current;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  setSeconds = (seconds: number) => {
    if (this.current.phase === 'idle' || this.current.phase === 'ended') this.update({ seconds, leftMs: seconds * 1000 });
  };

  /** Throws the old mission away and starts again. A shared seed is kept until the link is left. */
  begin = (seed?: string) => {
    const { phase, challenge } = this.current;
    if (phase === 'starting' || phase === 'running' || phase === 'collecting') return;
    const picked = seed ?? challenge?.seed ?? this.deps.newSeed();
    this.deck = buildDeck(picked);
    this.cursor = 0;
    this.raised = [];
    this.board = new DareBoard(this.controller, picked);
    this.fromRun = this.controller.snapshot().run;
    this.waitUntil = this.deps.now() + START_WAIT_MS;
    this.update({ phase: 'starting', active: true, seed: picked, leftMs: this.current.seconds * 1000, counters: zero, dares: this.board.list(), note: null, end: null, newBest: false, failure: null });
    this.listen();
    this.controller.restart();
  };

  arm = (id: DareId) => {
    if (this.current.phase !== 'running' || !this.board) return;
    this.board.arm(id);
    this.publish();
  };

  /** Ends the run now, with the same end card as the buzzer. */
  finishNow = () => {
    if (this.current.phase === 'running') void this.finish();
  };

  /** Closes the end card and leaves the map on screen. */
  dismiss = () => {
    if (this.current.phase === 'ended') this.update({ phase: 'idle', active: false });
  };

  dispose() {
    this.silence();
    this.ending++;
    const { phase } = this.current;
    if (phase === 'starting' || phase === 'running' || phase === 'collecting') this.update({ phase: 'idle', active: false });
  }

  private listen() {
    this.silence();
    this.stopListening = this.controller.subscribe(this.heard);
    this.stopTick = this.deps.every(TICK_MS, this.tick);
  }

  private silence() {
    this.stopListening?.();
    this.stopTick?.();
    this.stopListening = this.stopTick = null;
  }

  private readonly heard = () => {
    const state = this.controller.snapshot();
    const { phase } = this.current;
    if (phase === 'starting') {
      if (state.phase === 'failed') this.fail(state.failure ?? 'The teams could not connect.');
      else if (state.run !== this.fromRun && state.phase === 'live') this.launch(state);
    } else if (phase === 'running') {
      if (state.run !== this.stageRun) this.abandon();
      else {
        this.board?.step(state);
        this.publish(state);
      }
    }
  };

  private readonly tick = () => {
    const now = this.deps.now();
    const { phase } = this.current;
    if (phase === 'starting') {
      if (now > this.waitUntil) this.fail('The teams did not connect in time.');
      else this.heard();
      return;
    }
    if (phase !== 'running') return;
    const left = Math.max(0, this.endsAt - now);
    if (left === 0) {
      void this.finish();
      return;
    }
    while (now >= this.nextAt && left > QUIET_TAIL_MS && this.cursor < this.deck.length) this.raise(this.deck[this.cursor++]!);
    this.update({ leftMs: left });
  };

  private launch(state: StageState) {
    const now = this.deps.now();
    this.stageRun = state.run;
    this.endsAt = now + this.current.seconds * 1000;
    this.nextAt = now + LEAD_IN_MS;
    this.update({ phase: 'running' });
    this.publish(state);
  }

  private raise(incident: Incident) {
    if (incident.type === 'task') {
      const { spec, team } = incident;
      if (this.controller.addTask(team, spec, { kind: 'human', ref: spec.id })) this.raised.push(spec.id);
    } else {
      const { key, team, validForMs } = incident;
      this.controller.observe(team, key, true, { subject: key, validForMs });
    }
    this.nextAt += gapAfter(incident, this.current.counters.cuts);
  }

  private publish(state = this.controller.snapshot()) {
    const { tasksFinished, unsafeRefused, linksCut } = state.score;
    const was = this.current.counters;
    const changed = was.finished !== tasksFinished || was.refused !== unsafeRefused || was.cuts !== linksCut;
    const counters = changed ? { finished: tasksFinished, refused: unsafeRefused, cuts: linksCut } : was;
    const dares = this.board?.list() ?? [];
    const note = this.board?.note ?? null;
    if (changed || note !== this.current.note || JSON.stringify(dares) !== JSON.stringify(this.current.dares)) this.update({ counters, dares, note });
  }

  private async finish() {
    this.silence();
    const ending = ++this.ending;
    const counters = this.current.counters;
    this.update({ phase: 'collecting', leftMs: 0 });
    let end: EndSummary;
    try {
      const input = await within(this.controller.collect(), COLLECT_WAIT_MS);
      end = summarize(input, { cuts: counters.cuts, raised: this.raised });
      await this.deps.save(input);
    } catch {
      end = summarizeLive(counters, this.raised.length);
    }
    if (ending === this.ending) this.closeRun(end);
  }

  private closeRun(end: EndSummary) {
    const { best, seed } = this.current;
    const newBest = end.recorded && (!best || end.stopped > best.score);
    const kept = newBest ? { score: end.stopped, seed: seed! } : best;
    if (newBest) this.deps.storeBest(kept!);
    this.update({ phase: 'ended', end, best: kept, newBest });
  }

  private abandon() {
    this.silence();
    this.update({ phase: 'idle', active: false, note: null });
  }

  private fail(failure: string) {
    this.silence();
    this.update({ phase: 'idle', active: false, failure });
  }

  private update(patch: Partial<PlaySnapshot>) {
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((fn) => fn());
  }
}
