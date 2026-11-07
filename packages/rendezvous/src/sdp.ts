/**
 * A data-channel SDP holds very little that differs between sessions: ICE credentials, a
 * certificate fingerprint and candidates. Everything else is rebuilt from a fixed template.
 */

export type CandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export const HASHES = ['sha-256', 'sha-384', 'sha-512', 'sha-1'] as const;
export type HashName = (typeof HASHES)[number];

export interface CompactCandidate {
  type: CandidateType;
  address: string;
  port: number;
}

export interface CompactSdp {
  ufrag: string;
  pwd: string;
  hash: HashName;
  fingerprint: Uint8Array;
  mid: string;
  candidates: CompactCandidate[];
}

/** Eight candidates still fit two QR frames. */
export const MAX_CANDIDATES = 8;

const TYPE_PREFERENCE: Record<CandidateType, number> = { host: 126, prflx: 110, srflx: 100, relay: 0 };

function parseCandidate(line: string): (CompactCandidate & { priority: number }) | null {
  const f = line.slice('a=candidate:'.length).trim().split(/\s+/);
  const [, component, transport, priority, address, port, typ, type] = f;
  if (component !== '1' || transport?.toLowerCase() !== 'udp' || typ !== 'typ') return null;
  if (!address || !(type === 'host' || type === 'srflx' || type === 'prflx' || type === 'relay')) return null;
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null;
  return { type, address, port: portNumber, priority: Number(priority) || 0 };
}

export function compactSdp(sdp: string, maxCandidates = MAX_CANDIDATES): CompactSdp {
  let ufrag: string | undefined;
  let pwd: string | undefined;
  let hash: HashName | undefined;
  let fingerprint: Uint8Array | undefined;
  let mid: string | undefined;
  const seen = new Set<string>();
  const found: (CompactCandidate & { priority: number })[] = [];

  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('a=ice-ufrag:')) ufrag ??= line.slice(12);
    else if (line.startsWith('a=ice-pwd:')) pwd ??= line.slice(10);
    else if (line.startsWith('a=mid:')) mid ??= line.slice(6);
    else if (line.startsWith('a=fingerprint:') && !fingerprint) {
      const [name, value] = line.slice(14).trim().split(/\s+/);
      const known = HASHES.find((h) => h === name?.toLowerCase());
      if (known && value) {
        hash = known;
        fingerprint = Uint8Array.from(value.split(':'), (b) => parseInt(b, 16));
      }
    } else if (line.startsWith('a=candidate:')) {
      const c = parseCandidate(line);
      const key = c && `${c.address}|${c.port}`;
      if (c && key && !seen.has(key)) {
        seen.add(key);
        found.push(c);
      }
    }
  }
  if (!ufrag || !pwd || !hash || !fingerprint) throw new Error('rendezvous: SDP lacks ICE credentials or a fingerprint');

  found.sort((a, b) => b.priority - a.priority);
  return {
    ufrag,
    pwd,
    hash,
    fingerprint,
    mid: mid ?? '0',
    candidates: found.slice(0, maxCandidates).map(({ type, address, port }) => ({ type, address, port })),
  };
}

function fingerprintText(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function candidateLine(c: CompactCandidate, index: number): string {
  const priority = TYPE_PREFERENCE[c.type] * 2 ** 24 + (0xffff - index) * 2 ** 8 + 255;
  const related = c.type === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
  return `a=candidate:${index + 1} 1 udp ${priority} ${c.address} ${c.port} typ ${c.type}${related}`;
}

/**
 * Rebuilds a remote description. The offer is declared `active` even though the offerer really
 * sent `actpass`, so the answerer goes passive and the offerer opens DTLS the moment its person
 * scans the reply. With default roles the answerer would start DTLS early and back off
 * exponentially while the QR is still being carried, stalling the link for many seconds.
 */
export function expandSdp(c: CompactSdp, role: 'offer' | 'answer'): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${c.mid}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...c.candidates.map(candidateLine),
    'a=end-of-candidates',
    `a=ice-ufrag:${c.ufrag}`,
    `a=ice-pwd:${c.pwd}`,
    `a=fingerprint:${c.hash} ${fingerprintText(c.fingerprint)}`,
    `a=setup:${role === 'offer' ? 'active' : 'passive'}`,
    `a=mid:${c.mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');
}
