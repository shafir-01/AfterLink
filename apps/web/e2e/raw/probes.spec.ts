import { chromium, expect, test, type Page } from '@playwright/test';

const frame = (page: Page, id: string) => {
  const f = page.frame({ name: id });
  if (!f) throw new Error(`no frame ${id}`);
  return f;
};

async function boot(page: Page) {
  await page.goto('/stage.html');
  await page.evaluate(() => window.stage.load());
  await page.evaluate(() => {
    window.stage.startHub();
    window.stage.attachAll();
  });
  await expect
    .poll(async () => Object.values(await frame(page, 'A').evaluate(() => window.device.links())).filter((l) => l.dc === 'open').length, {
      timeout: 30_000,
    })
    .toBe(3);
}

test('MessagePort close event is not usable as a liveness signal', async ({ page }, info) => {
  await boot(page);
  const supported = await page.evaluate(() => 'onclose' in MessagePort.prototype);
  await frame(page, 'A').evaluate(() => window.device.askHubToClosePort());
  await page.evaluate(() => window.stage.killHub());
  await page.waitForTimeout(10_000);
  const events = await Promise.all(['A', 'B', 'C', 'D'].map((id) => frame(page, id).evaluate(() => window.device.log.portCloseEvents)));
  console.log(JSON.stringify({ project: info.project.name, oncloseInPrototype: supported, closeEvents: { explicitPortCloseOnA: events[0], terminateOnBCD: events.slice(1) } }));
  expect(events[1] + events[2] + events[3]).toBe(0);
});

test('far side peer connection state after a one sided close', async ({ page }, info) => {
  test.setTimeout(90_000);
  await boot(page);
  const start = await frame(page, 'B').evaluate(() => performance.now());
  await frame(page, 'A').evaluate(() => window.device.sever('B'));
  await page.waitForTimeout(40_000);
  const events = await frame(page, 'B').evaluate(() => window.device.log.linkEvents.filter((e) => e.peer === 'A'));
  const after = events.filter((e) => e.at >= start).map((e) => ({ kind: e.kind, state: e.state, ms: Math.round(e.at - start) }));
  console.log(JSON.stringify({ project: info.project.name, farSide40s: after, finalState: (await frame(page, 'B').evaluate(() => window.device.links())).A }));
});

const probeInit = () => {
  const w = window as unknown as {
    pc: RTCPeerConnection;
    dc: RTCDataChannel | null;
    got: string[];
    wire(dc: RTCDataChannel): void;
    gathered(): Promise<RTCSessionDescriptionInit>;
  };
  w.got = [];
  w.dc = null;
  w.pc = new RTCPeerConnection({ iceServers: [] });
  w.wire = (dc) => {
    w.dc = dc;
    dc.onmessage = (e) => w.got.push(String(e.data));
  };
  w.pc.ondatachannel = (e) => w.wire(e.channel);
  w.gathered = async () => {
    if (w.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        w.pc.addEventListener('icegatheringstatechange', () => {
          if (w.pc.iceGatheringState === 'complete') resolve();
        });
      });
    }
    return w.pc.localDescription!.toJSON();
  };
};

type Probe = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  got: string[];
  wire(dc: RTCDataChannel): void;
  gathered(): Promise<RTCSessionDescriptionInit>;
};

async function connectPair(a: Page, b: Page) {
  for (const p of [a, b]) {
    await p.goto('/device.html?id=probe');
    await p.evaluate(probeInit);
  }
  const offer = await a.evaluate(async () => {
    const w = window as unknown as Probe;
    w.wire(w.pc.createDataChannel('probe'));
    await w.pc.setLocalDescription(await w.pc.createOffer());
    return w.gathered();
  });
  const answer = await b.evaluate(async (o) => {
    const w = window as unknown as Probe;
    await w.pc.setRemoteDescription(o);
    await w.pc.setLocalDescription(await w.pc.createAnswer());
    return w.gathered();
  }, offer);
  await a.evaluate(async (ans) => {
    await (window as unknown as Probe).pc.setRemoteDescription(ans);
  }, answer);

  const state = () => a.evaluate(() => (window as unknown as Probe).dc?.readyState);
  await expect.poll(state, { timeout: 25_000 }).toBe('open');
  await a.evaluate(() => (window as unknown as Probe).dc!.send('over-the-wire'));
  await expect.poll(() => b.evaluate(() => (window as unknown as Probe).got.length), { timeout: 5_000 }).toBe(1);
  return /\.local/.test(offer.sdp ?? '');
}

test('WebRTC between two browser contexts', async ({ browser }, info) => {
  const ca = await browser.newContext();
  const cb = await browser.newContext();
  const mdns = await connectPair(await ca.newPage(), await cb.newPage());
  console.log(JSON.stringify({ project: info.project.name, twoContexts: 'connected', offerUsedMdns: mdns }));
  await ca.close();
  await cb.close();
});

test('WebRTC between two separate browser processes', async ({ baseURL }, info) => {
  const channel = info.project.name.includes('new-headless') ? 'chromium' : undefined;
  const one = await chromium.launch({ headless: true, channel });
  const two = await chromium.launch({ headless: true, channel });
  const ca = await one.newContext({ baseURL });
  const cb = await two.newContext({ baseURL });
  try {
    const mdns = await connectPair(await ca.newPage(), await cb.newPage());
    console.log(JSON.stringify({ project: info.project.name, twoProcesses: 'connected', offerUsedMdns: mdns }));
  } finally {
    await one.close();
    await two.close();
  }
});
