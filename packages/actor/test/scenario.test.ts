import { beforeAll, describe, expect, it } from 'vitest';
import { conservation } from '@afterlink/authority';
import { scenarioBeats, scenarioSplit } from '@afterlink/mission';
import { canonicalize } from '@afterlink/protocol';
import type { SyncSummary } from '@afterlink/protocol';
import { buildMissionRecord, classify } from '@afterlink/reconcile';
import { beatSpec, chainIsWhole, eventsOf, Fleet, ownEvents, spendsPerToken, TEAMS, type Team } from './harness.ts';

/**
 * The product's central claim, run start to finish by four independent actors. Each step builds
 * on the one before, in the order the stage plays them.
 */
describe.sequential('the network disappears, the mission does not', () => {
  const groupA = scenarioSplit.a as Team[];
  const groupB = scenarioSplit.b as Team[];
  const human = { kind: 'human' as const };
  let f: Fleet;
  let waterOwner: Team;
  let waterCover: Team;
  let lastContact: SyncSummary;
  let seenByHqBeforeKill: number;
  const eventsAtRestart = new Map<string, number>();

  beforeAll(async () => {
    f = await new Fleet().connected();
  });

  it('four actors join once each and connect peer to peer', () => {
    for (const t of TEAMS) {
      const v = f.actors[t].view();
      expect(v.phase).toBe('ready');
      expect(v.reachable).toHaveLength(3);
      expect(v.signalUp).toBe(true);
      expect(eventsOf(f.actors[t], 'actor.joined')).toHaveLength(4);
    }
  });

  it('normal work: the capsule tasks are claimed by capable teams and finished', () => {
    const ids = f.capsule.tasks.map((t) => t.id);
    f.until(() => ids.every((id) => f.task(id)?.status === 'completed'), 'every capsule task completed');
    for (const id of ids) {
      const task = f.task(id)!;
      const team = f.capsule.teams.find((t) => t.id === f.byTeam(id));
      expect(task.spec.requires.every((c) => team?.capabilities.includes(c))).toBe(true);
    }
    const stocked = f.task('stock-first-aid')!;
    expect(f.actors.medics.view().state.tokens['cart#1']?.committedTo).toBe(stocked.spec.id);
  });

  it('normal work: a new request is picked up by the team that can do it', () => {
    f.actors.access.submitTask(beatSpec('connected-faint'), human);
    f.until(() => f.task('faint-main-stage')?.status === 'completed', 'faint handled');
    expect(f.byTeam('faint-main-stage')).toBe('medics');
  });

  it('the observer sees the mission while it is alive', () => {
    f.run(500);
    const seen = new Set(f.net.hubState()?.seen);
    expect(f.actors.medics.events().every((e) => seen.has(e.id))).toBe(true);
    seenByHqBeforeKill = seen.size;
    expect(f.actors.medics.view().hqSeen.length).toBeGreaterThan(0);
  });

  it('hub killed: signalling is gone, links stay, and work continues', () => {
    f.net.killHub();
    f.until(() => TEAMS.every((t) => !f.actors[t].view().signalUp), 'devices notice the hub is gone');
    for (const t of TEAMS) expect(f.actors[t].view().reachable).toHaveLength(3);

    f.actors.supply.submitTask(beatSpec('hq-down-quiet-tent'), human);
    f.until(() => f.task('guide-quiet-tent')?.status === 'completed', 'quiet tent handled after the kill');
    expect(f.byTeam('guide-quiet-tent')).toBe('access');
  });

  it('split: the links between the groups are really severed the moment the task is claimed', () => {
    f.actors.medics.submitTask(beatSpec('hq-down-queue-water'), human);
    f.until(() => !!f.task('queue-water')?.owner, 'queue water claimed');
    waterOwner = f.byTeam('queue-water')!;
    lastContact = f.actors.medics.view().summary;
    f.split(groupA, groupB);
    f.until(
      () => TEAMS.every((t) => f.actors[t].view().reachable.length === 1),
      'each device reaches only its own group',
    );
    expect(f.actors.medics.view().reachable).toEqual([f.id('supply')]);
    expect(f.actors.access.view().reachable).toEqual([f.id('facilities')]);
    expect(eventsOf(f.actors.medics, 'link.changed').some((e) => e.type === 'link.changed' && e.body.state !== 'open')).toBe(true);
  });

  it('both isolated groups accept new work with the rights they hold', () => {
    f.actors.supply.submitTask(beatSpec('split-field-aed'), human);
    f.actors.facilities.submitTask(beatSpec('split-hall-ramp'), human);
    f.until(() => f.task('field-aed', 'supply')?.status === 'completed', 'group A finishes its work');
    f.until(() => f.task('hall-ramp', 'facilities')?.status === 'completed', 'group B finishes its work');
    expect(f.task('hall-ramp', 'supply')).toBeUndefined();
    expect(f.task('field-aed', 'facilities')).toBeUndefined();
    expect(f.actors.supply.view().horizon).not.toEqual(f.actors.facilities.view().horizon);
  });

  it('reflexive replanning: the far group covers the work of an owner it lost', () => {
    waterCover = waterOwner === 'supply' ? 'facilities' : 'supply';
    f.until(() => f.task('queue-water', waterOwner)?.status === 'completed', 'owner finishes in its group');
    f.until(() => f.task('queue-water', waterCover)?.status === 'completed', 'far group covers and finishes');
    const covered = eventsOf(f.actors[waterCover], 'task.covered');
    expect(covered.map((e) => e.actor)).toEqual([f.id(waterCover)]);
  });

  it('refusal: an exclusive right held out of reach is refused with what to do next', () => {
    f.actors.medics.submitTask(beatSpec('contested-upper-stand'), human);
    f.until(() => f.actors.medics.view().refusals.some((d) => d.taskId === 'upper-stand-carry'), 'medics refused');
    const d = f.actors.medics.view().refusals.find((x) => x.taskId === 'upper-stand-carry')!;
    expect(d.refusal).toBe('NO_RIGHT');
    expect(d.next).toContain('CARRY_UPDATE');
    expect(d.reachable).toEqual([f.id('supply')]);
    expect(d.reason).toMatch(/Access/);
    expect(f.task('upper-stand-carry')?.owner).toBeUndefined();
  });

  it('valid allocation: the holder spends the same right in its own group, once', () => {
    f.actors.access.submitTask(beatSpec('contested-hall-chair'), human);
    f.until(() => f.task('hall-chair', 'access')?.status === 'completed', 'access uses the chair');
    expect(f.actors.access.view().state.tokens['evac-chair#1']?.committedTo).toBe('hall-chair');
    expect(spendsPerToken(f.actors.access.events()).get('evac-chair#1')).toBe(1);
    expect(spendsPerToken(f.actors.medics.events()).get('evac-chair#1')).toBeUndefined();
  });

  it('restart mid-partition: same identity, events and rights, no duplication', async () => {
    const before = f.actors.facilities;
    const stateBefore = canonicalize(before.view().state);
    const ownBefore = ownEvents(before).map((e) => e.id);
    const held = before.view().tokens.map((t) => t.id);
    for (const t of TEAMS) eventsAtRestart.set(t, f.actors[t].events().length);
    before.stop();

    f.actors.facilities = f.make('facilities');
    await f.actors.facilities.start();
    const after = f.actors.facilities;

    expect(after.id).toBe(before.id);
    expect(after.view().phase).toBe('ready');
    expect(canonicalize(after.view().state)).toBe(stateBefore);
    expect(after.view().tokens.map((t) => t.id)).toEqual(held);
    expect(ownEvents(after).map((e) => e.id)).toEqual(ownBefore);
    expect(chainIsWhole(after)).toBe(true);

    f.run(2000);
    expect(ownEvents(after).filter((e) => e.type === 'actor.joined')).toHaveLength(1);
  });

  it('a restart recovers state, not links: with signalling dead it cannot re-dial even its own group', () => {
    expect(f.actors.facilities.view().signalUp).toBe(false);
    expect(f.actors.facilities.view().reachable).toEqual([]);
    expect(f.actors.access.view().reachable).toEqual([]);
  });

  it('a restarted device still acts: it signs on from its old head', () => {
    const head = ownEvents(f.actors.facilities).length;
    f.actors.facilities.observe('generator.fuel', 'low');
    f.run(200);
    const own = ownEvents(f.actors.facilities);
    expect(own.length).toBeGreaterThan(head);
    expect(chainIsWhole(f.actors.facilities)).toBe(true);
  });

  it('ferry: a signed update crosses the gap with no network and changes what the far side does', () => {
    const beat = scenarioBeats.find((b) => b.id === 'ferry-north-gate')!;
    f.actors.supply.observe(beat.observation!.key, beat.observation!.value, { subject: beat.observation!.subject });
    f.run(300);
    expect(f.task('west-gate-reroute', 'supply')?.status).not.toBe('completed');
    expect(f.task('west-gate-reroute', 'access')).toBeUndefined();

    const packet = f.actors.supply.buildFerry(lastContact);
    const first = f.actors.access.ingestFerry(packet);
    expect(first.newEvents).toBeGreaterThan(0);
    expect(first.rejected).toBe(0);
    expect(first.stale).toBe(false);
    expect(f.actors.access.view().state.observations[beat.observation!.key]).toHaveLength(1);

    f.until(() => f.task('west-gate-reroute', 'access')?.status === 'completed', 'access acts on the carried news');
    expect(f.byTeam('west-gate-reroute', 'access')).toBe('access');
    expect(f.task('west-gate-reroute', 'facilities')).toBeUndefined();
  });

  it('ferry: scanning the same packet again changes nothing', () => {
    const receipts = () => eventsOf(f.actors.access, 'ferry.received').length;
    expect(receipts()).toBe(1);
    const size = f.actors.access.events().length;
    const packet = f.actors.supply.buildFerry(lastContact);
    const again = f.actors.access.ingestFerry(packet);
    expect(again.newEvents).toBe(0);
    expect(again.duplicates).toBe(packet.events.length);
    f.run(200);
    expect(receipts()).toBe(1);
    expect(f.actors.access.events().length).toBeGreaterThanOrEqual(size);
  });

  it('ferry: a tampered packet is refused whole', () => {
    const packet = f.actors.supply.buildFerry(lastContact);
    const forged = structuredClone(packet);
    forged.createdAt += 1;
    const result = f.actors.access.ingestFerry(forged);
    expect(result.newEvents).toBe(0);
    expect(result.rejected).toBe(packet.events.length);
    expect(result.reason).toBeTruthy();
  });

  it('heal: links return and every replica fills its gaps', () => {
    f.net.restoreHub();
    f.unsplit();
    f.until(() => TEAMS.every((t) => f.actors[t].view().reachable.length === 3), 'links re-form');
    f.until(() => f.settledLogs(), 'anti-entropy finishes');
    f.run(3000);
    f.until(() => f.settledLogs(), 'quiet again');
  });

  it('convergence: all replicas hold identical events in identical order and identical state', () => {
    const logs = TEAMS.map((t) => canonicalize(f.actors[t].events().map((e) => e.id)));
    expect(new Set(logs).size).toBe(1);
    const states = TEAMS.map((t) => canonicalize(f.actors[t].view().state));
    expect(new Set(states).size).toBe(1);
  });

  it('every device kept one unbroken chain, through a restart and a partition', () => {
    for (const t of TEAMS) {
      expect(chainIsWhole(f.actors[t])).toBe(true);
      expect(f.actors[t].view().phase).toBe('ready');
    }
  });

  it('conservation holds, checked by the ledger and independently from raw events', () => {
    const state = f.actors.medics.view().state;
    for (const row of conservation(state)) {
      expect(row.ok).toBe(true);
      expect(row.committed + row.held + row.inTransit).toBe(row.issued);
    }
    for (const [token, spends] of spendsPerToken(f.actors.medics.events())) {
      expect(`${token}:${spends}`).toBe(`${token}:1`);
    }
  });

  it('exactly one conflict: the duplicate effort both groups really did, with no violation', () => {
    const state = f.actors.medics.view().state;
    expect(state.conflicts.map((c) => c.id)).toEqual(['duplicate-effort:queue-water']);
    const [conflict] = state.conflicts;
    expect(conflict?.severity).toBe('policy');
    expect(conflict?.resolved).toBe(true);
    expect(conflict?.events).toHaveLength(2);
    expect(classify(f.actors.medics.events(), state).filter((c) => c.severity === 'violation')).toEqual([]);
    expect(f.task('queue-water')?.status).toBe('completed');
  });

  it('the refused task stays honest after healing: the right was spent, not magically shared', () => {
    expect(f.task('upper-stand-carry')?.status).not.toBe('completed');
    expect(f.task('upper-stand-carry')?.owner).toBeUndefined();
  });

  it('the observer fills its blind interval only from what really happened', () => {
    f.run(1000);
    const seen = new Set(f.net.hubState()?.seen);
    expect(f.actors.medics.events().every((e) => seen.has(e.id))).toBe(true);
    expect(seen.size).toBeGreaterThan(seenByHqBeforeKill);

    const events = f.actors.medics.events();
    const live = new Set(TEAMS.flatMap((t) => f.actors[t].view().hqSeen));
    const state = f.actors.medics.view().state;
    const record = buildMissionRecord({ events, state, hqSeen: [...live], episodes: [] });
    const hiddenDone = events.filter((e) => e.type === 'task.completed' && !live.has(e.id));
    expect(hiddenDone.length).toBeGreaterThanOrEqual(5);
    expect(record.doneWhileHqBlind).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.type === 'task.completed' && e.body.taskId === 'guide-quiet-tent' && live.has(e.id))).toBe(false);
    expect(events.some((e) => e.type === 'task.completed' && e.body.taskId === 'faint-main-stage' && live.has(e.id))).toBe(true);
  });
});
