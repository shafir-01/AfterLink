import { Author, EventLog, generateKeys, type ActorId, type AnyEvent, type WireMessage } from '@afterlink/protocol';
import { attachSync, createHub, Mesh, portSignalClient, servePort, webrtcConnector } from '../../src/index.ts';
import type { BoundLink, LinkConnector, SyncHandle } from '../../src/index.ts';

const MISSION = 'browser-check';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean, ms = 8000): Promise<number> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > ms) throw new Error(`timed out: ${what}`);
    await wait(5);
  }
  return Math.round(performance.now() - start);
}

/** Offers that met a local offer: the polite end rolled back here. */
let collisions = 0;

interface Device {
  id: ActorId;
  mesh: Mesh;
  log: EventLog;
  author: Author;
  sync: SyncHandle;
  pcs: RTCPeerConnection[];
  links: BoundLink[];
}

/** A hub behind real MessagePorts. Terminating it is pure silence, as a killed worker gives. */
function hq() {
  const hub = createHub();
  const served: MessagePort[] = [];
  return {
    hub,
    port(): MessagePort {
      const { port1, port2 } = new MessageChannel();
      servePort(hub, port2);
      served.push(port2);
      return port1;
    },
    terminate() {
      for (const port of served) port.onmessage = null;
    },
  };
}

function device(keys: ReturnType<typeof generateKeys>, ids: ActorId[], port: MessagePort): Device {
  const pcs: RTCPeerConnection[] = [];
  const links: BoundLink[] = [];
  class Tracked extends RTCPeerConnection {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
    override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      if (description.type === 'offer' && this.signalingState === 'have-local-offer') collisions++;
      return super.setRemoteDescription(description);
    }
  }
  const base = webrtcConnector({ RTCPeerConnection: Tracked });
  const connector: LinkConnector = {
    kind: base.kind,
    connect(req) {
      const link = base.connect(req);
      links.push(link as unknown as BoundLink);
      return link;
    },
  };
  const log = new EventLog(MISSION);
  const mesh = new Mesh({
    self: keys.publicKey,
    peers: ids,
    connector,
    signal: portSignalClient(port, { heartbeatMs: 100, timeoutMs: 350 }),
    room: 'browser',
    secretKey: keys.secretKey,
  });
  const sync = attachSync(mesh, log, () => {});
  mesh.start();
  return { id: keys.publicKey, mesh, log, author: new Author(keys, log), sync, pcs, links };
}

const openCount = (devices: Device[]) => devices.flatMap((d) => d.mesh.links()).filter((l) => l.state === 'open').length;
const live = (d: Device) => d.pcs.filter((pc) => pc.connectionState !== 'closed');

async function run() {
  const results: Record<string, unknown> = {};
  const allKeys = Array.from({ length: 4 }, () => generateKeys());
  const ids = allKeys.map((k) => k.publicKey);
  let current = hq();
  const devices = allKeys.map((k) => device(k, ids, current.port()));
  const [a, b, c, d] = devices as [Device, Device, Device, Device];

  results.fullMeshMs = await until('12 open link ends', () => openCount(devices) === 12);
  results.authenticated = devices.flatMap((x) => x.mesh.stats()).every((s) => s.authenticated);
  results.hubSawProof = ids.every((id) => current.hub.state().actors[id]?.proved === true);
  results.attemptsPerLink = Math.max(...devices.flatMap((x) => x.mesh.stats().map((s) => s.attempts)));
  const binding = a.links[0]!.binding();
  results.bindingHasFingerprints = binding.includes('sha-256');

  const first = a.author.emit('task.released', { taskId: 't', reason: 'before the kill' });
  a.sync.nudge();
  await until('event reaches everyone', () => devices.every((x) => x.log.has(first.id)));

  // Signalling dies: heartbeats notice, links do not care.
  current.terminate();
  results.hubDeathDetectedMs = await until('all devices see the hub gone', () => devices.every((x) => !x.mesh.signalUp));
  results.openAfterKill = openCount(devices);

  const blind = b.author.emit('task.released', { taskId: 't', reason: 'with the hub gone' });
  b.sync.nudge();
  await until('event crosses with no hub', () => devices.every((x) => x.log.has(blind.id)));
  results.eventCrossedAfterKill = true;

  await wait(7500);
  results.openAfterSilenceWindow = openCount(devices);
  results.reachableAfterSilenceWindow = devices.map((x) => x.mesh.reachable().length);

  // A large message crosses in frames, on a link with no hub behind it.
  const received: WireMessage[] = [];
  const stopWatch = d.mesh.onMessage((_peer, m) => {
    if ((m as { t: string }).t === 'bulk') received.push(m);
  });
  const blob = 'å🙂'.repeat(60_000);
  c.mesh.send(d.id, { t: 'bulk', blob } as unknown as WireMessage);
  await until('large message arrives whole', () => received.length === 1);
  results.largeMessageBytes = new TextEncoder().encode(blob).length;
  results.largeMessageIntact = (received[0] as unknown as { blob: string }).blob === blob;
  stopWatch();

  // A burst far beyond the channel buffer must not throw or close the channel.
  let burst = 0;
  const stopBurst = d.mesh.onMessage((_peer, m) => {
    if ((m as { t: string }).t === 'burst') burst++;
  });
  const chunk = 'y'.repeat(100_000);
  for (let i = 0; i < 80; i++) c.mesh.send(d.id, { t: 'burst', chunk } as unknown as WireMessage);
  results.burstArrivedMs = await until('8 MB burst drains', () => burst === 80, 20_000);
  stopBurst();

  // Sever: the real connection closes and the far end learns at once.
  const before = live(a).length;
  a.mesh.setFaults({ blocked: [b.id] });
  results.closedConnections = before - live(a).length;
  results.farEndClosedMs = await until('far end sees the close', () => b.mesh.links().find((l) => l.peer === a.id)?.state !== 'open');
  results.sendAfterSever = a.mesh.send(b.id, { t: 'ping', n: 1 });
  results.otherLinksOpen = a.mesh.links().filter((l) => l.state === 'open').length;

  const split = a.author.emit('task.released', { taskId: 't', reason: 'routed around the cut' });
  a.sync.nudge();
  await until('event routes around the cut', () => b.log.has(split.id));

  // Full partition with no hub: no path, so nothing crosses.
  a.mesh.setFaults({ blocked: [b.id, c.id, d.id] });
  b.mesh.setFaults({ blocked: [a.id] });
  c.mesh.setFaults({ blocked: [a.id] });
  d.mesh.setFaults({ blocked: [a.id] });
  await wait(200);
  const isolated = a.author.emit('task.released', { taskId: 't', reason: 'alone' });
  a.sync.nudge();
  await wait(1500);
  results.isolatedEventCrossed = b.log.has(isolated.id) || c.log.has(isolated.id) || d.log.has(isolated.id);
  results.liveConnectionsOnIsolatedDevice = live(a).length;

  // Unblock with signalling still down: nothing can form.
  for (const x of devices) x.mesh.setFaults({ blocked: [] });
  await wait(1200);
  results.linksFormedWithoutSignalling = a.mesh.links().filter((l) => l.state === 'open').length;

  // Signalling returns: links re-form and history converges.
  current = hq();
  for (const x of devices) x.mesh.setSignal(portSignalClient(current.port(), { heartbeatMs: 100, timeoutMs: 350 }));
  results.reformedMs = await until('all links back', () => openCount(devices) === 12);
  results.convergedMs = await until('all logs equal', () => devices.every((x) => x.log.size === a.log.size && x.log.has(isolated.id)));

  // Faults on a real link.
  c.mesh.setFaults({ blocked: [], lossRate: 0.5 });
  let lossy = 0;
  const stopLoss = d.mesh.onMessage((_peer, m) => {
    if ((m as { t: string }).t === 'lossy') lossy++;
  });
  for (let i = 0; i < 400; i++) c.mesh.send(d.id, { t: 'lossy' } as unknown as WireMessage);
  await wait(500);
  stopLoss();
  c.mesh.setFaults({ blocked: [] });
  const lossStats = c.mesh.stats().find((s) => s.peer === d.id)!;
  results.lossDelivered = lossy;
  results.lossDropped = lossStats.dropped;

  // Perfect negotiation: on all six pairs both ends renegotiate at the same instant.
  const opensBefore = devices.flatMap((x) => x.mesh.stats()).reduce((n, s) => n + s.opens, 0);
  for (const x of devices) for (const pc of live(x)) pc.restartIce();
  await wait(1500);
  results.offerCollisions = collisions;
  results.signalingStable = devices.flatMap(live).every((pc) => pc.signalingState === 'stable');
  results.linksSurvivedGlare = openCount(devices);
  results.reopenedByGlare = devices.flatMap((x) => x.mesh.stats()).reduce((n, s) => n + s.opens, 0) - opensBefore;

  // A peer opening a stray channel must not capture the link: traffic still flows on every pair.
  for (const x of devices) for (const pc of live(x)) pc.createDataChannel('stray');
  await wait(300);
  const heard = new Set<string>();
  const stopHeard = devices.map((x) =>
    x.mesh.onMessage((peer, m) => {
      if ((m as { t: string }).t === 'probe') heard.add(`${peer}>${x.id}`);
    }),
  );
  for (const x of devices) x.mesh.broadcast({ t: 'probe' } as unknown as WireMessage);
  await until('probe crosses all 12 directions', () => heard.size === 12);
  for (const stop of stopHeard) stop();
  results.directionsAfterGlare = heard.size;

  const last = d.author.emit('task.released', { taskId: 't', reason: 'after everything' });
  d.sync.nudge();
  await until('final event spreads', () => devices.every((x) => x.log.has(last.id)));

  results.finalLogSize = a.log.size;
  results.identicalHistories = devices.every(
    (x) => JSON.stringify(x.log.all().map((e: AnyEvent) => e.id)) === JSON.stringify(a.log.all().map((e: AnyEvent) => e.id)),
  );
  for (const x of devices) {
    x.sync.stop();
    x.mesh.stop();
  }
  await wait(50);
  results.connectionsLeftAfterStop = devices.reduce((n, x) => n + live(x).length, 0);
  return results;
}

(window as unknown as { runChecks: typeof run }).runChecks = run;
