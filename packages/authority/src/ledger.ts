import type {
  ActorId,
  AnyEvent,
  Capability,
  ConflictRecord,
  EventBodies,
  EventEnvelope,
  EventId,
  MissionCapsule,
  TaskId,
  TeamId,
  TokenId,
  TokenRecord,
  TransferId,
} from '@afterlink/protocol';
import { CausalPast, causalOrder } from './causal.ts';
import { resourcePhrase } from './words.ts';

/**
 * A token as the ledger derives it. While in transit `holder` is null and `from` and `to` name the
 * two parties: the right belongs to neither of them until the recipient answers.
 */
export interface LedgerToken extends TokenRecord {
  from?: ActorId;
  to?: ActorId;
  /** Who acted on a disputed token in good faith, on a branch that does not count. */
  affected?: ActorId[];
  /** One holder signed this token away twice, whether or not either move stood. */
  overspent?: true;
}

export interface DerivedTokens {
  tokens: Record<TokenId, LedgerToken>;
  violations: ConflictRecord[];
}

/** Issuer ruling on one token, carried on `conflict.resolved`. */
type Ruling = EventBodies['conflict.resolved'] & { tokenHolder?: { tokenId: TokenId; holder: ActorId } };

type Spend = EventEnvelope<'right.committed'> | EventEnvelope<'right.offered'>;
type Answer = EventEnvelope<'right.accepted'> | EventEnvelope<'right.declined'>;

interface Offer {
  event: EventEnvelope<'right.offered'>;
  to: ActorId;
  tokens: TokenId[];
  answer?: Answer;
  /** Present when the offer never took effect, naming why. */
  conflicts?: ConflictRecord[];
}

/** Two or more signed events from one actor at one sequence number: its history splits here. */
interface Fork {
  seq: number;
  events: AnyEvent[];
  /** Tokens its branches tried to spend. Each gets its own conflict. */
  named: Set<TokenId>;
  /** The conflict that also covers tokens frozen without being spent. */
  anchor?: TokenId;
}

interface Dispute {
  conflict: ConflictRecord;
  /** The issuer must have seen all of these for a ruling to count. */
  evidence: EventId[];
}

function findForks(ordered: AnyEvent[]): Map<ActorId, Fork> {
  const slots = new Map<string, AnyEvent[]>();
  for (const e of ordered) {
    const key = `${e.seq} ${e.actor}`;
    const slot = slots.get(key);
    if (slot) slot.push(e);
    else slots.set(key, [e]);
  }
  const forks = new Map<ActorId, Fork>();
  for (const events of slots.values()) {
    if (events.length < 2) continue;
    const { actor, seq } = events[0]!;
    const earliest = forks.get(actor);
    if (!earliest || seq < earliest.seq) forks.set(actor, { seq, events, named: new Set() });
  }
  for (const e of ordered) {
    const fork = forks.get(e.actor);
    if (!fork || e.seq < fork.seq) continue;
    if (e.type === 'right.committed' || e.type === 'right.offered') {
      for (const id of tokenList(e.body.tokens) ?? []) fork.named.add(id);
    }
  }
  return forks;
}

/** Capabilities each known task requires. A task id signed with two specs keeps both. */
function taskRequirements(capsule: MissionCapsule, ordered: AnyEvent[]): Map<TaskId, Capability[][]> {
  const needs = new Map<TaskId, Capability[][]>();
  const add = (id: TaskId, requires: Capability[]) => needs.set(id, [...(needs.get(id) ?? []), requires]);
  for (const spec of capsule.tasks) add(spec.id, spec.requires);
  for (const e of ordered) {
    if (e.type !== 'task.created') continue;
    const spec = e.body.spec;
    if (typeof spec?.id === 'string' && Array.isArray(spec.requires)) add(spec.id, spec.requires);
  }
  return needs;
}

/** A well formed list names at least one token, each of them once. */
function tokenList(tokens: unknown): TokenId[] | null {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  if (tokens.some((t) => typeof t !== 'string')) return null;
  return new Set(tokens).size === tokens.length ? (tokens as TokenId[]) : null;
}

function note(conflict: ConflictRecord, e: AnyEvent): void {
  if (!conflict.events.includes(e.id)) conflict.events.push(e.id);
  if (e.type === 'right.committed') conflict.taskId ??= e.body.taskId;
}

const seat = (actor: ActorId, key: string) => `${actor} ${key}`;

class Ledger {
  private readonly capsule: MissionCapsule;
  private readonly past: CausalPast;
  private readonly genesis: EventId | undefined;
  private readonly forks: Map<ActorId, Fork>;
  private readonly needs: Map<TaskId, Capability[][]>;
  private readonly tokens = new Map<TokenId, LedgerToken>();
  private readonly teams = new Map<ActorId, TeamId>();
  private readonly offers = new Map<TransferId, Offer[]>();
  private readonly answered = new Set<string>();
  private readonly frozen = new Set<ActorId>();
  private readonly disputes = new Map<TokenId, Dispute>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  /** Each actor's latest spend of each token: the point a second spend forks from. */
  private readonly lastSpend = new Map<string, EventId>();
  /** Spends of a token signed by a forked actor, none of which took effect. */
  private readonly branchSpends = new Set<string>();
  /** Who accepted a rejected offer, and the conflict that explains why they hold nothing. */
  private readonly falseClaims = new Map<string, ConflictRecord>();

  constructor(
    capsule: MissionCapsule,
    custodians: Record<TeamId, ActorId>,
    ordered: AnyEvent[],
    genesis: EventId | undefined,
  ) {
    this.capsule = capsule;
    this.past = new CausalPast(ordered);
    this.genesis = genesis;
    this.forks = findForks(ordered);
    this.needs = taskRequirements(capsule, ordered);
    for (const e of ordered) {
      if (e.type === 'right.accepted' || e.type === 'right.declined') this.answered.add(seat(e.actor, e.body.transfer));
    }
    for (const [team, actor] of Object.entries(custodians)) this.teams.set(actor, team);
    for (const resource of capsule.resources) {
      for (const { id, holderTeam } of resource.tokens) {
        if (this.tokens.has(id)) continue;
        this.tokens.set(id, {
          id,
          resource: resource.id,
          holder: custodians[holderTeam] ?? null,
          holderTeam,
          state: 'held',
          chain: genesis ? [genesis] : [],
        });
      }
    }
  }

  apply(e: AnyEvent): void {
    if (this.onBranch(e)) this.freeze(e.actor);
    switch (e.type) {
      case 'right.committed':
      case 'right.offered':
        this.spend(e);
        break;
      case 'right.accepted':
      case 'right.declined':
        this.answer(e);
        break;
      case 'task.released':
        this.release(e);
        break;
      case 'conflict.resolved':
        this.rule(e);
        break;
    }
  }

  result(): DerivedTokens {
    return { tokens: Object.fromEntries(this.tokens), violations: [...this.conflicts.values()] };
  }

  /** Past its fork an actor has no single history, so nothing it signs can move a token. */
  private onBranch(e: AnyEvent): boolean {
    const fork = this.forks.get(e.actor);
    return fork !== undefined && e.seq >= fork.seq;
  }

  /**
   * Freezes what a forked actor still held. Only the holder can move a held token, and the holder
   * can no longer be trusted to do it once, so there is no safe owner until the issuer names one.
   * The equivocator cannot choose an outcome by choosing clocks or ids, and gains nothing.
   * A token it had already handed over before the fork stays where it went: both branches agree.
   */
  private freeze(actor: ActorId): void {
    if (this.frozen.has(actor)) return;
    this.frozen.add(actor);
    const fork = this.forks.get(actor)!;
    const held = [...this.tokens.values()].filter((t) => t.state === 'held' && t.holder === actor);
    fork.anchor = held.find((t) => fork.named.has(t.id))?.id;
    for (const token of held) this.dispute(token, actor);
  }

  private dispute(token: LedgerToken, actor: ActorId): ConflictRecord {
    const fork = this.forks.get(actor)!;
    const subject = fork.named.has(token.id) ? token.id : (fork.anchor ??= token.id);
    const conflict = this.file({
      id: `token-fork:${subject}:${actor}:${fork.seq}`,
      severity: 'violation',
      kind: 'token-fork',
      tokenId: subject,
      events: [],
      summary: `${this.party(actor)} signed two conflicting histories, so ${this.phrase(subject)} is frozen until the organiser rules.`,
      resolved: false,
    });
    for (const e of fork.events) note(conflict, e);
    token.state = 'disputed';
    token.holder = null;
    token.affected = [];
    this.clearTransfer(token);
    this.disputes.set(token.id, { conflict, evidence: fork.events.map((e) => e.id) });
    return conflict;
  }

  private clearTransfer(token: LedgerToken): void {
    delete token.transfer;
    delete token.from;
    delete token.to;
  }

  /** A move counts only if its signer could see the move before it. */
  private follows(token: LedgerToken, e: AnyEvent): boolean {
    const last = token.chain.at(-1);
    return last === undefined || last === this.genesis || this.past.includes(e, last);
  }

  private maySpend(e: Spend, id: TokenId): boolean {
    const token = this.tokens.get(id);
    return token?.state === 'held' && token.holder === e.actor && this.follows(token, e);
  }

  /** Why this spend breaks a rule of the protocol, whoever holds what. */
  private brokenRule(e: Spend): string | null {
    if (e.type === 'right.committed') {
      if (typeof e.body.taskId !== 'string') return 'sent a malformed commitment';
      const specs = this.needs.get(e.body.taskId);
      const team = this.capsule.teams.find((t) => t.id === this.teams.get(e.actor));
      if (!specs || !team) return null;
      const able = specs.some((requires) => requires.every((c) => team.capabilities.includes(c)));
      return able ? null : 'committed rights to a task its team cannot do';
    }
    const { transfer, to } = e.body;
    if (typeof transfer !== 'string' || transfer === '') return 'sent a malformed offer';
    if (to === e.actor) return 'offered rights to itself';
    if (!this.teams.has(to)) return 'offered rights to someone who cannot hold them';
    const reused = (this.offers.get(transfer) ?? []).some((o) => this.past.includes(e, o.event.id));
    return reused ? 'reused a transfer id' : null;
  }

  /** All or nothing: one token the signer cannot spend voids the whole event. */
  private spend(e: Spend): void {
    const ids = tokenList(e.body.tokens);
    if (!ids) {
      this.reject(e, [], [this.invalid(e, 'sent a malformed rights event')]);
      return;
    }

    const branch = this.onBranch(e);
    const broken = branch ? null : this.brokenRule(e);
    if (broken) {
      this.reject(e, ids, [this.invalid(e, broken, ids[0])]);
      return;
    }
    const blocked = branch ? ids : ids.filter((id) => !this.maySpend(e, id));
    if (blocked.length > 0) {
      this.reject(e, ids, blocked.map((id) => this.blame(id, e)));
      return;
    }

    if (e.type === 'right.offered') this.addOffer({ event: e, to: e.body.to, tokens: ids });
    for (const id of ids) {
      const token = this.tokens.get(id)!;
      this.lastSpend.set(seat(e.actor, id), e.id);
      token.chain.push(e.id);
      if (e.type === 'right.committed') {
        token.state = 'committed';
        token.committedTo = e.body.taskId;
      } else {
        token.state = 'in-transit';
        token.holder = null;
        token.transfer = e.body.transfer;
        token.from = e.actor;
        token.to = e.body.to;
      }
    }
  }

  private addOffer(offer: Offer): void {
    const { transfer } = offer.event.body;
    this.offers.set(transfer, [...(this.offers.get(transfer) ?? []), offer]);
  }

  /** A rejected offer stays on record so that an honest answer to it joins the same conflict. */
  private reject(e: Spend, ids: TokenId[], conflicts: ConflictRecord[]): void {
    if (e.type === 'right.offered') this.addOffer({ event: e, to: e.body.to, tokens: ids, conflicts });
  }

  /** An answer binds to the one offer addressed to its signer that the signer had seen. */
  private answer(e: Answer): void {
    const named = this.offers.get(e.body.transfer) ?? [];
    const addressed = named.filter((o) => o.to === e.actor && this.past.includes(e, o.event.id));
    if (addressed.length === 1) {
      const offer = addressed[0]!;
      if (offer.conflicts) this.answerRejected(offer, e);
      else this.settle(offer, e);
    } else if (addressed.length > 1) {
      this.invalid(e, 'answered a transfer id that names two offers');
    } else if (named.length === 0) {
      this.invalid(e, 'answered a transfer that does not exist');
    } else {
      for (const id of new Set(named.flatMap((o) => o.tokens))) this.blame(id, e);
    }
  }

  /** Only the recipient's first answer moves a token. Nothing else ever leaves in-transit. */
  private settle(offer: Offer, e: Answer): void {
    if (offer.answer) {
      for (const id of offer.tokens) note(this.fork(id, offer.answer.id, e.actor), e);
      return;
    }
    if (this.onBranch(e)) {
      for (const id of offer.tokens) {
        const token = this.tokens.get(id)!;
        const conflict = token.state === 'in-transit' ? this.dispute(token, e.actor) : this.disputes.get(id)?.conflict;
        if (conflict) note(conflict, e);
      }
      return;
    }

    offer.answer = e;
    const accepted = e.type === 'right.accepted';
    const holder = accepted ? offer.to : offer.event.actor;
    for (const id of offer.tokens) {
      const token = this.tokens.get(id)!;
      token.state = 'held';
      token.holder = holder;
      if (accepted) token.holderTeam = this.teams.get(holder) ?? token.holderTeam;
      this.clearTransfer(token);
      token.chain.push(e.id);
      if (this.frozen.has(holder)) this.dispute(token, holder);
    }
  }

  /** The recipient of a rejected offer acted in good faith, so it joins the original conflict. */
  private answerRejected(offer: Offer, e: Answer): void {
    const conflicts = offer.conflicts!;
    for (const conflict of conflicts) note(conflict, e);
    if (e.type !== 'right.accepted') return;
    for (const id of offer.tokens) {
      this.addAffected(id, e.actor);
      const conflict = conflicts.find((c) => c.tokenId === id) ?? conflicts[0]!;
      this.falseClaims.set(seat(e.actor, id), conflict);
    }
  }

  private addAffected(id: TokenId, actor: ActorId): void {
    const token = this.tokens.get(id);
    if (token?.state !== 'disputed' || this.forks.has(actor)) return;
    if (!token.affected!.includes(actor)) token.affected!.push(actor);
  }

  /** Files a rejected event against the conflict that explains it. */
  private blame(id: TokenId, e: AnyEvent): ConflictRecord {
    const token = this.tokens.get(id);
    const isSpend = e.type === 'right.committed' || e.type === 'right.offered';
    const dispute = this.disputes.get(id);
    if (dispute) {
      note(dispute.conflict, e);
      this.addAffected(id, e.actor);
      if (isSpend && this.forks.has(e.actor)) {
        if (this.branchSpends.has(seat(e.actor, id))) token!.overspent = true;
        this.branchSpends.add(seat(e.actor, id));
      }
      return dispute.conflict;
    }
    const spent = this.lastSpend.get(seat(e.actor, id));
    if (spent && isSpend) token!.overspent = true;
    const conflict = spent
      ? this.fork(id, spent, e.actor)
      : (this.falseClaims.get(seat(e.actor, id)) ?? this.forged(id, e));
    note(conflict, e);
    return conflict;
  }

  /** `events[0]` is the move that stands; every later entry has no effect. */
  private fork(id: TokenId, kept: EventId, signer: ActorId): ConflictRecord {
    return this.file({
      id: `token-fork:${id}:${kept}`,
      severity: 'violation',
      kind: 'token-fork',
      tokenId: id,
      events: [kept],
      summary: `${this.party(signer)} signed two moves of ${this.phrase(id)}. The first stands and the other has no effect.`,
      resolved: false,
    });
  }

  private forged(id: TokenId, e: AnyEvent): ConflictRecord {
    const claim = this.tokens.has(id)
      ? `moved ${this.phrase(id)} without holding it`
      : `used a right the mission never issued (${id})`;
    return this.file({
      id: `forged-event:${id}:${e.id}`,
      severity: 'violation',
      kind: 'forged-event',
      tokenId: id,
      events: [],
      summary: `${this.party(e.actor)} ${claim}. The event has no effect.`,
      resolved: false,
    });
  }

  private invalid(e: AnyEvent, what: string, tokenId?: TokenId): ConflictRecord {
    const conflict = this.file({
      id: `forged-event:${e.id}`,
      severity: 'violation',
      kind: 'forged-event',
      ...(tokenId === undefined ? {} : { tokenId }),
      events: [],
      summary: `${this.party(e.actor)} ${what}. The event has no effect.`,
      resolved: false,
    });
    note(conflict, e);
    return conflict;
  }

  /** Giving a task up hands back what its releaser committed to it. */
  private release(e: EventEnvelope<'task.released'>): void {
    if (this.onBranch(e)) return;
    for (const token of this.tokens.values()) {
      const mine = token.state === 'committed' && token.holder === e.actor && token.committedTo === e.body.taskId;
      if (!mine || !this.follows(token, e)) continue;
      token.state = 'held';
      delete token.committedTo;
      token.chain.push(e.id);
    }
  }

  /**
   * The issuer's way out of a stuck token. A dispute needs its evidence in the ruling's past. A
   * token in transit can be ruled on only while its recipient has answered nowhere, because the
   * recipient's own answer outranks a ruling made without it.
   */
  private rule(e: EventEnvelope<'conflict.resolved'>): void {
    const ruling = (e.body as Ruling).tokenHolder;
    if (!ruling) return;
    if (e.actor !== this.capsule.issuer) {
      this.invalid(e, 'ruled on a right without the authority to');
      return;
    }
    const token = this.tokens.get(ruling.tokenId);
    if (!token || this.onBranch(e) || !this.mayRule(e, token, ruling.holder)) {
      this.stale(e, ruling.tokenId);
      return;
    }
    token.state = 'held';
    token.holder = ruling.holder;
    token.holderTeam = this.teams.get(ruling.holder) ?? token.holderTeam;
    this.clearTransfer(token);
    delete token.affected;
    token.chain.push(e.id);
    this.disputes.delete(token.id);
  }

  private mayRule(e: EventEnvelope<'conflict.resolved'>, token: LedgerToken, holder: ActorId): boolean {
    if (!this.teams.has(holder) || this.frozen.has(holder)) return false;
    const dispute = this.disputes.get(token.id);
    if (dispute) {
      return dispute.conflict.id === e.body.conflictId && dispute.evidence.every((id) => this.past.includes(e, id));
    }
    if (token.state !== 'in-transit' || !this.follows(token, e)) return false;
    return !this.answered.has(seat(token.to!, token.transfer!));
  }

  private stale(e: AnyEvent, id: TokenId): void {
    const known = this.tokens.has(id);
    const conflict = this.file({
      id: `stale-decision:${e.id}`,
      severity: 'policy',
      kind: 'stale-decision',
      ...(known ? { tokenId: id } : {}),
      events: [],
      summary: `The organiser's ruling on ${known ? this.phrase(id) : id} no longer applies, so it has no effect.`,
      resolved: false,
    });
    note(conflict, e);
  }

  private file(conflict: ConflictRecord): ConflictRecord {
    const existing = this.conflicts.get(conflict.id);
    if (existing) return existing;
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  private phrase(id: TokenId): string {
    return resourcePhrase(this.capsule, this.tokens.get(id)!.resource);
  }

  private party(actor: ActorId): string {
    const team = this.capsule.teams.find((t) => t.id === this.teams.get(actor));
    return team?.name ?? `Device ${actor.slice(0, 6)}`;
  }
}

/**
 * Derives every token's state from the mission's events.
 *
 * Tokens start with their team's custodian, or with no one if the team has none. A signed genesis
 * that names custodians outranks the `custodians` argument, so replicas cannot disagree on who
 * starts with what. Each token moves along one chain, each move signed by the party entitled to it
 * and having the move before it in its causal past: a holder may commit or offer it, an offer locks
 * it in transit, and only the recipient's accept or decline moves it on. A lost answer leaves it in
 * transit, never refunded, so a partition cannot spend it twice.
 *
 * Anything else has no effect and is reported. A second move from a holder with one history is a
 * token-fork, and the first stands. A holder whose own history splits has no first, so what it still
 * held becomes disputed until the mission issuer rules. Rights moved by someone who never held them
 * are a forged-event.
 *
 * Pure, and a function of the event set alone: input order, duplicates and declared clocks do not
 * decide who holds what. Events are expected to have passed signature checks on their way into the
 * log, which also keeps the set causally closed.
 */
export function deriveTokens(
  capsule: MissionCapsule,
  events: AnyEvent[],
  custodians: Record<TeamId, ActorId>,
): DerivedTokens {
  const ordered = causalOrder(events.filter((e) => e.mission === capsule.id));
  const genesis = ordered.find(
    (e): e is EventEnvelope<'mission.issued'> =>
      e.type === 'mission.issued' && e.actor === capsule.issuer && e.body.capsule?.id === capsule.id,
  );
  const pinned = (genesis?.body as { custodians?: Record<TeamId, ActorId> } | undefined)?.custodians;
  const ledger = new Ledger(capsule, pinned ?? custodians, ordered, genesis?.id);
  for (const e of ordered) ledger.apply(e);
  return ledger.result();
}
