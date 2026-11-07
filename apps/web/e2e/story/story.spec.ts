import { expect, test } from '@playwright/test';
import type { AnyEvent } from '@afterlink/protocol';
import jsQR from 'jsqr';
import { Stage, instrument } from '../support/harness';

const SPLIT = { a: ['medics', 'supply'], b: ['access', 'facilities'] };
const GATE_KEY = 'gate.north.open';

const union = (logs: Record<string, AnyEvent[]>) => {
  const all = new Map<string, AnyEvent>();
  for (const log of Object.values(logs)) for (const e of log) all.set(e.id, e);
  return [...all.values()];
};

test('the whole story through the real UI, checked against real browser state and signed logs', async ({ page, baseURL }, info) => {
  test.setTimeout(240_000);
  const stage = new Stage(page);
  await instrument(page.context());

  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(baseURL!) && !/^(data|blob):/.test(url)) foreign.push(url);
  });
  page.on('websocket', (ws) => foreign.push(ws.url()));

  const evidence: Record<string, unknown> = {};

  await test.step('load: four independent devices connect peer to peer', async () => {
    await page.goto('/');
    await expect(stage.primary('Break the network')).toBeEnabled({ timeout: 45_000 });

    expect(stage.deviceFrames()).toHaveLength(4);
    await expect.poll(() => stage.openLinks(), { timeout: 15_000 }).toBe(12);
    await expect.poll(async () => (await stage.teams()).length).toBe(4);

    const views = await stage.views();
    expect(new Set(Object.values(views).map((v) => v.self.id)).size).toBe(4);
    expect(Object.keys(views).sort()).toEqual(['access', 'facilities', 'medics', 'supply']);
    expect(Object.values(views).every((v) => v.signalUp)).toBe(true);
    expect(stage.liveHqWorkers()).toHaveLength(1);

    for (const frame of stage.deviceFrames()) {
      const pairs = await stage.pairs(frame);
      expect(pairs).toHaveLength(3);
      for (const pair of pairs) {
        expect(pair).not.toBeNull();
        expect(pair!.local).not.toBe('relay');
        expect(pair!.remote).not.toBe('relay');
      }
    }
  });

  let killedAt = 0;
  const breakBeat = 'guide-quiet-tent';

  await test.step('break: the worker is gone and a new request completes peer to peer', async () => {
    await stage.primary('Break the network').click();
    await expect.poll(() => stage.liveHqWorkers(), { timeout: 5_000 }).toHaveLength(0);
    const history = await stage.workerHistory();
    const hq = history.filter((w) => w.url.includes('hq.worker'));
    expect(hq.length).toBeGreaterThan(0);
    expect(hq.every((w) => w.terminatedAt !== null)).toBe(true);
    killedAt = Math.max(...hq.map((w) => w.terminatedAt!));

    await expect(stage.primary('Split the teams')).toBeEnabled({ timeout: 45_000 });
    expect(Object.values(await stage.views()).every((v) => !v.signalUp)).toBe(true);
    expect(await stage.openLinks()).toBe(12);

    await expect
      .poll(async () => Object.values(await stage.views()).filter((v) => v.tasks.find((t) => t.id === breakBeat)?.status === 'completed').length, {
        message: 'the request raised after the kill must reach completed on all four devices',
        timeout: 30_000,
      })
      .toBe(4);

    const logs = await stage.allLogs();
    const events = union(logs);
    const created = events.find((e) => e.type === 'task.created' && e.body.spec.id === breakBeat);
    const completed = events.find((e) => e.type === 'task.completed' && e.body.taskId === breakBeat);
    expect(created, 'task.created in the signed log').toBeTruthy();
    expect(completed, 'task.completed in the signed log').toBeTruthy();
    expect(created!.wall).toBeGreaterThan(killedAt);
    expect(completed!.wall).toBeGreaterThan(killedAt);

    const views = await stage.views();
    const authors = Object.values(views).filter((v) => v.self.id !== completed!.actor);
    for (const v of authors) {
      const arrivals = await stage.arrivals(await stage.frameOf(v.self.team));
      const crossed = arrivals.find((a) => a.id === completed!.id);
      expect(crossed, `${v.self.team} must receive the completion over an RTCDataChannel`).toBeTruthy();
      expect(crossed!.at).toBeGreaterThan(killedAt);
    }
    evidence.break = { line: await stage.statusLine(), completedBy: completed!.actor };
  });

  await test.step('split: cross links are really severed and a message cannot cross', async () => {
    const views = await stage.views();
    const idsOf = (teams: string[]) => teams.map((t) => views[t]!.self.id);
    await stage.primary('Split the teams').click();
    await expect.poll(async () => stage.openLinks(), { timeout: 15_000 }).toBe(4);

    for (const [mine, theirs] of [
      [SPLIT.a, SPLIT.b],
      [SPLIT.b, SPLIT.a],
    ] as const) {
      for (const team of mine) {
        const conns = await stage.connections(await stage.frameOf(team));
        expect(conns.filter((c) => c.connectionState === 'connected')).toHaveLength(1);
        const v = (await stage.views())[team]!;
        expect(v.links.filter((l) => idsOf(theirs).includes(l.peer)).map((l) => l.state)).not.toContain('open');
      }
    }

    await expect(stage.primary(/^Request the /)).toBeEnabled({ timeout: 45_000 });

    const before = await stage.allLogs();
    const probe = { ...probeSpec, id: `probe-${Date.now()}` };
    await page.evaluate(
      ([s]) => (window as unknown as { __probe: { send(t: string, b: unknown): void } }).__probe.send('medics', { kind: 'addTask', spec: s, source: { kind: 'human', ref: s.id } }),
      [probe],
    );
    await expect
      .poll(async () => (await stage.views()).supply!.tasks.some((t) => t.id === probe.id), { message: 'a message inside the group still flows', timeout: 10_000 })
      .toBe(true);
    await page.waitForTimeout(4_000);
    for (const team of SPLIT.b) {
      const v = (await stage.views())[team]!;
      expect(v.tasks.some((t) => t.id === probe.id), `${team} must not hear across the partition`).toBe(false);
    }
    expect(await stage.openLinks()).toBe(4);
    evidence.split = { line: await stage.statusLine(), eventsBefore: Object.values(before).map((l) => l.length) };
  });

  await test.step('contest: one chair, one promise', async () => {
    await stage.advance(/^Request the /, 'Carry the update');
    const views = await stage.views();
    const refused = views.medics!.refusals.find((d) => d.taskId === 'upper-stand-carry');
    expect(refused, 'medics refuse the chair they do not hold').toBeTruthy();
    expect(refused!.outcome).toBe('REFUSED');
    expect(refused!.refusal).toBe('NO_RIGHT');

    const chairs = views.access!.tokens.filter((t) => t.resource === 'evac-chair');
    expect(chairs.filter((t) => t.committedTo === 'hall-chair')).toHaveLength(1);
    expect(views.medics!.tokens.filter((t) => t.committedTo === 'upper-stand-carry')).toHaveLength(0);
    evidence.contest = { line: await stage.statusLine(), reason: refused!.reason };
  });

  let ferryId = '';
  const receiver = 'access';

  await test.step('carry: a real QR crosses the gap by pixels, not by network', async () => {
    const shown: string[] = [];
    await stage.primary('Carry the update').click();

    const canvas = page.locator('.st-courier canvas');
    await expect(canvas).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const img = await canvas.evaluate((c: HTMLCanvasElement) => {
            if (!c.width) return null;
            const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
            return { width: d.width, height: d.height, data: Array.from(d.data) };
          });
          if (!img) return null;
          const qr = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
          if (qr) shown.push(qr.data);
          return qr?.data.slice(0, 4) ?? null;
        },
        { message: 'the visible canvas must hold a QR that an independent decoder can read', timeout: 15_000 },
      )
      .toBe('AL1.');

    await expect(stage.primary('Restore contact')).toBeEnabled({ timeout: 60_000 });

    const reports = await stage.reports();
    const result = reports.find((r) => r.kind === 'ferryResult');
    expect(result, 'the receiver reports a verified packet').toBeTruthy();
    expect(result!.team).toBe(receiver);
    expect(result!.body.newEvents as number).toBeGreaterThan(0);
    expect(result!.body.rejected).toBe(0);
    ferryId = result!.body.ferryId as string;

    const frames = (await stage.carriedFrames()).filter((f) => f.ferryId === ferryId);
    expect(frames.length).toBeGreaterThan(0);

    const logs = await stage.allLogs();
    const gate = logs[receiver]!.find((e) => e.type === 'observation.recorded' && e.body.observation.key === GATE_KEY);
    expect(gate, 'the receiver holds the signed gate observation').toBeTruthy();
    expect(logs.supply!.some((e) => e.id === gate!.id)).toBe(true);

    const receiverFrame = await stage.frameOf(receiver);
    const overChannel = (await stage.arrivals(receiverFrame)).filter((a) => a.id === gate!.id);
    const conns = await stage.connections(receiverFrame);
    const peerArrivals = await stage.arrivals(await stage.frameOf('facilities'));
    console.log(
      JSON.stringify({
        gateId: gate!.id.slice(0, 8),
        resultAt: result!.at,
        receiverArrivals: overChannel.map((a) => ({ dtMs: a.at - result!.at, pc: a.pc, state: conns.find((c) => c.id === a.pc)?.connectionState })),
        facilitiesArrivals: peerArrivals.filter((a) => a.id === gate!.id).map((a) => ({ dtMs: a.at - result!.at, pc: a.pc })),
      }),
    );
    expect(overChannel.filter((a) => a.at < result!.at), 'no data channel may deliver the observation before the QR does').toEqual([]);
    evidence.carry = { line: await stage.statusLine(), frames: frames.length, newEvents: result!.body.newEvents, sample: shown[0]?.slice(0, 24) };
  });

  await test.step('replay: the same QR again changes nothing', async () => {
    const before = await stage.events(receiver);
    const known = new Set(before.map((e) => e.id));
    const replayId = `${ferryId}-replay`;
    const sent = await stage.replayFrames(receiver, ferryId, replayId);
    expect(sent).toBeGreaterThan(0);

    await expect
      .poll(async () => (await stage.reports()).find((r) => (r.kind === 'ferryResult' || r.kind === 'ferryRejected') && r.body.ferryId === replayId)?.kind, {
        message: 'the receiver must answer a replayed packet',
        timeout: 15_000,
      })
      .toBeTruthy();
    const result = (await stage.reports()).find((r) => r.body.ferryId === replayId && (r.kind === 'ferryResult' || r.kind === 'ferryRejected'))!;
    console.log(JSON.stringify({ replay: { kind: result.kind, ...result.body } }));
    if (result.kind === 'ferryResult') {
      expect(result.body.newEvents).toBe(0);
      expect(result.body.rejected).toBe(0);
    }

    await page.waitForTimeout(1_500);
    const after = await stage.events(receiver);
    const added = after.filter((e) => !known.has(e.id));
    console.log(JSON.stringify({ addedDuringReplay: added.map((e) => ({ type: e.type, by: e.actor.slice(0, 6), wallMs: e.wall - result.at })) }));
    expect(added.filter((e) => e.type === 'ferry.received'), 'a replay must not record a second receipt').toEqual([]);
    expect(after.filter((e) => e.type === 'ferry.received' && e.body.packetId === (result.body.packetId as string)).length).toBeLessThanOrEqual(1);
    evidence.replay = result;
  });

  await test.step('restore: signalling returns, links re-form, every log converges', async () => {
    await stage.advance('Restore contact', 'See what happened');
    expect(stage.liveHqWorkers()).toHaveLength(1);
    await expect.poll(() => stage.openLinks(), { timeout: 30_000 }).toBe(12);
    await expect
      .poll(async () => new Set(Object.values(await stage.heads())).size, { message: 'all devices hold identical heads', timeout: 30_000 })
      .toBe(1);

    const logs = await stage.allLogs();
    const order = Object.values(logs).map((l) => JSON.stringify(l.map((e) => e.id)));
    expect(new Set(order).size, 'all four devices hold the same events in the same order').toBe(1);

    const events = Object.values(logs)[0]!;
    const seen = new Set<string>();
    for (const e of events) {
      expect(seen.has(e.id)).toBe(false);
      seen.add(e.id);
    }

    const commits = events.filter((e) => e.type === 'right.committed');
    const byToken = new Map<string, string[]>();
    for (const e of commits) for (const t of e.body.tokens) byToken.set(t, [...(byToken.get(t) ?? []), e.id]);
    const doubled = [...byToken].filter(([, ids]) => ids.length > 1);
    expect(doubled, 'no token is ever committed twice').toEqual([]);
    evidence.restore = { line: await stage.statusLine(), events: events.length, commits: commits.length };
  });

  await test.step('debrief: the numbers on screen match the logs', async () => {
    const logs = await stage.allLogs();
    const events = Object.values(logs)[0]!;
    await stage.primary('See what happened').click();
    await page.waitForURL(/#\/debrief/, { timeout: 15_000 });
    const facts = page.getByRole('region', { name: 'Key facts' });
    await expect(facts).toBeVisible({ timeout: 15_000 });

    const texts = await facts.locator('> div').allInnerTexts();
    const read = (label: RegExp) => {
      const hit = texts.find((t) => label.test(t));
      if (!hit) throw new Error(`no fact matching ${label} in ${JSON.stringify(texts)}`);
      return Number(hit.match(/\d+/)![0]);
    };

    const refusedInLog = new Set(events.filter((e) => e.type === 'task.refused').map((e) => e.body.taskId)).size;
    const blindDone = events.filter((e) => e.type === 'task.completed' && e.wall >= killedAt).length;
    evidence.debrief = { texts, refusedInLog, blindDone, total: events.length };

    expect(read(/refused/i)).toBe(refusedInLog);
    expect(read(/done while blind/i)).toBeGreaterThan(0);
    expect(read(/done while blind/i)).toBeLessThanOrEqual(blindDone);
  });

  console.log(JSON.stringify({ project: info.project.name, evidence }));
  expect(errors, 'no uncaught page errors during the run').toEqual([]);
  expect(foreign, 'the solo demo must not touch anything but its own origin').toEqual([]);
});

const probeSpec = {
  kind: 'visitor-help',
  title: 'Partition check request',
  brief: 'Check that this request stays on one side.',
  objective: 'safety',
  priority: 3,
  location: { x: 10, y: 10 },
  locationName: 'North lawn',
  requires: ['nonexistent-capability'],
  needs: [],
  dependsOn: [],
  reversible: true,
};
