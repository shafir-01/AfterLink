import { expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import type { AnyEvent, EventId, SyncSummary } from '@afterlink/protocol';
import { installProbe, type Arrival, type BridgeReport, type Probe, type ProbeConnection } from './probe';

export const TEAMS = ['Medics', 'Access', 'Facilities', 'Supply'] as const;
export type TeamName = (typeof TEAMS)[number];

type Win = Window & { __probe: Probe };

export interface View {
  self: { id: string; team: string; name: string; custodian: boolean };
  signalUp: boolean;
  reachable: string[];
  links: { peer: string; state: string; transport: string }[];
  eventCount: number;
  tasks: { id: string; title: string; status: string; owner?: string; coveredBy?: string[] }[];
  tokens: { id: string; resource: string; holder: string | null; state: string; committedTo?: string }[];
  refusals: { taskId: string; outcome: string; refusal?: string; reason: string }[];
  lastDecision: { taskId: string; outcome: string; refusal?: string } | null;
  conflicts: { kind: string; severity: string }[];
  summary: SyncSummary;
}

export async function instrument(context: BrowserContext) {
  await context.addInitScript(installProbe);
}

export class Stage {
  constructor(readonly page: Page) {}

  deviceFrames(): Frame[] {
    return this.page.frames().filter((f) => f !== this.page.mainFrame() && f.url().includes('#/device'));
  }

  /** The frame of one team, found by asking each frame which actor its reports came from. */
  async frameOf(team: string): Promise<Frame> {
    const { name } = (await this.view(team)).self;
    const handle = await this.page.locator(`iframe[title="${name} device"]`).elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error(`no device frame for ${team}`);
    return frame;
  }

  primary(name: string | RegExp) {
    return this.page.getByRole('button', { name, exact: typeof name === 'string' });
  }

  /** Presses the dominant action, then waits for the stage to offer the next one. */
  async advance(label: string | RegExp, next: string | RegExp, timeout = 60_000) {
    await expect(this.primary(label)).toBeEnabled({ timeout });
    await this.primary(label).click();
    await expect(this.primary(next)).toBeEnabled({ timeout });
  }

  statusLine() {
    return this.page.locator('.st-line').innerText();
  }

  connections(frame: Frame): Promise<ProbeConnection[]> {
    return frame.evaluate(() => (window as unknown as Win).__probe.connections());
  }

  arrivals(frame: Frame): Promise<Arrival[]> {
    return frame.evaluate(() => (window as unknown as Win).__probe.arrivals());
  }

  /** Directed links with a live peer connection and an open data channel, counted across all devices. */
  async openLinks(): Promise<number> {
    let open = 0;
    for (const frame of this.deviceFrames()) {
      const conns = await this.connections(frame);
      open += conns.filter((c) => c.connectionState === 'connected' && c.channels.some((ch) => ch.readyState === 'open')).length;
    }
    return open;
  }

  async openLinksByTeam(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const team of await this.teams()) {
      const conns = await this.connections(await this.frameOf(team));
      out[team] = conns.filter((c) => c.connectionState === 'connected' && c.channels.some((ch) => ch.readyState === 'open')).length;
    }
    return out;
  }

  teams(): Promise<string[]> {
    return this.page.evaluate(() => (window as unknown as Win).__probe.teams());
  }

  async pairs(frame: Frame) {
    return frame.evaluate(() => (window as unknown as Win).__probe.pairs());
  }

  async views(): Promise<Record<string, View>> {
    return (await this.page.evaluate(() => (window as unknown as Win).__probe.views())) as Record<string, View>;
  }

  async view(team: string): Promise<View> {
    const v = (await this.views())[team];
    if (!v) throw new Error(`no view from team ${team}`);
    return v;
  }

  reports(): Promise<BridgeReport[]> {
    return this.page.evaluate(() => (window as unknown as Win).__probe.reports());
  }

  /** Reads a device's full signed log through the same bridge the stage uses. */
  async events(team: string): Promise<AnyEvent[]> {
    const requestId = `e2e-${team}-${Date.now()}-${Math.random()}`;
    await this.page.evaluate(([t, id]) => (window as unknown as Win).__probe.send(t!, { kind: 'requestEvents', requestId: id }), [team, requestId]);
    let found: BridgeReport | undefined;
    await expect
      .poll(
        async () => {
          found = (await this.reports()).find((r) => r.kind === 'events' && r.body.requestId === requestId);
          return Boolean(found);
        },
        { message: `device ${team} did not answer requestEvents`, timeout: 10_000 },
      )
      .toBe(true);
    return found!.body.events as AnyEvent[];
  }

  async allLogs(): Promise<Record<string, AnyEvent[]>> {
    const out: Record<string, AnyEvent[]> = {};
    for (const team of await this.teams()) out[team] = await this.events(team);
    return out;
  }

  /** Exactly what the stage handed the debrief route. */
  debriefInput(): Promise<{ events: AnyEvent[]; hqSeen: EventId[]; episodes: unknown[] } | null> {
    return this.page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('afterlink-stage', 1);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction('kv', 'readonly').objectStore('kv').get('debrief');
            get.onerror = () => reject(get.error);
            get.onsuccess = () => {
              open.result.close();
              resolve(get.result ?? null);
            };
          };
        }),
    );
  }

  /** The hash of each device's per-actor heads: equal strings mean identical logs. */
  async heads(): Promise<Record<string, string>> {
    const views = await this.views();
    return Object.fromEntries(
      Object.entries(views).map(([team, v]) => [
        team,
        JSON.stringify(
          Object.entries(v.summary.heads)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([actor, head]) => [actor, head.seq, head.id]),
        ),
      ]),
    );
  }

  /** Workers the browser itself reports as alive, from the debugging protocol rather than from page code. */
  liveHqWorkers(): string[] {
    return this.page
      .workers()
      .map((w) => w.url())
      .filter((u) => u.includes('hq.worker'));
  }

  carriedFrames() {
    return this.page.evaluate(() => (window as unknown as Win).__probe.carriedFrames());
  }

  framePixels(ferryId: string, index: number) {
    return this.page.evaluate(([f, i]) => (window as unknown as Win).__probe.framePixels(f as string, i as number), [ferryId, index] as const);
  }

  replayFrames(team: string, ferryId: string, replayId: string) {
    return this.page.evaluate(([t, f, r]) => (window as unknown as Win).__probe.replayFrames(t!, f!, r!), [team, ferryId, replayId]);
  }

  workerHistory() {
    return this.page.evaluate(() => (window as unknown as Win).__probe.workers());
  }
}

export function eventIds(events: AnyEvent[]): EventId[] {
  return events.map((e) => e.id).sort();
}
