import { auditRights, conservation, deriveTokens } from '@afterlink/authority';
import { custodiansOf, reduce, validateCapsule, verifyCredential } from '@afterlink/mission';
import { canonicalize, verifyEvent } from '@afterlink/protocol';
import { buildMissionRecord } from '@afterlink/reconcile';
import type {
  ActorId,
  AnyEvent,
  ConflictRecord,
  DecisionRecord,
  EventId,
  EventType,
  MissionCapsule,
  MissionId,
  MissionState,
  ResourceId,
  TaskId,
  TaskSpec,
  TeamId,
  TokenId,
  TransferId,
} from '@afterlink/protocol';
import { compareEvents, FORMAT, sealOf, type MissionFile, type RosterEntry } from './file.ts';
import { fingerprintWords, missionFingerprint, missionHeads, type ActorHead } from './fingerprint.ts';

/** Actors may sign this observation to record losing or regaining the observer. Value: boolean. */
export const HQ_CONTACT_KEY = 'hq.contact';

export type CheckId =
  | 'file'
  | 'issuer'
  | 'signatures'
  | 'chains'
  | 'credentials'
  | 'causal'
  | 'seal'
  | 'conservation'
  | 'exclusive'
  | 'authority'
  | 'visibility';

/** `skip`: not run, because an earlier check already failed. `none`: the file holds no evidence either way. */
export type CheckStatus = 'pass' | 'fail' | 'skip' | 'none';

export interface Finding {
  event?: EventId;
  actor?: ActorId;
  /** Team name, or the issuer, or a shortened key. */
  who?: string;
  seq?: number;
  type?: EventType;
  reason: string;
}

export interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
  findings: Finding[];
}

export interface BlindTask {
  taskId: TaskId;
  title: string;
  who: string;
  event: EventId;
}

export interface Visibility {
  /** Where the answer comes from: events the teams signed, the observer's unsigned log, or both. */
  basis: 'signed' | 'observer' | 'both' | 'none';
  completed: number;
  blind: BlindTask[];
}

/** What kept going while the network did not, counted from the events themselves. */
export interface Continuity {
  completed: number;
  withoutHq: number;
  refusedUnsafe: number;
  duplicatesPrevented: number;
  partitions: number;
  conflictsKept: number;
  /** What this history cannot settle, stated rather than guessed. */
  unknowns: string[];
}

export interface Verdict {
  ok: boolean;
  plain: string;
  mission: MissionId | null;
  name: string | null;
  issuer: ActorId | null;
  events: number;
  actors: number;
  heads: ActorHead[];
  /** Null unless every event is authentic: a fingerprint of forged events would mean nothing. */
  root: string | null;
  words: string[] | null;
  checks: Check[];
  failure: Finding | null;
  visibility: Visibility | null;
  continuity: Continuity | null;
  /** Policy conflicts: both sides stay on record, and no invariant was broken. */
  notes: string[];
}

export type Step =
  | { kind: 'start'; id: CheckId; label: string }
  | { kind: 'progress'; id: CheckId; done: number; total: number }
  | { kind: 'done'; check: Check };

export interface VerifyOptions {
  /** Pin the root of trust. Without it, the verdict reports which issuer key it rests on. */
  issuer?: ActorId;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'mission.issued',
  'actor.joined',
  'task.created',
  'task.claimed',
  'task.accepted',
  'task.completed',
  'task.deferred',
  'task.refused',
  'task.released',
  'task.covered',
  'right.committed',
  'right.offered',
  'right.accepted',
  'right.declined',
  'observation.recorded',
  'link.changed',
  'ferry.received',
  'conflict.resolved',
]);

const FILE_KEYS = ['format', 'v', 'mission', 'capsule', 'roster', 'hqSeen', 'seal', 'events'];
const PROGRESS_EVERY = 16;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const short = (id: string): string => id.slice(0, 8);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sentence = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const seatKey = (actor: ActorId, task: TaskId): string => `${actor} ${task}`;

type Clock = Map<ActorId, number>;
type Outcome = { detail: string; findings: Finding[]; status?: CheckStatus };

interface TokenCell {
  id: TokenId;
  resource: ResourceId;
  holder: ActorId | null;
  state: 'held' | 'in-transit' | 'committed';
  committedTo?: TaskId;
  transfer?: TransferId;
  /** The last move of this token. Anyone moving it next must have seen this. */
  last: AnyEvent | null;
}

interface Transfer {
  offer: AnyEvent;
  from: ActorId;
  to: ActorId;
  tokens: TokenId[];
  answer?: AnyEvent;
}

interface Commitment {
  event: AnyEvent;
  resource: ResourceId;
  /** Position in the committer's chain where it was handed back. */
  releasedAt?: number;
}

interface Replay {
  cells: Map<TokenId, TokenCell>;
  custodians: Record<TeamId, ActorId>;
  minted: Finding[];
  exclusive: Finding[];
  moves: number;
  commits: Map<string, Commitment[]>;
}

/** Everything one verification run learns, in the order the checks learn it. */
class Run {
  file: MissionFile | null = null;
  events: AnyEvent[] = [];
  byId = new Map<EventId, AnyEvent>();
  capsule: MissionCapsule | null = null;
  roster = new Map<ActorId, RosterEntry>();
  clocks = new Map<EventId, Clock>();
  lengths = new Map<ActorId, number>();
  replay: Replay | null = null;
  state: MissionState | null = null;
  visibility: Visibility | null = null;
  continuity: Continuity | null = null;

  /** Labels only. Before the capsule is verified these come from the file header. */
  who(actor: ActorId): string {
    const capsule = this.capsule ?? this.file?.capsule;
    if (actor === capsule?.issuer) return 'Issuer';
    const team = this.roster.get(actor)?.team;
    const teams = Array.isArray(capsule?.teams) ? capsule.teams : [];
    return teams.find((t) => t.id === team)?.name ?? `Device ${short(actor)}`;
  }

  at(e: AnyEvent, reason: string): Finding {
    return { event: e.id, actor: e.actor, who: this.who(e.actor), seq: e.seq, type: e.type, reason };
  }

  saw(e: AnyEvent, other: AnyEvent): boolean {
    return (this.clocks.get(e.id)?.get(other.actor) ?? 0) >= other.seq;
  }

  title(task: TaskId): string {
    return this.specs().get(task)?.title ?? task;
  }

  private specCache: Map<TaskId, TaskSpec> | null = null;

  private specs(): Map<TaskId, TaskSpec> {
    if (this.specCache) return this.specCache;
    const specs = new Map<TaskId, TaskSpec>((this.capsule?.tasks ?? []).map((t) => [t.id, t]));
    for (const e of this.events) if (e.type === 'task.created' && !specs.has(e.body.spec.id)) specs.set(e.body.spec.id, e.body.spec);
    return (this.specCache = specs);
  }
}

// ---------- Reading the file ----------

function decode(input: string | Uint8Array): string {
  const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** A damaged line still names its event, because the fields before the damage are readable. */
function locateDamage(text: string): Finding {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.replace(/,$/, '');
    if (line.length < 3) continue;
    try {
      JSON.parse(line);
    } catch {
      const event = /"id":"([\w-]+)"/.exec(line)?.[1];
      const seq = Number(/"seq":(\d+)/.exec(line)?.[1] ?? NaN);
      const finding: Finding = { reason: `Line ${i + 1} of the file is damaged and cannot be read` };
      if (event) finding.event = event;
      if (Number.isSafeInteger(seq)) finding.seq = seq;
      return finding;
    }
  }
  return { reason: 'The file is damaged and cannot be read' };
}

function parseFile(input: string | Uint8Array | MissionFile): MissionFile | Finding {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) return input;
  let text: string;
  try {
    text = decode(input);
  } catch {
    return { reason: 'The file is not valid text' };
  }
  try {
    return JSON.parse(text) as MissionFile;
  } catch {
    return locateDamage(text);
  }
}

function headerProblem(f: unknown): string | null {
  if (!isRecord(f)) return 'This is not a mission file';
  if (f.format !== FORMAT) return 'This is not a mission file';
  if (f.v !== 1) return `Unsupported file version ${String(f.v)}`;
  if (typeof f.mission !== 'string' || !f.mission) return 'The file names no mission';
  if (!isRecord(f.capsule)) return 'The file has no capsule';
  if (!Array.isArray(f.roster) || f.roster.some((r) => !isRecord(r) || !isRecord(r.credential))) return 'The roster cannot be read';
  if (f.hqSeen !== null && (!Array.isArray(f.hqSeen) || f.hqSeen.some((id) => typeof id !== 'string'))) return 'The observer log cannot be read';
  if (typeof f.seal !== 'string') return 'The file has no seal';
  if (!Array.isArray(f.events)) return 'The file has no events';
  const unknown = Object.keys(f).find((k) => !FILE_KEYS.includes(k));
  return unknown ? `The file has an unknown field "${unknown}"` : null;
}

function checkFile(run: Run, input: string | Uint8Array | MissionFile): Outcome {
  const parsed = parseFile(input);
  if ('reason' in parsed) return { detail: parsed.reason, findings: [parsed as Finding] };
  const problem = headerProblem(parsed);
  if (problem) return { detail: problem, findings: [{ reason: problem }] };
  const file = parsed as MissionFile;
  run.file = file;

  const findings: Finding[] = [];
  const seen = new Set<string>();
  file.events.forEach((e: unknown, i) => {
    if (!isRecord(e) || typeof e.id !== 'string' || typeof e.actor !== 'string') {
      findings.push({ reason: `Entry ${i + 1} is not a complete event` });
      return;
    }
    const event = e as unknown as AnyEvent;
    const key = canonicalize(event);
    if (seen.has(key)) return;
    seen.add(key);
    if (!EVENT_TYPES.has(event.type)) {
      findings.push({ event: event.id, actor: event.actor, reason: `Unknown event type "${String(event.type)}"` });
      return;
    }
    run.events.push(event);
  });
  run.events.sort(compareEvents);
  run.byId = new Map(run.events.map((e) => [e.id, e]));
  for (const r of file.roster) run.roster.set(r.actor, r);
  return { detail: plural(run.events.length, 'event'), findings };
}

// ---------- Authenticity ----------

function checkIssuer(run: Run, opts: VerifyOptions): Outcome {
  const file = run.file!;
  const geneses = run.events.filter((e) => e.type === 'mission.issued');
  const findings: Finding[] = [];
  if (geneses.length === 0) return { detail: 'No issue event', findings: [{ reason: 'The file has no mission.issued event' }] };
  for (const extra of geneses.slice(1)) findings.push(run.at(extra, 'A second mission issue in one history'));
  const genesis = geneses[0]!;
  const capsule = genesis.type === 'mission.issued' ? genesis.body.capsule : null;
  const checked = validateCapsule(capsule);
  if (!checked.ok) return { detail: 'Capsule is invalid', findings: [run.at(genesis, `The capsule is invalid: ${checked.errors[0]}`)] };
  run.capsule = checked.capsule;

  if (genesis.actor !== checked.capsule.issuer) findings.push(run.at(genesis, 'The capsule was not signed by its own issuer key'));
  if (checked.capsule.id !== genesis.mission) findings.push(run.at(genesis, 'The capsule and its event name different missions'));
  if (genesis.seq !== 1) findings.push(run.at(genesis, 'The issue event is not first in the issuer chain'));
  if (canonicalize(file.capsule) !== canonicalize(checked.capsule)) findings.push({ reason: 'The capsule in the file differs from the capsule the issuer signed' });
  if (file.mission !== checked.capsule.id) findings.push({ reason: 'The file names a different mission from the signed capsule' });
  if (opts.issuer && opts.issuer !== checked.capsule.issuer) findings.push(run.at(genesis, `Issued by ${short(checked.capsule.issuer)}, not the expected key ${short(opts.issuer)}`));
  for (const e of run.events) if (e.mission !== checked.capsule.id) findings.push(run.at(e, 'This event belongs to a different mission'));
  return { detail: short(checked.capsule.issuer), findings };
}

const PLAIN_REASONS: Record<string, string> = {
  'id does not match content': 'Its contents do not match its hash',
  'bad signature': 'Its signature does not match its signer',
};

function* checkSignatures(run: Run): Generator<Step, Outcome> {
  const findings: Finding[] = [];
  const total = run.events.length;
  for (let i = 0; i < total; i++) {
    const e = run.events[i]!;
    const result = verifyEvent(e);
    if (!result.ok) findings.push(run.at(e, PLAIN_REASONS[result.reason] ?? `It cannot be verified: ${result.reason}`));
    if ((i + 1) % PROGRESS_EVERY === 0) yield { kind: 'progress', id: 'signatures', done: i + 1, total };
  }
  return { detail: `${total - findings.length} of ${total} valid`, findings };
}

function checkChains(run: Run): Outcome {
  const findings: Finding[] = [];
  const chains = new Map<ActorId, AnyEvent[]>();
  for (const e of run.events) {
    const chain = chains.get(e.actor);
    if (chain) chain.push(e);
    else chains.set(e.actor, [e]);
  }
  for (const [actor, chain] of chains) {
    chain.sort((a, b) => a.seq - b.seq);
    let previous: AnyEvent | undefined;
    for (const e of chain) {
      if (previous?.seq === e.seq) {
        findings.push(run.at(e, `${run.who(actor)} signed two different events at position ${e.seq}`));
        continue;
      }
      const expected = (previous?.seq ?? 0) + 1;
      if (e.seq !== expected) findings.push(run.at(e, `Position ${expected} of this chain is missing`));
      else if (e.prev !== (previous?.id ?? null)) findings.push(run.at(e, 'Its link to the previous event is broken'));
      previous = e;
    }
    run.lengths.set(actor, previous?.seq ?? 0);
  }
  return { detail: `${chains.size}, no gaps or forks`, findings };
}

function checkCredentials(run: Run): Outcome {
  const capsule = run.capsule!;
  const findings: Finding[] = [];
  const entries = run.file!.roster;
  const teams = new Set(capsule.teams.map((t) => t.id));
  const custodians = new Map<TeamId, number>();
  const seen = new Set<ActorId>();
  for (const r of entries) {
    const c = r.credential;
    const fail = (reason: string) => findings.push({ actor: r.actor, who: r.name, reason });
    if (seen.has(r.actor)) fail(`${r.name} is listed twice on the roster`);
    seen.add(r.actor);
    if (!teams.has(r.team)) fail(`${r.name} belongs to a team the capsule does not have`);
    if (c.actor !== r.actor || c.team !== r.team || c.custodian !== r.custodian || c.mission !== capsule.id) fail(`The roster entry for ${r.name} does not match its credential`);
    if (!verifyCredential(c, capsule.issuer)) fail(`The credential for ${r.name} was not signed by the issuer`);
    if (r.custodian) custodians.set(r.team, (custodians.get(r.team) ?? 0) + 1);
  }
  for (const t of capsule.teams) {
    const n = custodians.get(t.id) ?? 0;
    if (n !== 1) findings.push({ reason: `${t.name} has ${n} custodians where the mission requires exactly one` });
  }
  const signers = new Set<ActorId>();
  for (const e of run.events) {
    if (e.actor === capsule.issuer) continue;
    const entry = run.roster.get(e.actor);
    if (!entry) {
      if (!signers.has(e.actor)) findings.push(run.at(e, 'Signed by a key the issuer never credentialed'));
      signers.add(e.actor);
      continue;
    }
    if (e.type !== 'actor.joined') continue;
    if (e.body.team !== entry.team || e.body.name !== entry.name || canonicalize(e.body.credential) !== canonicalize(entry.credential)) {
      findings.push(run.at(e, 'This join event does not match the roster'));
    }
  }
  return { detail: `${entries.length} of ${entries.length}`, findings };
}

function decisionOf(e: AnyEvent): DecisionRecord | null {
  const decision = (e.body as { decision?: unknown }).decision;
  return isRecord(decision) ? (decision as unknown as DecisionRecord) : null;
}

function checkCausal(run: Run): Outcome {
  const capsule = run.capsule!;
  const findings: Finding[] = [];
  let links = 0;
  for (const e of run.events) {
    const clock: Clock = new Map();
    for (const dep of [...(e.prev ? [e.prev] : []), ...e.parents]) {
      links += 1;
      const cause = run.byId.get(dep);
      if (!cause) {
        if (dep !== e.prev) findings.push(run.at(e, `It depends on event ${short(dep)}, which is not in this file`));
        continue;
      }
      if (cause.lamport >= e.lamport) findings.push(run.at(e, `Its clock does not advance past event ${short(dep)}, which it depends on`));
      for (const [actor, seq] of run.clocks.get(dep) ?? []) if (seq > (clock.get(actor) ?? 0)) clock.set(actor, seq);
    }
    clock.set(e.actor, Math.max(clock.get(e.actor) ?? 0, e.seq));
    run.clocks.set(e.id, clock);
    if (e.type !== 'mission.issued' && (clock.get(capsule.issuer) ?? 0) < 1) findings.push(run.at(e, 'It does not descend from the mission issue'));

    const horizon = decisionOf(e)?.horizon;
    if (!isRecord(horizon)) continue;
    for (const [actor, seq] of Object.entries(horizon)) {
      if (typeof seq !== 'number') continue;
      if (seq > (run.lengths.get(actor) ?? 0)) findings.push(run.at(e, `Its decision cites ${run.who(actor)} event ${seq}, which is not in this file`));
      else if (seq > (clock.get(actor) ?? 0)) findings.push(run.at(e, `Its decision claims to know ${run.who(actor)} event ${seq}, which it had not received`));
    }
  }
  return { detail: plural(links, 'link'), findings };
}

function checkSeal(run: Run): Outcome {
  const file = run.file!;
  const findings: Finding[] = [];
  const ids = file.hqSeen ?? [];
  for (const id of ids) if (!run.byId.has(id)) findings.push({ event: id, reason: `The observer log lists event ${short(id)}, which is not in this file` });
  if (findings.length === 0 && sealOf(missionFingerprint(run.events), file.roster, file.hqSeen) !== file.seal) {
    findings.push({ reason: 'The file changed after export: its events, roster or observer log no longer match its seal' });
  }
  return { detail: 'Unchanged since export', findings };
}

// ---------- Replaying the rights ----------

function replayRights(run: Run): Replay {
  const capsule = run.capsule!;
  const genesis = run.events.find((e) => e.type === 'mission.issued');
  const custodians = (genesis?.body as { custodians?: Record<TeamId, ActorId> } | undefined)?.custodians ?? custodiansOf(run.file!.roster);
  const cells = new Map<TokenId, TokenCell>();
  for (const r of capsule.resources) {
    for (const t of r.tokens) cells.set(t.id, { id: t.id, resource: r.id, holder: custodians[t.holderTeam] ?? null, state: 'held', last: null });
  }
  const transfers = new Map<TransferId, Transfer>();
  const minted: Finding[] = [];
  const exclusive: Finding[] = [];
  const commits: Replay['commits'] = new Map();
  const answered = new Set<string>();
  for (const e of run.events) if (e.type === 'right.accepted' || e.type === 'right.declined') answered.add(seatKey(e.actor, e.body.transfer));
  let moves = 0;

  const blocked = (e: AnyEvent, cell: TokenCell): string | null => {
    if (cell.state === 'committed') return `${cell.id} was already committed to ${run.title(cell.committedTo ?? '')}`;
    if (cell.state === 'in-transit') return `${cell.id} was in transit and belongs to nobody yet`;
    if (cell.holder !== e.actor) return `${run.who(e.actor)} does not hold ${cell.id}`;
    if (cell.last && !run.saw(e, cell.last)) return `${run.who(e.actor)} moved ${cell.id} before it could know it held it`;
    return null;
  };

  for (const e of run.events) {
    if (e.type === 'right.committed' || e.type === 'right.offered') {
      const ids = Array.isArray(e.body.tokens) ? [...new Set(e.body.tokens)] : [];
      const usable: TokenCell[] = [];
      for (const id of ids) {
        const cell = cells.get(id);
        if (!cell) {
          minted.push(run.at(e, `It uses ${id}, a right the mission never issued`));
          continue;
        }
        const reason = blocked(e, cell);
        if (reason) exclusive.push(run.at(e, reason));
        else usable.push(cell);
      }
      if (e.type === 'right.offered' && transfers.has(e.body.transfer)) {
        exclusive.push(run.at(e, 'It reuses the id of another transfer'));
        continue;
      }
      if (usable.length !== ids.length) continue;
      moves += 1;
      for (const cell of usable) {
        cell.last = e;
        if (e.type === 'right.committed') {
          cell.state = 'committed';
          cell.committedTo = e.body.taskId;
          const key = seatKey(e.actor, e.body.taskId);
          commits.set(key, [...(commits.get(key) ?? []), { event: e, resource: cell.resource }]);
        } else {
          cell.state = 'in-transit';
          cell.holder = null;
          cell.transfer = e.body.transfer;
        }
      }
      if (e.type === 'right.offered') transfers.set(e.body.transfer, { offer: e, from: e.actor, to: e.body.to, tokens: ids });
    } else if (e.type === 'right.accepted' || e.type === 'right.declined') {
      const transfer = transfers.get(e.body.transfer);
      if (!transfer) exclusive.push(run.at(e, 'It answers a transfer nobody offered'));
      else if (e.actor !== transfer.to) exclusive.push(run.at(e, `${run.who(e.actor)} answered a transfer addressed to ${run.who(transfer.to)}`));
      else if (!run.saw(e, transfer.offer)) exclusive.push(run.at(e, 'It answers an offer it had not received'));
      else if (transfer.answer) exclusive.push(run.at(e, `${run.who(e.actor)} answered one transfer twice`));
      else {
        transfer.answer = e;
        moves += 1;
        for (const id of transfer.tokens) {
          const cell = cells.get(id)!;
          cell.state = 'held';
          cell.holder = e.type === 'right.accepted' ? transfer.to : transfer.from;
          delete cell.transfer;
          cell.last = e;
        }
      }
    } else if (e.type === 'task.released') {
      for (const cell of cells.values()) {
        if (cell.state !== 'committed' || cell.holder !== e.actor || cell.committedTo !== e.body.taskId || !run.saw(e, cell.last!)) continue;
        cell.state = 'held';
        delete cell.committedTo;
        cell.last = e;
        moves += 1;
      }
      for (const c of commits.get(seatKey(e.actor, e.body.taskId)) ?? []) c.releasedAt ??= e.seq;
    } else if (e.type === 'conflict.resolved') {
      const ruling = (e.body as { tokenHolder?: { tokenId: TokenId; holder: ActorId } }).tokenHolder;
      if (!ruling) continue;
      if (e.actor !== capsule.issuer) {
        exclusive.push(run.at(e, `${run.who(e.actor)} ruled on a right without the authority to`));
        continue;
      }
      const cell = cells.get(ruling.tokenId);
      const to = cell?.transfer ? transfers.get(cell.transfer)?.to : undefined;
      if (!cell || cell.state !== 'in-transit' || !run.roster.has(ruling.holder) || !run.saw(e, cell.last!) || !to || answered.has(seatKey(to, cell.transfer!))) continue;
      cell.state = 'held';
      cell.holder = ruling.holder;
      delete cell.transfer;
      cell.last = e;
      moves += 1;
    }
  }
  return { cells, custodians, minted, exclusive, commits, moves };
}

function checkConservation(run: Run): Outcome {
  const capsule = run.capsule!;
  const replay = (run.replay = replayRights(run));
  const state = (run.state = reduce(run.events, run.file!.roster));
  const findings = [...replay.minted];

  // A move the replay refused is named exactly by the next check, so the ledgers are compared only without one.
  if (replay.exclusive.length === 0) {
    const derived = deriveTokens(capsule, run.events, replay.custodians).tokens;
    for (const cell of replay.cells.values()) {
      const other = derived[cell.id];
      if (other?.state !== cell.state || other.holder !== cell.holder || other.committedTo !== cell.committedTo) {
        findings.push({ reason: `Two independent replays disagree about ${cell.id}` });
      }
    }
    for (const row of conservation(state, auditRights(capsule, run.events, replay.custodians))) {
      if (!row.ok) findings.push({ reason: `${row.resource}: ${row.issued} issued, and the rights do not add up` });
    }
  }

  const count = (s: TokenCell['state']) => [...replay.cells.values()].filter((c) => c.state === s).length;
  return { detail: `${replay.cells.size} issued: ${count('committed')} committed, ${count('held')} held, ${count('in-transit')} in transit`, findings };
}

/** A violation the state reducer found that the replay above did not already pin to the same event. */
function fromConflicts(run: Run, keep: (c: ConflictRecord) => boolean, known: Finding[]): Finding[] {
  const out: Finding[] = [];
  const pinned = new Set(known.map((f) => f.event));
  for (const c of run.state?.conflicts ?? []) {
    if (c.severity !== 'violation' || !keep(c)) continue;
    const e = c.events.map((id) => run.byId.get(id)).filter((x) => x !== undefined).at(-1);
    if (e && pinned.has(e.id)) continue;
    out.push(e ? run.at(e, c.summary.replace(/\.$/, '')) : { reason: c.summary.replace(/\.$/, '') });
  }
  return out;
}

function checkExclusive(run: Run): Outcome {
  const replay = run.replay!;
  const findings = [...replay.exclusive, ...fromConflicts(run, (c) => c.kind === 'token-fork', replay.exclusive)];
  return { detail: `${plural(replay.moves, 'move')} replayed`, findings };
}

// ---------- Authority at the moment of action ----------

function checkAuthority(run: Run): Outcome {
  const capsule = run.capsule!;
  const findings: Finding[] = [];
  const capabilities = new Map(capsule.teams.map((t) => [t.id, new Set(t.capabilities)]));
  const known = new Map<TaskId, { spec: TaskSpec; origins: AnyEvent[] }>();
  const genesis = run.events.find((e) => e.type === 'mission.issued')!;
  for (const spec of capsule.tasks) known.set(spec.id, { spec, origins: [genesis] });
  const spawned = (spec: TaskSpec, origin: AnyEvent) => {
    const entry = known.get(spec.id);
    if (entry) entry.origins.push(origin);
    else known.set(spec.id, { spec, origins: [origin] });
  };
  const seats = new Set<string>();
  let actions = 0;

  const fits = (e: AnyEvent, task: TaskId, spec: TaskSpec, verb: string): boolean => {
    const skills = capabilities.get(run.roster.get(e.actor)?.team ?? '');
    if (!skills) {
      findings.push(run.at(e, `${run.who(e.actor)} ${verb} ${run.title(task)} but is not on the roster`));
      return false;
    }
    const missing = spec.requires.find((c) => !skills.has(c));
    if (missing === undefined) return true;
    findings.push(run.at(e, `${run.who(e.actor)} ${verb} ${run.title(task)} without the skill ${missing}`));
    return false;
  };

  for (const e of run.events) {
    if (e.type === 'task.created') {
      spawned(e.body.spec, e);
      continue;
    }
    if (e.type === 'observation.recorded') {
      const { key, value } = e.body.observation;
      for (const rule of capsule.contingencies) {
        if (rule.when.key === key && canonicalize(rule.when.equals) === canonicalize(value)) for (const spec of rule.then.spawn ?? []) spawned(spec, e);
      }
      continue;
    }
    if (!e.type.startsWith('task.') && e.type !== 'right.committed') continue;
    const taskId = (e.body as { taskId: TaskId }).taskId;
    const entry = known.get(taskId);
    actions += 1;
    if (!entry) {
      findings.push(run.at(e, 'It acts on a task that does not exist'));
      continue;
    }
    if (!entry.origins.some((o) => run.saw(e, o))) {
      findings.push(run.at(e, `It acts on ${run.title(taskId)} before that task reached ${run.who(e.actor)}`));
      continue;
    }
    const { spec } = entry;
    const seat = seatKey(e.actor, taskId);
    switch (e.type) {
      case 'task.claimed':
        if (fits(e, taskId, spec, 'took')) seats.add(seat);
        break;
      case 'task.covered':
        if (spec.priority > capsule.fallback.coverMaxPriority) findings.push(run.at(e, `${run.title(taskId)} is not urgent enough to cover without a person`));
        else if (fits(e, taskId, spec, 'covered')) seats.add(seat);
        break;
      case 'task.released':
        seats.delete(seat);
        break;
      case 'task.accepted':
      case 'task.completed': {
        const verb = e.type === 'task.accepted' ? 'accepted' : 'completed';
        if (!seats.has(seat)) {
          findings.push(run.at(e, `${run.who(e.actor)} ${verb} ${run.title(taskId)} without holding it`));
          break;
        }
        if (e.body.via === 'auto' && capsule.fallback.humanApprovalKinds.includes(spec.kind)) findings.push(run.at(e, `${run.title(taskId)} needs a person, and it was ${verb} automatically`));
        const spent = (run.replay!.commits.get(seat) ?? []).filter((c) => c.event.seq < e.seq && (c.releasedAt ?? Infinity) > e.seq);
        for (const need of spec.needs) {
          const have = spent.filter((c) => c.resource === need.resource).length;
          if (have < need.count) findings.push(run.at(e, `${run.who(e.actor)} ${verb} ${run.title(taskId)} holding ${have} of ${need.count} ${need.resource} rights at that moment`));
        }
        break;
      }
    }
  }
  const all = [...findings, ...fromConflicts(run, (c) => c.kind !== 'token-fork', findings)];
  return { detail: plural(actions, 'action'), findings: all };
}

// ---------- HQ visibility ----------

/** Positions in each actor's chain that the actor itself signed as out of contact with the observer. */
function signedBlindness(run: Run): Map<ActorId, [number, number][]> {
  const spans = new Map<ActorId, [number, number][]>();
  const open = new Map<ActorId, number>();
  for (const e of [...run.events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== 'observation.recorded' || e.body.observation.key !== HQ_CONTACT_KEY) continue;
    const up = e.body.observation.value === true;
    const from = open.get(e.actor);
    if (!up && from === undefined) open.set(e.actor, e.seq);
    if (up && from !== undefined) {
      spans.set(e.actor, [...(spans.get(e.actor) ?? []), [from, e.seq]]);
      open.delete(e.actor);
    }
  }
  for (const [actor, from] of open) spans.set(actor, [...(spans.get(actor) ?? []), [from, Number.POSITIVE_INFINITY]]);
  return spans;
}

function checkVisibility(run: Run): Outcome {
  const hqSeen = run.file!.hqSeen;
  const seen = hqSeen === null ? null : new Set(hqSeen);
  const spans = signedBlindness(run);
  const completions = run.events.filter((e) => e.type === 'task.completed');
  const tasks = new Set<TaskId>();
  const blind = new Map<TaskId, BlindTask>();
  for (const e of completions) {
    if (e.type !== 'task.completed') continue;
    tasks.add(e.body.taskId);
    const signed = (spans.get(e.actor) ?? []).some(([from, to]) => e.seq > from && e.seq < to);
    if ((signed || (seen !== null && !seen.has(e.id))) && !blind.has(e.body.taskId)) {
      blind.set(e.body.taskId, { taskId: e.body.taskId, title: run.title(e.body.taskId), who: run.who(e.actor), event: e.id });
    }
  }
  const basis = spans.size > 0 ? (seen ? 'both' : 'signed') : seen ? 'observer' : 'none';
  run.visibility = { basis, completed: tasks.size, blind: [...blind.values()] };
  const fieldEvents = run.events.filter((e) => e.type !== 'mission.issued');
  const record = buildMissionRecord({ events: fieldEvents, state: run.state!, hqSeen: hqSeen ?? [] });
  run.continuity = {
    completed: tasks.size,
    withoutHq: blind.size,
    refusedUnsafe: record.refusedUnsafe,
    duplicatesPrevented: record.duplicatesPrevented,
    partitions: record.episodes.length,
    conflictsKept: record.conflicts.filter((c) => c.severity === 'policy').length,
    unknowns: record.unknowns,
  };
  if (basis === 'none') return { detail: 'No observer record', findings: [], status: 'none' };
  const source = basis === 'observer' ? 'observer log, unsigned' : 'signed by the teams';
  return { detail: `${blind.size} of ${plural(tasks.size, 'task')} (${source})`, findings: [] };
}

// ---------- The run ----------

const STAGES: { id: CheckId; label: string }[] = [
  { id: 'file', label: 'File format' },
  { id: 'signatures', label: 'Signatures' },
  { id: 'issuer', label: 'Issuer key' },
  { id: 'chains', label: 'Hash chains' },
  { id: 'credentials', label: 'Issuer credentials' },
  { id: 'causal', label: 'Causal order' },
  { id: 'seal', label: 'File seal' },
  { id: 'conservation', label: 'Rights conserved' },
  { id: 'exclusive', label: 'Rights committed once' },
  { id: 'authority', label: 'Authority' },
  { id: 'visibility', label: 'Work outside HQ visibility' },
];

function plainVerdict(run: Run, failure: Finding | null, ok: boolean): string {
  if (failure) {
    const place = failure.who && failure.seq !== undefined ? `${failure.who} event ${failure.seq}${failure.type ? ` (${failure.type})` : ''}: ` : '';
    return `Not valid. ${place}${place ? sentence(failure.reason) : failure.reason}.`;
  }
  if (!ok) return 'Not valid.';
  const v = run.visibility;
  const blind = v && v.basis !== 'none' ? ` ${v.blind.length} of ${plural(v.completed, 'task')} done with no HQ visibility.` : '';
  const teams = new Set(run.events.map((e) => run.roster.get(e.actor)?.team).filter((t) => t !== undefined));
  return `Valid. ${plural(run.events.length, 'event')} from ${plural(teams.size, 'team')}, every invariant held.${blind}`;
}

/** Yields each check as it really runs, so a screen can show the work as it happens. */
export function* verifySteps(input: string | Uint8Array | MissionFile, opts: VerifyOptions = {}): Generator<Step, Verdict> {
  const run = new Run();
  const checks: Check[] = [];

  for (const { id, label } of STAGES) {
    yield { kind: 'start', id, label };
    let outcome: Outcome;
    if (checks.some((c) => c.status === 'fail')) {
      outcome = { detail: 'Not checked', findings: [], status: 'skip' };
    } else {
      try {
        switch (id) {
          case 'file': outcome = checkFile(run, input); break;
          case 'issuer': outcome = checkIssuer(run, opts); break;
          case 'signatures': outcome = yield* checkSignatures(run); break;
          case 'chains': outcome = checkChains(run); break;
          case 'credentials': outcome = checkCredentials(run); break;
          case 'causal': outcome = checkCausal(run); break;
          case 'seal': outcome = checkSeal(run); break;
          case 'conservation': outcome = checkConservation(run); break;
          case 'exclusive': outcome = checkExclusive(run); break;
          case 'authority': outcome = checkAuthority(run); break;
          case 'visibility': outcome = checkVisibility(run); break;
        }
      } catch (err) {
        const reason = `This check could not finish: ${err instanceof Error ? err.message : 'unreadable data'}`;
        outcome = { detail: reason, findings: [{ reason }] };
      }
    }
    const status: CheckStatus = outcome.findings.length > 0 ? 'fail' : (outcome.status ?? 'pass');
    const lead = outcome.findings[0];
    const extra = outcome.findings.length > 1 ? ` (+${outcome.findings.length - 1} more)` : '';
    const detail = status === 'fail' && lead ? `${lead.reason}${extra}` : outcome.detail;
    const check: Check = { id, label, status, detail, findings: outcome.findings };
    checks.push(check);
    yield { kind: 'done', check };
  }

  const ok = checks.every((c) => c.status === 'pass' || c.status === 'none');
  const failure = checks.find((c) => c.status === 'fail')?.findings[0] ?? null;
  const signed = checks.find((c) => c.id === 'signatures')?.status === 'pass';
  const root = signed ? missionFingerprint(run.events) : null;
  const notes = (run.state?.conflicts ?? []).filter((c) => c.severity === 'policy').map((c) => c.summary);
  return {
    ok,
    plain: plainVerdict(run, failure, ok),
    mission: run.capsule?.id ?? null,
    name: run.capsule?.name ?? null,
    issuer: run.capsule?.issuer ?? null,
    events: run.events.length,
    actors: new Set(run.events.map((e) => e.actor)).size,
    heads: signed ? missionHeads(run.events) : [],
    root,
    words: root ? fingerprintWords(root) : null,
    checks,
    failure,
    visibility: run.visibility,
    continuity: run.continuity,
    notes,
  };
}

/** Same input, same verdict, on any machine. Never throws. */
export function verifyMission(input: string | Uint8Array | MissionFile, opts: VerifyOptions = {}): Verdict {
  const steps = verifySteps(input, opts);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
