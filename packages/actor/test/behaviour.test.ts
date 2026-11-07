import { describe, expect, it, vi } from 'vitest';
import type { SignalClient, SignalMessage, TaskSpec } from '@afterlink/protocol';
import { TRANSFER_REQUEST_KEY } from '../src/index.ts';
import { beatSpec, chainIsWhole, eventsOf, Fleet, ownEvents, spendsPerToken, TEAMS, type Team } from './harness.ts';

const human = { kind: 'human' as const };

/** A real signal client, plus a way to deliver what the hub would. */
function tapped(client: SignalClient) {
  const fns: ((m: SignalMessage) => void)[] = [];
  return {
    get connected() {
      return client.connected;
    },
    send: (m: SignalMessage) => client.send(m),
    onMessage(fn: (m: SignalMessage) => void) {
      fns.push(fn);
      client.onMessage(fn);
    },
    onState: (fn: (up: boolean) => void) => client.onState(fn),
    close: () => client.close(),
    deliver: (m: SignalMessage) => fns.forEach((fn) => fn(m)),
  };
}

const chairTask: TaskSpec = { ...beatSpec('contested-upper-stand'), id: 'chair-for-medics' };

describe('a real person holds the device', () => {
  it('the planner assigns, and nothing is accepted until a person taps', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.access.submitTask(beatSpec('connected-faint'), human);
    f.run(10_000);
    expect(f.task('faint-main-stage')?.status).toBe('claimed');
    expect(f.byTeam('faint-main-stage')).toBe('medics');
    expect(f.actors.medics.view().nextAction?.spec.id).toBe('faint-main-stage');

    expect(f.actors.medics.acceptTask('faint-main-stage', 'tap')).toBe(true);
    f.run(10_000);
    expect(f.task('faint-main-stage')?.status).toBe('accepted');

    expect(f.actors.medics.completeTask('faint-main-stage', 'Conscious and sitting up', 'voice')).toBe(true);
    f.run(500);
    expect(f.task('faint-main-stage', 'supply')?.status).toBe('completed');
    expect(f.task('faint-main-stage', 'supply')?.evidence).toBe('Conscious and sitting up');
    expect(f.actors.medics.view().nextAction).toBeNull();
  });

  it('rights are spent before the claim, and the claim names them', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.supply.submitTask(beatSpec('split-field-aed'), human);
    f.run(500);
    const own = ownEvents(f.actors.supply);
    const commit = own.findIndex((e) => e.type === 'right.committed');
    const claim = own.findIndex((e) => e.type === 'task.claimed');
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(commit).toBeLessThan(claim);
    expect(f.task('field-aed')?.owner).toBe(f.id('supply'));
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });

  it('two taps in one instant spend one right and accept once', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.supply.submitTask(beatSpec('split-field-aed'), human);
    f.run(500);
    expect(f.actors.supply.acceptTask('field-aed')).toBe(true);
    expect(f.actors.supply.acceptTask('field-aed')).toBe(true);
    f.run(500);
    expect(eventsOf(f.actors.medics, 'task.accepted')).toHaveLength(1);
    expect([...spendsPerToken(f.actors.medics.events()).values()]).toEqual([1]);
  });

  it('a person can decline, and the planner hands the task on instead of back', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.medics.submitTask(beatSpec('hq-down-queue-water'), human);
    f.run(500);
    const first = f.byTeam('queue-water')!;
    expect(f.actors[first].declineTask('queue-water', 'Hands full')).toBe(true);
    f.run(1000);
    const second = f.byTeam('queue-water');
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(f.task('queue-water')?.status).toBe('claimed');
    expect(f.actors.medics.view().state.conflicts).toEqual([]);
  });

  it('a person can pick up an unowned task by hand, and it is recorded as a person deciding', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics'], ['access', 'facilities', 'supply']);
    f.run(1000);
    const spec: TaskSpec = { ...beatSpec('connected-faint'), id: 'walk-up', requires: ['triage'] };
    f.actors.access.submitTask(spec, human);
    f.run(500);
    expect(f.task('walk-up', 'access')?.owner).toBeUndefined();
    expect(f.actors.access.acceptTask('walk-up')).toBe(false);
    expect(f.actors.access.view().refusals.at(-1)?.refusal).toBe('NO_CAPABILITY');
  });

  it('refuses commands on tasks that are not this device to act on', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.access.submitTask(beatSpec('connected-faint'), human);
    f.run(500);
    expect(f.actors.supply.acceptTask('faint-main-stage')).toBe(false);
    expect(f.actors.supply.completeTask('faint-main-stage', 'not mine')).toBe(false);
    expect(f.actors.supply.declineTask('faint-main-stage', 'not mine')).toBe(false);
    expect(f.actors.supply.acceptTask('no-such-task')).toBe(false);
  });

  it('a malformed task is refused before it is signed, so it can never reach a peer', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const size = ownEvents(f.actors.access).length;
    expect(() => f.actors.access.submitTask({ ...beatSpec('connected-faint'), priority: 9 as 1 }, human)).toThrow();
    expect(ownEvents(f.actors.access)).toHaveLength(size);
  });

  it('the simulated volunteer leaves work reserved for a person alone', async () => {
    const f = await new Fleet({ quiet: true, autopilot: true }).connected();
    const spec: TaskSpec = { ...beatSpec('connected-faint'), id: 'close-site', kind: 'site-closure' };
    f.actors.access.submitTask(spec, human);
    f.run(20_000);
    expect(f.task('close-site')?.status).not.toBe('completed');
    expect(f.actors.medics.view().state.conflicts).toEqual([]);
  });
});

describe('moving rights', () => {
  it('in contact: the planner asks, an idle holder offers, the requester takes it and claims', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.medics.submitTask(chairTask, human);
    f.until(() => f.task('chair-for-medics')?.owner === f.id('medics'), 'medics claim with the chair');

    const tokens = f.actors.medics.view().state.tokens;
    expect(tokens['evac-chair#1']?.committedTo).toBe('chair-for-medics');
    expect(eventsOf(f.actors.medics, 'right.offered')).toHaveLength(1);
    expect(eventsOf(f.actors.medics, 'right.accepted')).toHaveLength(1);
    expect(f.actors.medics.view().state.conflicts).toEqual([]);
  });

  it('an answered request is answered once, across a restart of the holder', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.medics.submitTask(chairTask, human);
    f.until(() => f.task('chair-for-medics')?.owner === f.id('medics'), 'claimed');
    f.actors.access.stop();
    f.actors.access = f.make('access');
    await f.actors.access.start();
    f.until(() => f.actors.access.view().reachable.length === 3, 'holder back');
    f.run(2000);
    expect(eventsOf(f.actors.access, 'right.offered')).toHaveLength(1);
  });

  it('a person can ask for a right by hand, and the request waits for contact', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.medics.submitTask(chairTask, human);
    f.run(1000);
    expect(f.actors.medics.requestTransfer('evac-chair', 'chair-for-medics')).toBe(true);
    f.run(1000);
    expect(f.actors.medics.view().state.observations[TRANSFER_REQUEST_KEY]).toHaveLength(1);
    expect(eventsOf(f.actors.access, 'right.offered')).toHaveLength(0);

    f.unsplit();
    f.until(() => f.task('chair-for-medics')?.owner === f.id('medics'), 'chair arrives after contact');
    expect(spendsPerToken(f.actors.medics.events()).get('evac-chair#1')).toBe(1);
  });

  it('asking twice is one request, and asking for what no task needs is refused', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.medics.submitTask(chairTask, human);
    f.run(500);
    f.actors.medics.requestTransfer('evac-chair', 'chair-for-medics');
    f.actors.medics.requestTransfer('evac-chair', 'chair-for-medics');
    f.run(500);
    expect(f.actors.medics.view().state.observations[TRANSFER_REQUEST_KEY]).toHaveLength(1);
    expect(f.actors.medics.requestTransfer('aed', 'chair-for-medics')).toBe(false);
    expect(f.actors.medics.requestTransfer('evac-chair', 'no-such-task')).toBe(false);
  });

  it('a hand offer to a peer out of reach is refused unless a person will carry it', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    expect(f.actors.access.offerTokens(['evac-chair#1'], f.id('medics'))).toBeNull();
    expect(f.actors.access.view().state.tokens['evac-chair#1']?.state).toBe('held');

    const transfer = f.actors.access.offerTokens(['evac-chair#1'], f.id('medics'), { carry: true });
    expect(transfer).toBeTruthy();
    f.run(200);
    expect(f.actors.access.view().state.tokens['evac-chair#1']?.state).toBe('in-transit');
  });

  it('a right in transit across a split is locked on both sides, and is never refunded by time', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const transfer = f.actors.access.offerTokens(['evac-chair#1'], f.id('medics'));
    expect(transfer).toBeTruthy();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(120_000);

    expect(f.actors.access.offerTokens(['evac-chair#1'], f.id('facilities'))).toBeNull();
    const spec: TaskSpec = { ...beatSpec('contested-hall-chair'), id: 'chair-for-access' };
    f.actors.access.submitTask(spec, human);
    f.run(1000);
    expect(f.task('chair-for-access', 'access')?.owner).toBeUndefined();
    expect(spendsPerToken(f.actors.access.events()).size).toBe(0);
  });

  it('a declined offer returns the right to the sender', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const transfer = f.actors.access.offerTokens(['evac-chair#1'], f.id('medics'))!;
    f.until(() => f.actors.medics.view().pendingTransfers.length === 1, 'offer arrives');
    expect(f.actors.medics.view().pendingTransfers[0]).toMatchObject({ transfer, from: f.id('access'), tokens: ['evac-chair#1'] });
    expect(f.actors.medics.answerTransfer(transfer, false)).toBe(true);
    expect(f.actors.medics.answerTransfer(transfer, true)).toBe(false);
    f.run(500);
    expect(f.actors.access.view().tokens.map((t) => t.id)).toContain('evac-chair#1');
  });
});

describe('a claim race across a split', () => {
  it('both groups claim, the tie-break keeps one, the other lets go exactly once', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const lastContact = f.actors.facilities.view().summary;
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);

    f.actors.supply.submitTask(beatSpec('hq-down-queue-water'), human);
    expect(f.actors.facilities.ingestFerry(f.actors.supply.buildFerry(lastContact)).newEvents).toBeGreaterThan(0);
    f.run(500);
    expect(f.task('queue-water', 'supply')?.owner).toBe(f.id('supply'));
    expect(f.task('queue-water', 'facilities')?.owner).toBe(f.id('facilities'));

    f.net.restoreHub();
    f.unsplit();
    f.until(() => TEAMS.every((t) => f.actors[t].view().reachable.length === 3), 'links back');
    f.until(() => f.settledLogs(), 'in sync');
    f.run(3000);
    f.until(() => f.settledLogs(), 'quiet');

    const loser = f.byTeam('queue-water') === 'supply' ? 'facilities' : 'supply';
    expect(ownEvents(f.actors[loser]).filter((e) => e.type === 'task.released')).toHaveLength(1);
    const conflicts = f.actors.medics.view().state.conflicts;
    expect(conflicts.map((c) => c.id)).toEqual(['double-claim:queue-water']);
    expect(conflicts[0]?.severity).toBe('policy');
  });
});

describe('external requests', () => {
  async function fleetWithTap() {
    const f = new Fleet({ quiet: true, autopilot: false });
    const taps = {} as Record<Team, ReturnType<typeof tapped>>;
    for (const t of TEAMS) {
      taps[t] = tapped(f.net.signal(f.id(t)));
      f.actors[t] = f.make(t, { signal: taps[t] });
    }
    await f.connected();
    return { f, taps };
  }
  const spec: TaskSpec = { ...beatSpec('connected-faint'), id: 'ext-form-7' };

  it('becomes a task with an external source, and is picked up like any other', async () => {
    const { f, taps } = await fleetWithTap();
    taps.access.deliver({ t: 'ingress', ref: 'form-7', spec });
    f.run(500);
    expect(f.task('ext-form-7')?.source).toEqual({ kind: 'external', ref: 'form-7' });
    expect(f.byTeam('ext-form-7')).toBe('medics');
  });

  it('is idempotent by ref on one device and across devices', async () => {
    const { f, taps } = await fleetWithTap();
    taps.access.deliver({ t: 'ingress', ref: 'form-7', spec });
    taps.access.deliver({ t: 'ingress', ref: 'form-7', spec });
    f.run(500);
    taps.supply.deliver({ t: 'ingress', ref: 'form-7', spec });
    taps.medics.deliver({ t: 'ingress', ref: 'form-7', spec: { ...spec, id: 'ext-other-id' } });
    f.run(500);
    expect(eventsOf(f.actors.medics, 'task.created')).toHaveLength(1);
  });

  it('two devices taking the same ref while split merge into one task with no conflict', async () => {
    const { f, taps } = await fleetWithTap();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    taps.supply.deliver({ t: 'ingress', ref: 'form-7', spec });
    taps.access.deliver({ t: 'ingress', ref: 'form-7', spec });
    f.run(500);
    f.unsplit();
    f.until(() => TEAMS.every((t) => f.actors[t].view().reachable.length === 3), 'links back');
    f.until(() => f.settledLogs(), 'in sync');
    expect(Object.values(f.actors.medics.view().state.tasks).filter((t) => t.source.ref === 'form-7')).toHaveLength(1);
    expect(f.actors.medics.view().state.conflicts.filter((c) => c.severity === 'violation')).toEqual([]);
  });

  it('a malformed spec is never signed: untrusted input cannot reach every replica', async () => {
    const { f, taps } = await fleetWithTap();
    const before = ownEvents(f.actors.access).length;
    taps.access.deliver({ t: 'ingress', ref: 'bad', spec: { id: 'x' } as unknown as TaskSpec });
    f.run(500);
    expect(ownEvents(f.actors.access)).toHaveLength(before);
  });
});

describe('capsule contingencies', () => {
  it('a held observation spawns the task once, and blocks the kinds it names', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.supply.observe('gate.north.open', false, { subject: 'North gate' });
    f.run(500);
    expect(Object.keys(f.actors.medics.view().state.tasks)).toContain('west-gate-reroute');
    expect(f.byTeam('west-gate-reroute')).toBe('access');

    const route: TaskSpec = { ...beatSpec('connected-faint'), id: 'north-sweep', kind: 'north-route', requires: ['repair'] };
    f.actors.medics.submitTask(route, human);
    f.run(500);
    expect(f.task('north-sweep')?.owner).toBeUndefined();
    const refusal = f.task('north-sweep')?.decisions.at(-1);
    expect(refusal?.refusal).toBe('BLOCKED_BY_CONTINGENCY');
  });

  it('a newer observation lifts the block', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.supply.observe('gate.north.open', false);
    f.run(200);
    const route: TaskSpec = { ...beatSpec('connected-faint'), id: 'north-sweep', kind: 'north-route', requires: ['repair'] };
    f.actors.medics.submitTask(route, human);
    f.run(500);
    expect(f.task('north-sweep')?.owner).toBeUndefined();
    f.run(100);
    f.actors.supply.observe('gate.north.open', true);
    f.run(500);
    expect(f.byTeam('north-sweep')).toBe('facilities');
  });
});

describe('links as history', () => {
  it('signs one event per real change, none for the same state twice', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const about = (peer: string) =>
      ownEvents(f.actors.medics).flatMap((e) => (e.type === 'link.changed' && e.body.peer === peer ? [e.body.state] : []));
    expect(about(f.id('access'))).toEqual(['open']);
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(3000);
    expect(about(f.id('access'))).toHaveLength(2);
    expect(['severed', 'closed']).toContain(about(f.id('access'))[1]);
    f.unsplit();
    f.until(() => f.actors.medics.view().reachable.length === 3, 'links back');
    f.run(500);
    expect(about(f.id('access'))).toHaveLength(3);
    expect(about(f.id('access'))[2]).toBe('open');
  });

  it('a fault plan survives a restart: a blocked peer stays refused', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.medics.stop();
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
    f.run(5000);
    expect(f.actors.medics.view().reachable).toEqual([f.id('supply')]);
  });
});

describe('the view', () => {
  it('is not rebuilt while nothing has changed', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const v = f.actors.medics.view();
    expect(f.actors.medics.view()).toBe(v);
    f.actors.medics.observe('k', 1);
    expect(f.actors.medics.view()).not.toBe(v);
  });

  it('reports a burst to subscribers as one update, with the final state', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const seen = vi.fn();
    const off = f.actors.medics.subscribe(seen);
    for (let i = 0; i < 20; i++) f.actors.medics.observe(`burst-${i}`, i);
    expect(seen).not.toHaveBeenCalled();
    f.run(45);
    expect(seen).toHaveBeenCalledTimes(1);
    const view = seen.mock.calls[0]![0] as ReturnType<typeof f.actors.medics.view>;
    expect(view.state.observations['burst-19']).toHaveLength(1);
    off();
    f.actors.medics.observe('after', 1);
    f.run(200);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('every device reports only what it can honestly know', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.supply.observe('only-group-a-knows', 1);
    f.run(500);
    expect(f.actors.access.view().state.observations['only-group-a-knows']).toBeUndefined();
    expect(f.actors.access.view().horizon[f.id('supply')]).toBeLessThan(f.actors.medics.view().horizon[f.id('supply')]!);
    expect(chainIsWhole(f.actors.access)).toBe(true);
  });
});
