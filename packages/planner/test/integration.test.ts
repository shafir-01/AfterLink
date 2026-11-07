import { beforeEach, describe, expect, it } from 'vitest';
import { canCommit, conservation, findTokens } from '@afterlink/authority';
import { festivalCapsule, provision, reduce, scenarioBeats, scenarioSplit } from '@afterlink/mission';
import { Author, EventLog, generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, DecisionRecord, MissionState, ProvisionBundle, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';
import { plan, type PlannerAction } from '../src/index.ts';

const T0 = 1_800_000_000_000;

class Device {
  readonly id: ActorId;
  readonly team: TeamId;
  readonly log: EventLog;
  readonly author: Author;
  readonly heard: Record<ActorId, number> = {};

  constructor(readonly bundle: ProvisionBundle) {
    this.id = bundle.actor.publicKey;
    this.team = bundle.team;
    this.log = new EventLog(bundle.genesis.mission);
    this.log.ingest(bundle.genesis as AnyEvent);
    this.author = new Author(bundle.actor, this.log);
  }

  state(): MissionState {
    return reduce(this.log.all(), this.bundle.roster);
  }

  horizon(): Record<ActorId, number> {
    return Object.fromEntries(Object.entries(this.log.summary().heads).map(([actor, head]) => [actor, head.seq]));
  }
}

/** Four independent replicas, each with its own log and its own reducer, joined only by `sync`. */
class Field {
  clock = T0;
  readonly devices: Device[];
  groups: Device[][];

  constructor() {
    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer, { now: T0 });
    const { bundles } = provision(capsule, issuer, 'room');
    this.devices = Object.values(bundles).map((b) => new Device(b));
    this.groups = [this.devices];
    this.sync();
  }

  by(team: TeamId): Device {
    return this.devices.find((d) => d.team === team)!;
  }

  split(a: TeamId[], b: TeamId[]): void {
    this.groups = [a.map((t) => this.by(t)), b.map((t) => this.by(t))];
  }

  heal(): void {
    this.groups = [this.devices];
    this.sync();
  }

  groupOf(d: Device): Device[] {
    return this.groups.find((g) => g.includes(d))!;
  }

  sync(): void {
    for (const group of this.groups) {
      const all = group.flatMap((d) => d.log.all());
      for (const d of group) {
        d.log.ingestMany(all);
        for (const peer of group) d.heard[peer.id] = this.clock;
      }
    }
  }

  planFor(d: Device): PlannerAction[] {
    const reachable = this.groupOf(d).filter((p) => p !== d).map((p) => p.id);
    return plan({ self: d.id, state: d.state(), reachable, now: this.clock, horizon: d.horizon(), lastHeard: { ...d.heard } });
  }

  perform(d: Device, actions: PlannerAction[]): void {
    for (const a of actions) {
      if (a.type === 'claim') d.author.emit('task.claimed', { taskId: a.taskId, decision: a.decision }, this.clock);
      if (a.type === 'cover') d.author.emit('task.covered', { taskId: a.taskId, decision: a.decision }, this.clock);
      if (a.type === 'refuse') d.author.emit('task.refused', { taskId: a.taskId, decision: a.decision }, this.clock);
      if (a.type === 'defer') d.author.emit('task.deferred', { taskId: a.taskId, decision: a.decision }, this.clock);
      if (a.type === 'release') d.author.emit('task.released', { taskId: a.taskId, reason: a.reason }, this.clock);
    }
  }

  /** One decision pass on every device, then peers in contact exchange what they have. */
  tick(): PlannerAction[] {
    const all: PlannerAction[] = [];
    for (const d of this.devices) {
      const actions = this.planFor(d);
      this.perform(d, actions);
      all.push(...actions);
    }
    this.sync();
    return all;
  }

  /** A person on this device commits the rights, starts, and finishes one piece of their work. */
  work(d: Device, taskId: TaskId): void {
    const state = d.state();
    const { spec } = state.tasks[taskId]!;
    const tokens = spec.needs.flatMap((n) => findTokens(state, d.id, n.resource, n.count));
    if (tokens.length) {
      expect(canCommit(state, d.id, tokens)).toEqual({ ok: true });
      d.author.emit('right.committed', { tokens, taskId }, this.clock);
    }
    d.author.emit('task.accepted', { taskId, via: 'tap' }, this.clock);
    d.author.emit('task.completed', { taskId, evidence: 'done', via: 'tap' }, this.clock);
  }

  submit(d: Device, spec: TaskSpec): void {
    d.author.emit('task.created', { spec, source: { kind: 'human' } }, this.clock);
    this.sync();
  }

  all(): AnyEvent[] {
    return this.devices.flatMap((d) => d.log.all());
  }
}

function beat(taskId: TaskId): TaskSpec {
  return scenarioBeats.find((b) => b.spec?.id === taskId)!.spec!;
}

function violations(state: MissionState): string[] {
  return state.conflicts.filter((c) => c.severity === 'violation').map((c) => c.summary);
}

function decisionsOf(state: MissionState, taskId: TaskId, actor?: ActorId): DecisionRecord[] {
  return state.tasks[taskId]!.decisions.filter((d) => !actor || d.actor === actor);
}

function haulTask(id: TaskId, priority: 1 | 2 | 3 = 2): TaskSpec {
  return { ...beat('queue-water'), id, priority };
}

describe('against the real reducer and ledger', () => {
  let field: Field;
  beforeEach(() => {
    field = new Field();
  });

  it('plays the whole capsule through with no leader and no violation', () => {
    for (let round = 0; round < 30; round++) {
      field.tick();
      for (const d of field.devices) {
        const state = d.state();
        const mine = Object.values(state.tasks).filter((t) => t.owner === d.id && (t.status === 'claimed' || t.status === 'accepted'));
        for (const t of mine) field.work(d, t.spec.id);
      }
      field.clock += 1_000;
      field.sync();
    }
    const state = field.devices[0]!.state();
    expect(Object.values(state.tasks).map((t) => t.status)).toEqual(state.capsule!.tasks.map(() => 'completed'));
    expect(violations(state)).toEqual([]);
    expect(state.conflicts).toEqual([]);

    const said = field.devices[0]!.log.all().flatMap((e) => (e.type === 'task.refused' || e.type === 'task.deferred' ? [e.body.decision] : []));
    const verdicts = said.map((d) => `${d.actor}|${d.taskId}|${d.refusal}|${d.next?.join()}`);
    expect(new Set(verdicts).size).toBe(verdicts.length);
  });

  it('every device computes the same assignment, and claims only its own row', () => {
    const actions = field.devices.flatMap((d) => field.planFor(d).filter((a) => a.type === 'claim'));
    const tasks = actions.map((a) => (a as { taskId: TaskId }).taskId);
    expect(new Set(tasks).size).toBe(tasks.length);
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('goes quiet: no events at all once there is nothing new to say', () => {
    for (let i = 0; i < 4; i++) field.tick();
    const size = field.devices[0]!.log.size;
    for (let i = 0; i < 10; i++) {
      field.clock += 1_000;
      expect(field.tick()).toEqual([]);
    }
    expect(field.devices[0]!.log.size).toBe(size);
  });

  it('refuses the contested chair across the split, and never double allocates it', () => {
    field.tick();
    field.split(scenarioSplit.a, scenarioSplit.b);
    const medics = field.by('medics');
    const access = field.by('access');
    field.submit(medics, beat('upper-stand-carry'));
    field.submit(access, beat('hall-chair'));
    field.tick();

    const refused = decisionsOf(medics.state(), 'upper-stand-carry', medics.id);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      outcome: 'REFUSED',
      refusal: 'NO_RIGHT',
      reason: 'Cannot start: Access holds the evacuation chair and cannot be reached.',
    });
    expect(refused[0]!.next).toEqual(expect.arrayContaining(['CARRY_UPDATE', 'WAIT_FOR_CONTACT', 'SUBSTITUTE']));

    const claimed = decisionsOf(access.state(), 'hall-chair', access.id);
    expect(claimed[0]).toMatchObject({ outcome: 'ACCEPTED', tokens: ['evac-chair#1'] });
    expect(claimed[0]!.reason).toBe('Assigned to Access: only team here with mobility, and you hold the evacuation chair.');
    field.work(access, 'hall-chair');

    field.clock += 5_000;
    field.heal();
    field.tick();
    const state = medics.state();
    expect(state.tokens['evac-chair#1']).toMatchObject({ state: 'committed', committedTo: 'hall-chair' });
    expect(conservation(state).every((c) => c.ok)).toBe(true);
    expect(violations(state)).toEqual([]);
    expect(decisionsOf(state, 'upper-stand-carry', medics.id).at(-1)).toMatchObject({ refusal: 'NO_RIGHT', next: ['SUBSTITUTE', 'ESCALATE'] });
    expect(state.tasks['upper-stand-carry']?.owner).toBeUndefined();
  });

  it('settles a claim race from both sides of a split, and the loser lets go once', () => {
    for (let i = 0; i < 3; i++) field.tick();
    field.submit(field.by('medics'), haulTask('race'));
    field.split(['medics', 'supply'], ['access', 'facilities']);
    field.tick();

    const supply = field.by('supply');
    const facilities = field.by('facilities');
    expect(supply.state().tasks.race?.owner).toBe(supply.id);
    expect(facilities.state().tasks.race?.owner).toBe(facilities.id);

    field.heal();
    const winner = supply.state().tasks.race!.owner!;
    const loser = winner === supply.id ? facilities : supply;
    expect(field.tick().filter((a) => a.type === 'release')).toHaveLength(1);
    expect(field.tick()).toEqual([]);

    const state = loser.state();
    expect(state.tasks.race?.owner).toBe(winner);
    expect(state.conflicts.map((c) => c.kind)).toEqual(['double-claim']);
    expect(violations(state)).toEqual([]);
    expect(decisionsOf(state, 'race', loser.id).at(-1)).toMatchObject({ outcome: 'UNKNOWN', policy: 'task.released' });
  });

  it('covers urgent work across a split, and keeps both records as a policy conflict', () => {
    for (let i = 0; i < 3; i++) field.tick();
    field.submit(field.by('medics'), beat('queue-water'));
    field.tick();
    const owner = field.devices[0]!.state().tasks['queue-water']!.owner!;
    const holder = field.devices.find((d) => d.id === owner)!;
    const other = field.by(holder.team === 'supply' ? 'facilities' : 'supply');

    const { coverAfterMs } = holder.state().capsule!.fallback;
    field.split(['medics', 'supply'], ['access', 'facilities']);
    field.clock += coverAfterMs - 1_000;
    expect(field.tick().filter((a) => a.type === 'cover')).toEqual([]);

    field.clock += 2_000;
    const covers = field.tick().filter((a) => a.type === 'cover');
    expect(covers).toHaveLength(1);
    expect(covers[0]).toMatchObject({ taskId: 'queue-water' });
    expect(other.state().tasks['queue-water']?.coveredBy).toEqual([other.id]);
    expect(field.tick()).toEqual([]);

    field.work(holder, 'queue-water');
    field.work(other, 'queue-water');
    field.heal();
    const state = holder.state();
    expect(state.tasks['queue-water']?.status).toBe('completed');
    expect(state.conflicts.map((c) => [c.kind, c.severity])).toEqual([['duplicate-effort', 'policy']]);
  });

  it('turns a request into a real transfer, then a claim the ledger accepts', () => {
    const spec: TaskSpec = { ...beat('upper-stand-carry'), id: 'carry' };
    const medics = field.by('medics');
    const access = field.by('access');
    for (let i = 0; i < 3; i++) field.tick();
    field.submit(medics, spec);

    const asked = field.tick();
    expect(asked.filter((a) => a.type === 'request-transfer')).toMatchObject([{ resource: 'evac-chair', from: access.id, count: 1 }]);
    expect(field.tick()).toEqual([]);

    access.author.emit('right.offered', { transfer: 'x1', tokens: ['evac-chair#1'], to: medics.id }, field.clock);
    field.sync();
    const moving = field.tick();
    expect(moving.filter((a) => a.type === 'refuse')).toMatchObject([{ decision: { refusal: 'TOKEN_IN_TRANSIT' } }]);

    medics.author.emit('right.accepted', { transfer: 'x1' }, field.clock);
    field.sync();
    expect(field.tick().filter((a) => a.type === 'claim')).toMatchObject([{ taskId: 'carry', tokens: ['evac-chair#1'] }]);
    field.work(medics, 'carry');
    field.sync();

    const state = medics.state();
    expect(state.tasks.carry?.status).toBe('completed');
    expect(violations(state)).toEqual([]);
    expect(conservation(state).every((c) => c.ok)).toBe(true);
  });

  it('never spends one right twice between claiming and starting', () => {
    for (let i = 0; i < 3; i++) field.tick();
    const access = field.by('access');
    const spec = beat('hall-chair');
    field.submit(access, { ...spec, id: 'first' });
    field.tick();
    field.submit(access, { ...spec, id: 'second' });
    const actions = field.tick();
    expect(actions.filter((a) => a.type === 'claim')).toEqual([]);
    expect(actions.filter((a) => a.type === 'refuse')).toMatchObject([{ taskId: 'second', decision: { refusal: 'NO_RIGHT' } }]);
    expect(access.state().tasks.first?.owner).toBe(access.id);
  });

  it('hands a declined task to the next best team, not back to the one who let it go', () => {
    for (let i = 0; i < 3; i++) field.tick();
    field.submit(field.by('medics'), haulTask('heavy'));
    field.tick();
    const first = field.devices.find((d) => d.id === d.state().tasks.heavy?.owner)!;
    first.author.emit('task.released', { taskId: 'heavy', reason: 'Our hands are full.' }, field.clock);
    field.sync();
    field.tick();

    const state = first.state();
    const next = field.by(first.team === 'supply' ? 'facilities' : 'supply');
    expect(state.tasks.heavy?.owner).toBe(next.id);
    expect(violations(state)).toEqual([]);
    expect(field.tick()).toEqual([]);
  });

  it('waits for a person on reserved work, then leaves their decision alone', () => {
    for (let i = 0; i < 3; i++) field.tick();
    const closure: TaskSpec = { ...beat('faint-main-stage'), id: 'close-site', kind: 'site-closure' };
    const medics = field.by('medics');
    field.submit(medics, closure);
    const refusals = field.tick().filter((a) => a.type === 'refuse');
    expect(refusals).toMatchObject([{ taskId: 'close-site', decision: { refusal: 'HUMAN_APPROVAL_REQUIRED', next: ['ESCALATE'] } }]);
    expect(field.tick()).toEqual([]);

    const decision = { ...decisionsOf(medics.state(), 'close-site')[0]!, id: 'by-hand', outcome: 'ACCEPTED' as const, policy: 'human-initiative', reason: 'Taken by hand.' };
    medics.author.emit('task.claimed', { taskId: 'close-site', decision }, field.clock);
    medics.author.emit('task.accepted', { taskId: 'close-site', via: 'tap' }, field.clock);
    field.sync();
    expect(field.tick()).toEqual([]);
    const state = medics.state();
    expect(state.tasks['close-site']).toMatchObject({ status: 'accepted', owner: medics.id });
    expect(violations(state)).toEqual([]);
  });

  it('every replica agrees on the outcome once all events meet', () => {
    field.split(['medics', 'supply'], ['access', 'facilities']);
    field.tick();
    field.tick();
    field.heal();
    for (let i = 0; i < 3; i++) field.tick();
    const states = field.devices.map((d) => d.state());
    const owners = states.map((s) => Object.fromEntries(Object.values(s.tasks).map((t) => [t.spec.id, [t.status, t.owner]])));
    for (const view of owners) expect(view).toEqual(owners[0]);
    expect(violations(states[0]!)).toEqual([]);
    expect(field.all().length).toBeGreaterThan(0);
  });
});
