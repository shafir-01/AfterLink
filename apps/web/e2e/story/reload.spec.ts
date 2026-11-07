import { expect, test } from '@playwright/test';
import { Stage, instrument } from '../support/harness';

test('reloading a device mid partition: it recovers its identity and log, and rejoins on restore', async ({ page }) => {
  test.setTimeout(180_000);
  const stage = new Stage(page);
  await instrument(page.context());
  await page.goto('/');

  await stage.advance('Break the network', 'Split the teams');
  await stage.advance('Split the teams', /^Request the /);
  await expect.poll(() => stage.openLinks(), { timeout: 15_000 }).toBe(4);

  const team = 'access';
  const before = await stage.view(team);
  const logBefore = await stage.events(team);
  const frame = await stage.frameOf(team);

  await frame.evaluate(() => location.reload());

  await test.step('the stage brings the device back from its own storage', async () => {
    await expect
      .poll(async () => (await stage.reports()).filter((r) => r.kind === 'booted' && r.team === team).length, {
        message: 'a reloaded device must boot again',
        timeout: 20_000,
      })
      .toBeGreaterThan(1);
    const booted = (await stage.reports()).filter((r) => r.kind === 'booted' && r.team === team).at(-1)!;
    expect(booted.body.restored, 'the device must restore from storage, not start fresh').toBe(true);
    expect(booted.body.actor).toBe(before.self.id);
  });

  await test.step('no event was lost or duplicated', async () => {
    await expect.poll(async () => (await stage.view(team)).eventCount >= logBefore.length, { timeout: 15_000 }).toBe(true);
    const logAfter = await stage.events(team);
    const ids = logAfter.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of logBefore) expect(ids).toContain(e.id);
  });

  await test.step('the partition still holds for the reloaded device', async () => {
    await page.waitForTimeout(3_000);
    const conns = await stage.connections(await stage.frameOf(team));
    const blocked = (await stage.views()).medics!.self.id;
    const v = await stage.view(team);
    expect(v.links.find((l) => l.peer === blocked)?.state).not.toBe('open');
    expect(conns.every((c) => c.connectionState !== 'connected' || c.channels.length > 0)).toBe(true);
  });

  await test.step('restore brings it fully back and all logs converge', async () => {
    await stage.advance(/^Request the /, 'Carry the update');
    await stage.advance('Carry the update', 'Restore contact');
    await stage.advance('Restore contact', 'See what happened');
    await expect.poll(() => stage.openLinks(), { timeout: 30_000 }).toBe(12);
    await expect.poll(async () => new Set(Object.values(await stage.heads())).size, { timeout: 30_000 }).toBe(1);
  });
});

test('the bridge restart command mid partition: a device restarts from its own storage and rejoins', async ({ page }) => {
  test.setTimeout(180_000);
  const stage = new Stage(page);
  await instrument(page.context());
  await page.goto('/');

  await stage.advance('Break the network', 'Split the teams');
  await stage.advance('Split the teams', /^Request the /);
  await expect.poll(() => stage.openLinks(), { timeout: 15_000 }).toBe(4);

  const team = 'access';
  const logBefore = await stage.events(team);
  const bootsBefore = (await stage.reports()).filter((r) => r.kind === 'booted' && r.team === team).length;

  await page.evaluate((t) => (window as unknown as { __probe: { send(a: string, b: unknown): void } }).__probe.send(t, { kind: 'restart' }), team);

  await expect
    .poll(async () => (await stage.reports()).filter((r) => r.kind === 'booted' && r.team === team).length, { timeout: 20_000 })
    .toBeGreaterThan(bootsBefore);
  const booted = (await stage.reports()).filter((r) => r.kind === 'booted' && r.team === team).at(-1)!;
  expect(booted.body.restored, 'restart must restore from storage').toBe(true);

  await expect.poll(async () => (await stage.view(team)).eventCount >= logBefore.length, { timeout: 15_000 }).toBe(true);
  const after = (await stage.events(team)).map((e) => e.id);
  expect(new Set(after).size).toBe(after.length);
  for (const e of logBefore) expect(after).toContain(e.id);

  const blocked = (await stage.views()).medics!.self.id;
  await page.waitForTimeout(3_000);
  expect((await stage.view(team)).links.find((l) => l.peer === blocked)?.state, 'the partition must survive a restart').not.toBe('open');

  await stage.advance(/^Request the /, 'Carry the update');
  await stage.advance('Carry the update', 'Restore contact');
  await stage.advance('Restore contact', 'See what happened');
  await expect.poll(() => stage.openLinks(), { timeout: 30_000 }).toBe(12);
  await expect.poll(async () => new Set(Object.values(await stage.heads())).size, { timeout: 30_000 }).toBe(1);
});
