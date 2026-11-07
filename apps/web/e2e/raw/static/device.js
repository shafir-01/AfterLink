const selfId = new URLSearchParams(location.search).get('id');
const links = new Map();
const refused = new Set();
const log = { candidates: [], portCloseEvents: 0, linkEvents: [], received: {} };
const pending = new Map();
let port = null;
let pings = 0;

function makeLink(peer) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const link = { pc, dc: null, createdAt: performance.now(), queued: [] };
  links.set(peer, link);
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    log.candidates.push({ peer, type: e.candidate.type, address: e.candidate.address, protocol: e.candidate.protocol });
    port?.postMessage({ t: 'signal', from: selfId, to: peer, data: { ice: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    log.linkEvents.push({ peer, kind: 'pc', state: pc.connectionState, at: performance.now() });
  };
  pc.ondatachannel = (e) => wire(peer, link, e.channel);
  return link;
}

function wire(peer, link, dc) {
  link.dc = dc;
  dc.onopen = () => {
    link.openedAt = performance.now();
    log.linkEvents.push({ peer, kind: 'dc', state: 'open', at: performance.now() });
  };
  dc.onclose = () => log.linkEvents.push({ peer, kind: 'dc', state: 'closed', at: performance.now() });
  dc.onmessage = (e) => {
    const { tag } = JSON.parse(e.data);
    const key = `${peer}:${tag}`;
    log.received[key] = (log.received[key] ?? 0) + 1;
  };
}

async function dial(peer) {
  if (refused.has(peer)) return;
  const link = makeLink(peer);
  wire(peer, link, link.pc.createDataChannel('link', { ordered: true }));
  await link.pc.setLocalDescription(await link.pc.createOffer());
  port.postMessage({ t: 'signal', from: selfId, to: peer, data: { sdp: link.pc.localDescription.toJSON() } });
}

async function onSignal({ from, data }) {
  if (refused.has(from)) return;
  if (data.sdp?.type === 'offer') {
    links.get(from)?.pc.close();
    const link = makeLink(from);
    await link.pc.setRemoteDescription(data.sdp);
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    port.postMessage({ t: 'signal', from: selfId, to: from, data: { sdp: link.pc.localDescription.toJSON() } });
    for (const c of link.queued.splice(0)) await link.pc.addIceCandidate(c);
    return;
  }
  const link = links.get(from);
  if (!link) return;
  if (data.sdp) {
    await link.pc.setRemoteDescription(data.sdp);
    for (const c of link.queued.splice(0)) await link.pc.addIceCandidate(c);
  } else if (data.ice) {
    if (link.pc.remoteDescription) await link.pc.addIceCandidate(data.ice);
    else link.queued.push(data.ice);
  }
}

function attach(p) {
  port = p;
  p.onmessage = (e) => {
    const m = e.data;
    if (m.t === 'peers') m.peers.forEach(dial);
    else if (m.t === 'signal') onSignal(m);
    else if (m.t === 'pong') pending.get(m.n)?.(true);
  };
  p.addEventListener('close', () => {
    log.portCloseEvents += 1;
  });
  p.postMessage({ t: 'hello', id: selfId });
}

addEventListener('message', (e) => {
  if (e.data?.t === 'port') attach(e.ports[0]);
});

async function selectedPair(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((r) => {
    if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
  });
  if (!pair) return null;
  const l = stats.get(pair.localCandidateId);
  const r = stats.get(pair.remoteCandidateId);
  return {
    local: `${l.candidateType}/${l.protocol}/${l.address ?? '?'}`,
    remote: `${r.candidateType}/${r.protocol}/${r.address ?? '?'}`,
    rttMs: pair.currentRoundTripTime === undefined ? null : pair.currentRoundTripTime * 1000,
    bytesSent: pair.bytesSent,
    bytesReceived: pair.bytesReceived,
  };
}

window.device = {
  id: selfId,
  log,
  links: () =>
    Object.fromEntries(
      [...links].map(([peer, { pc, dc }]) => [
        peer,
        { pc: pc.connectionState, ice: pc.iceConnectionState, dc: dc?.readyState ?? 'none' },
      ]),
    ),
  pairs: async () => {
    const out = {};
    for (const [peer, { pc }] of links) out[peer] = await selectedPair(pc);
    return out;
  },
  connectMs: () => Object.fromEntries([...links].map(([peer, l]) => [peer, Math.round(l.openedAt - l.createdAt)])),
  sendAll(tag, n) {
    let sent = 0;
    for (const { dc } of links.values()) {
      for (let i = 0; i < n; i += 1) {
        if (dc?.readyState === 'open') {
          dc.send(JSON.stringify({ tag, i }));
          sent += 1;
        }
      }
    }
    return sent;
  },
  send(peer, tag) {
    const dc = links.get(peer)?.dc;
    if (dc?.readyState !== 'open') return false;
    dc.send(JSON.stringify({ tag }));
    return true;
  },
  count: (peer, tag) => log.received[`${peer}:${tag}`] ?? 0,
  pingHub(ms) {
    return new Promise((resolve) => {
      if (!port) {
        resolve(false);
        return;
      }
      pings += 1;
      pending.set(pings, resolve);
      port.postMessage({ t: 'ping', n: pings });
      setTimeout(() => resolve(false), ms);
    });
  },
  askHubToClosePort: () => port.postMessage({ t: 'close-port' }),
  sever(peer) {
    refused.add(peer);
    links.get(peer)?.pc.close();
    links.delete(peer);
  },
  unblockAll: () => refused.clear(),
  rejoin(peers) {
    for (const peer of peers) if (!links.has(peer)) dial(peer);
  },
};
