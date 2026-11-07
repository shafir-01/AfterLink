import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryStorage, type ActorStorage } from '@afterlink/actor';
import { createActor } from '@afterlink/actor';
import { Fleet, doubleSpends, forks } from './fleet.ts';

let fleet: Fleet;
afterEach(() => fleet?.stop());

const CARRIER = 'access';
const TOKEN = 'evac-chair#1';
const CHAIR = [{ resource: 'evac-chair', count: 1 }];
const phase = (f: Fleet, team: string) => (f.node(team).view() as unknown as { phase: string }).phase;

/** Access gives the chair to Medics, and Medics commits it. */
async function chairGoesToMedics(f: Fleet) {
  expect(f.node(CARRIER).offerTokens([TOKEN], f.id('medics'))).not.toBeNull();
  await f.run(1500);
  f.node('medics').answerTransfer(f.node('medics').view().pendingTransfers[0]!.transfer, true);
  await f.run(500);
  f.node('medics').submitTask(f.task('chair-a', { needs: CHAIR }), { kind: 'human' });
  await f.run(1000);
  f.node('medics').acceptTask('chair-a');
  await f.run(1000);
}

/** The carrier returns cut off from everyone, on the given storage, and tries to spend the chair. */
async function returnCutOffAndSpend(f: Fleet, storage: ActorStorage) {
  f.node(CARRIER).stop();
  f.split([CARRIER], ['medics', 'facilities', 'supply']);
  await f.run(500);
  const node = await f.boot(CARRIER, storage);
  await f.run(500);
  try {
    node.submitTask(f.task('chair-b', { needs: CHAIR }), { kind: 'human' });
    await f.run(500);
    node.acceptTask('chair-b');
  } catch {
    // A device that refuses to act is the safe outcome.
  }
  await f.run(1000);
  f.net.heal();
  await f.run(20000);
}

describe('restart keeps one history', () => {
  it('a restart with intact storage resumes the same chain', async () => {
    fleet = await Fleet.start();
    const before = fleet.node(CARRIER).events().filter((e) => e.actor === fleet.id(CARRIER)).length;
    fleet.node(CARRIER).stop();
    await fleet.run(500);
    await fleet.boot(CARRIER);
    await fleet.run(3000);
    fleet.node(CARRIER).observe('after.restart', 1);
    await fleet.run(3000);
    expect(forks(fleet.union())).toEqual([]);
    expect(fleet.node(CARRIER).events().filter((e) => e.actor === fleet.id(CARRIER)).length).toBeGreaterThan(before);
  });

  it('a restart keeps rights: an offered token stays locked', async () => {
    fleet = await Fleet.start();
    expect(fleet.node(CARRIER).offerTokens([TOKEN], fleet.id('medics'))).not.toBeNull();
    await fleet.node(CARRIER).settled();
    fleet.node(CARRIER).stop();
    await fleet.run(200);
    const node = await fleet.boot(CARRIER);
    expect(node.view().state.tokens[TOKEN]!.state).not.toBe('held');
    expect(node.offerTokens([TOKEN], fleet.id('supply'))).toBeNull();
  });

  it('a restart while partitioned, with intact storage, can still act: the partition is no reason to stop', async () => {
    fleet = await Fleet.start({ autopilot: true });
    fleet.split([CARRIER], ['medics', 'facilities', 'supply']);
    await fleet.run(1000);
    fleet.node(CARRIER).stop();
    await fleet.run(500);
    const node = await fleet.boot(CARRIER);
    await fleet.run(500);
    node.submitTask(fleet.task('after-restart', { requires: ['mobility'] }), { kind: 'human' });
    await fleet.run(10000);
    expect(node.view().state.tasks['after-restart']?.status).toBe('completed');
  });
});

describe('the log rolled back but the mark kept apart from it survived', () => {
  it('stays read-only while cut off: no second spend', async () => {
    fleet = await Fleet.start();
    const backup = await fleet.storages.get(CARRIER)!.snapshot();
    await chairGoesToMedics(fleet);
    await returnCutOffAndSpend(fleet, await backup.logOnly());
    const all = fleet.union();
    expect(doubleSpends(all)).toEqual([]);
    expect(forks(all)).toEqual([]);
  });

  it('takes its own chain back from peers, then acts again', async () => {
    fleet = await Fleet.start();
    const backup = await fleet.storages.get(CARRIER)!.snapshot();
    fleet.node(CARRIER).observe('before.crash', 1);
    await fleet.run(2000);
    fleet.node(CARRIER).stop();
    await fleet.run(500);
    await fleet.boot(CARRIER, await backup.logOnly());
    await fleet.run(5000);
    expect(phase(fleet, CARRIER)).toBe('ready');
    fleet.node(CARRIER).observe('after.crash', 2);
    await fleet.run(3000);
    expect(forks(fleet.union())).toEqual([]);
  });
});

describe('the log and the mark wiped, same key', () => {
  it('does not sign a second first event', async () => {
    fleet = await Fleet.start();
    fleet.node(CARRIER).stop();
    await fleet.run(500);
    await fleet.boot(CARRIER, createMemoryStorage());
    await fleet.run(3000);
    expect(forks(fleet.union())).toEqual([]);
  });

  it('cannot spend a token it already gave away', async () => {
    fleet = await Fleet.start();
    await chairGoesToMedics(fleet);
    await returnCutOffAndSpend(fleet, createMemoryStorage());
    expect(doubleSpends(fleet.union())).toEqual([]);
  });

  it('is not released by one peer with an older copy of its chain', async () => {
    fleet = await Fleet.start();
    fleet.split([CARRIER, 'medics', 'facilities'], ['supply']);
    await fleet.run(500);
    await chairGoesToMedics(fleet);
    fleet.node(CARRIER).stop();
    fleet.split([CARRIER, 'supply'], ['medics', 'facilities']);
    await fleet.run(500);
    const node = await fleet.boot(CARRIER, createMemoryStorage());
    await fleet.run(3000);
    try {
      node.submitTask(fleet.task('chair-b', { needs: CHAIR }), { kind: 'human' });
      await fleet.run(500);
      node.acceptTask('chair-b');
    } catch {
      // A device that refuses to act is the safe outcome.
    }
    await fleet.run(1000);
    fleet.net.heal();
    await fleet.run(20000);
    expect(doubleSpends(fleet.union())).toEqual([]);
  });

  it('is not released by a replayed packet built before it had signed anything', async () => {
    fleet = await Fleet.start();
    const old = fleet.node('supply').buildFerry();
    const stripped = structuredClone(old);
    await chairGoesToMedics(fleet);
    fleet.node(CARRIER).stop();
    fleet.split([CARRIER], ['medics', 'facilities', 'supply']);
    await fleet.run(500);
    const node = await fleet.boot(CARRIER, createMemoryStorage());
    await fleet.run(500);
    node.ingestFerry(stripped);
    await fleet.run(500);
    try {
      node.submitTask(fleet.task('chair-b', { needs: CHAIR }), { kind: 'human' });
      await fleet.run(500);
      node.acceptTask('chair-b');
    } catch {
      // A device that refuses to act is the safe outcome.
    }
    await fleet.run(1000);
    fleet.net.heal();
    await fleet.run(20000);
    expect(doubleSpends(fleet.union())).toEqual([]);
  });
});

describe('a whole device image restored, which nothing on the device can detect', () => {
  it('any double spend it causes is surfaced everywhere, and the device stops signing', async () => {
    fleet = await Fleet.start();
    const backup = await fleet.storages.get(CARRIER)!.snapshot();
    await chairGoesToMedics(fleet);
    await returnCutOffAndSpend(fleet, await backup.wholeImage());
    const all = fleet.union();
    console.log(`[whole image restore] double spends: ${doubleSpends(all).length}, forks: ${forks(all).length}, device phase: ${phase(fleet, CARRIER)}`);
    if (doubleSpends(all).length) {
      const violations = fleet.state(all).conflicts.filter((c) => c.severity === 'violation');
      expect(violations.length).toBeGreaterThan(0);
      for (const team of ['medics', 'facilities', 'supply']) {
        expect(fleet.node(team).view().state.conflicts.some((c) => c.kind === 'token-fork')).toBe(true);
      }
      expect(phase(fleet, CARRIER)).toBe('halted');
    }
  });
});

describe('one key in two places', () => {
  it('a second runtime on the same device only reads', async () => {
    fleet = await Fleet.start();
    const shared = fleet.storages.get(CARRIER)!;
    const bundle = fleet.bundles[CARRIER]!;
    const twin = createActor({ bundle, connector: fleet.net.connector(bundle.actor.publicKey), storage: shared, tickMs: 200 });
    await twin.start();
    expect((twin.view() as unknown as { phase: string }).phase).toBe('duplicate');
    const before = (await shared.load())!.events.length;
    try {
      twin.observe('twin', 1);
    } catch {
      // Refusing out loud is as good as refusing quietly.
    }
    await fleet.run(1000);
    twin.stop();
    const own = (await shared.load())!.events.filter((e) => e.type === 'observation.recorded' && e.body.observation.key === 'twin');
    expect(own).toEqual([]);
    expect((await shared.load())!.events.length).toBeGreaterThanOrEqual(before);
  });

  it('a second phone with the same bundle is detected and stops signing', async () => {
    fleet = await Fleet.start();
    const backup = await fleet.storages.get(CARRIER)!.snapshot();
    const twin = await fleet.boot(CARRIER, await backup.wholeImage());
    twin.observe('twin', 1);
    await fleet.run(5000);
    const all = fleet.union();
    if (forks(all).length) expect(phase(fleet, CARRIER)).toBe('halted');
  });
});
