import type { ActorId, Capability, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';
import type { StageState } from '../stage/contract';
import type { PlayController } from './contract';
import { PLACES, type PlaceId } from './incidents';
import { CHAIR } from './score';

export type DareId = 'chair' | 'isolate' | 'hq';

/** open: untried. armed: waiting for the player's move. testing: the real outcome is landing. done: it failed, for a reason. */
export type DareStatus = 'open' | 'armed' | 'testing' | 'done';

export interface Dare {
  id: DareId;
  label: string;
  status: DareStatus;
  /** What really happened. */
  outcome: string | null;
  /** Why the attempt to break it failed, in one line. */
  why: string | null;
}

interface Verdict {
  outcome: string;
  why: string;
}

const LONE_TEAM: TeamId = 'medics';

const nameOf = (state: StageState, actor: ActorId | null | undefined) => state.devices.find((d) => d.id === actor)?.name ?? 'A team';
const plain = (reason: string) => {
  const text = reason.replace(/^Cannot start:\s*/, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function chairTaken(state: StageState): { taskId: TaskId; holder: ActorId | null } | null {
  for (const device of state.devices) {
    const token = device.view?.tokens.find((t) => t.resource === CHAIR && t.committedTo);
    if (token) return { taskId: token.committedTo!, holder: token.holder };
  }
  return null;
}

/** Two requests for the one chair, and a decision on each. Reads the devices' own reports. */
export function chairVerdict(state: StageState): Verdict | null {
  const asked = new Set(state.truth.tasks.filter((t) => t.needs.some((n) => n.resource === CHAIR)).map((t) => t.id));
  if (asked.size < 2) return null;
  const taken = chairTaken(state);
  const refusals = state.devices
    .flatMap((d) => d.decisions)
    .filter((d) => asked.has(d.taskId) && d.taskId !== taken?.taskId && (d.refusal === 'NO_RIGHT' || d.refusal === 'TOKEN_IN_TRANSIT') && !d.next?.includes('REQUEST_TRANSFER'));
  const first = refusals[0];
  if (!first) return null;
  if (taken) return { outcome: `${nameOf(state, taken.holder)} got the chair. ${nameOf(state, first.actor)} refused.`, why: plain(first.reason) };
  return new Set(refusals.map((d) => d.taskId)).size >= 2 ? { outcome: 'Both sides refused.', why: plain(first.reason) } : null;
}

export function isAlone(state: StageState, team: TeamId): boolean {
  const id = state.devices.find((d) => d.team === team)?.id;
  return !!id && state.groups.some((g) => g.length === 1 && g[0] === id);
}

/** Something is on its way between two teams: a carried update, or a right nobody holds yet. */
export function inFlight(state: StageState): 'carry' | 'right' | null {
  const phase = state.carry?.phase;
  if (phase && phase !== 'done' && phase !== 'failed') return 'carry';
  return state.devices.some((d) => d.view?.tokens.some((t) => t.state === 'in-transit')) ? 'right' : null;
}

function chairSpec(id: TaskId, title: string, brief: string, place: PlaceId, requires: Capability[]): TaskSpec {
  const { name, at } = PLACES[place];
  return { id, kind: 'evacuation', title, brief, objective: 'safety', priority: 1, location: at, locationName: name, requires, needs: [{ resource: CHAIR, count: 1 }], dependsOn: [], reversible: false };
}

function loneSpec(id: TaskId): TaskSpec {
  const { name, at } = PLACES.firstAidPost;
  return { id, kind: 'medical', title: 'Strap a sprained wrist', brief: 'A volunteer has sprained a wrist at the first aid post. Strap it up.', objective: 'safety', priority: 2, location: at, locationName: name, requires: ['first-aid'], needs: [], dependsOn: [], reversible: true };
}

const fresh = (id: DareId, label: string): Dare => ({ id, label, status: 'open', outcome: null, why: null });

/** Each dare is armed by the player and judged only from what the devices report back. */
export class DareBoard {
  note: string | null = null;
  private readonly chair = fresh('chair', 'Promise the chair twice');
  private readonly isolate = fresh('isolate', 'Isolate Medics');
  private readonly hq = fresh('hq', 'Kill HQ during a transfer');
  private loneTask: TaskId | null = null;
  private attempts = 0;
  private hqWasAlive = true;
  private carrying: 'carry' | 'right' | null = null;
  private carryAsked = false;
  private carrySeen = false;

  constructor(
    private readonly controller: PlayController,
    private readonly seed: string,
  ) {}

  list(): Dare[] {
    return [this.chair, this.isolate, this.hq].map((d) => ({ ...d }));
  }

  arm(id: DareId) {
    const dare = { chair: this.chair, isolate: this.isolate, hq: this.hq }[id];
    if (dare.status !== 'open') return;
    dare.status = 'armed';
    const state = this.controller.snapshot();
    if (id === 'chair') this.note = 'Split the teams first.';
    if (id === 'isolate') this.note = 'Cut all three of their links.';
    if (id === 'hq') {
      this.carryAsked = false;
      this.carrySeen = false;
      if (!state.hq.alive) this.controller.reviveHq();
    }
    this.step(state);
  }

  step(state: StageState) {
    this.stepChair(state);
    this.stepIsolate(state);
    this.stepHq(state);
  }

  private settle(dare: Dare, verdict: Verdict) {
    dare.status = 'done';
    dare.outcome = verdict.outcome;
    dare.why = verdict.why;
    this.note = `${verdict.outcome} ${verdict.why}`;
  }

  private stepChair(state: StageState) {
    const dare = this.chair;
    if (dare.status === 'done') return;
    const verdict = chairVerdict(state);
    if (verdict) return this.settle(dare, verdict);
    if (dare.status === 'armed' && state.groups.length > 1 && this.askForChair(state)) {
      dare.status = 'testing';
      this.note = 'Both sides want the chair.';
    }
  }

  private askForChair(state: StageState): boolean {
    const token = state.truth.tokens.find((t) => t.resource === CHAIR);
    const near = state.devices.find((d) => d.team === token?.holderTeam);
    const nearGroup = state.groups.find((g) => g.includes(near?.id ?? ''));
    const far = state.devices.find((d) => !nearGroup?.includes(d.id));
    if (!near || !far) return false;
    const skill = (team: TeamId) => state.capsule?.teams.find((t) => t.id === team)?.capabilities.slice(0, 1) ?? [];
    const source = (id: TaskId) => ({ kind: 'human', ref: id }) as const;
    const stay = chairSpec(`dare-chair-${this.seed}-near`, 'Help a wheelchair user out of the sports hall', 'The sports hall lift has stopped. Use the evacuation chair.', 'sportsHall', skill(near.team));
    const reach = chairSpec(`dare-chair-${this.seed}-far`, 'Bring a visitor down from the upper stand', 'A visitor cannot manage the stairs. Bring the evacuation chair.', 'upperStand', skill(far.team));
    return this.controller.addTask(near.team, stay, source(stay.id)) && this.controller.addTask(far.team, reach, source(reach.id));
  }

  private stepIsolate(state: StageState) {
    const dare = this.isolate;
    if (dare.status === 'done') return;
    const alone = isAlone(state, LONE_TEAM);
    if (dare.status === 'testing') {
      const device = state.devices.find((d) => d.team === LONE_TEAM);
      const task = device?.view?.tasks.find((t) => t.id === this.loneTask);
      if (!alone) {
        dare.status = 'open';
        this.note = 'Back in contact. Cut them off again.';
      } else if (task?.status === 'completed') {
        this.settle(dare, { outcome: `${device!.name} finished a task alone.`, why: 'Every team carries the whole mission, so nobody has to ask.' });
      }
      return;
    }
    if (!alone) return;
    const id = `dare-alone-${this.seed}-${++this.attempts}`;
    if (!this.controller.addTask(LONE_TEAM, loneSpec(id), { kind: 'human', ref: id })) return;
    this.loneTask = id;
    dare.status = 'testing';
    this.note = 'Medics are on their own.';
  }

  private stepHq(state: StageState) {
    const dare = this.hq;
    const alive = state.hq.alive;
    const killed = this.hqWasAlive && !alive;
    this.hqWasAlive = alive;
    if (dare.status === 'done') return;

    if (dare.status === 'armed' && !this.carryAsked && alive) this.startCarry(state);
    const flight = inFlight(state);
    if (flight) this.carrySeen = true;

    if (dare.status === 'testing') {
      if (flight) return;
      if (this.carrying === 'carry' && state.carry?.phase === 'failed') {
        dare.status = 'open';
        this.note = 'The update failed its check. Nothing was applied.';
        return;
      }
      const moved = this.carrying === 'carry' ? 'The update arrived anyway.' : 'The handover finished anyway.';
      this.settle(dare, { outcome: moved, why: 'HQ only watches. Nothing depends on it.' });
      return;
    }

    if (killed && flight) {
      this.carrying = flight;
      dare.status = 'testing';
      this.note = 'HQ is dead. Watch the transfer.';
    } else if (dare.status === 'armed' && this.carrySeen && !flight) {
      dare.status = 'open';
      this.note = 'It arrived first. Try again.';
    }
  }

  private startCarry(state: StageState) {
    const [first, second] = state.groups.length > 1 ? [state.groups[0]?.[0], state.groups[1]?.[0]] : [state.devices[0]?.id, state.devices[1]?.id];
    this.carryAsked = true;
    if (first && second && this.controller.carry(first, second)) {
      this.note = 'Transfer under way. Kill HQ now.';
    } else {
      this.hq.status = 'open';
      this.note = 'No transfer could start. Try again.';
    }
  }
}
