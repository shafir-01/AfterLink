import type {
  ActorId,
  AnyEvent,
  ConflictRecord,
  EventEnvelope,
  EventId,
  MissionCapsule,
  TeamId,
  TokenId,
  TokenRecord,
  TransferId,
} from '@afterlink/protocol';
import { resourcePhrase } from './words.ts';

/**
 * A token as the ledger derives it. While in transit `holder` is null and `from` and `to` name the
 * two parties: the right belongs to neither of them until the recipient answers.
 */
export interface LedgerToken extends TokenRecord {
  from?: ActorId;
  to?: ActorId;
}

export interface DerivedTokens {
  tokens: Record<TokenId, LedgerToken>;
  violations: ConflictRecord[];
}

type Spend = EventEnvelope<'right.committed'> | EventEnvelope<'right.offered'>;
type Answer = EventEnvelope<'right.accepted'> | EventEnvelope<'right.declined'>;

interface Transfer {
  from: ActorId;
  to: ActorId;
  tokens: TokenId[];
  answer?: Answer;
}

interface RejectedOffer {
  to: ActorId;
  tokens: TokenId[];
  conflicts: ConflictRecord[];
}

function byClock(a: AnyEvent, b: AnyEvent): number {
  return a.lamport - b.lamport || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Inserts into a list kept in descending clock order, so the lowest event pops first. */
function insertDescending(list: AnyEvent[], e: AnyEvent): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (byClock(list[mid]!, e) > 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, e);
}

/**
 * The one order every replica walks: an event follows everything it names as a cause, and among
 * events whose causes are done the lowest lamport then lowest id goes first. Depends only on the
 * set of events. Causes come before clocks so that a low lamport cannot place an event ahead of
 * the signer's own earlier events.
 */
export function causalOrder(events: AnyEvent[]): AnyEvent[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const waitingOn = new Map<EventId, number>();
  const effects = new Map<EventId, AnyEvent[]>();
  const ready: AnyEvent[] = [];

  for (const e of byId.values()) {
    const causes = new Set(e.prev ? [e.prev, ...e.parents] : e.parents);
    let open = 0;
    for (const cause of causes) {
      if (!byId.has(cause)) continue;
      open += 1;
      const list = effects.get(cause);
      if (list) list.push(e);
      else effects.set(cause, [e]);
    }
    waitingOn.set(e.id, open);
    if (open === 0) insertDescending(ready, e);
  }

  const ordered: AnyEvent[] = [];
  while (ready.length > 0) {
    const e = ready.pop()!;
    ordered.push(e);
    for (const effect of effects.get(e.id) ?? []) {
      const open = waitingOn.get(effect.id)! - 1;
      waitingOn.set(effect.id, open);
      if (open === 0) insertDescending(ready, effect);
    }
  }
  return ordered;
}

function distinct(tokens: TokenId[]): TokenId[] {
  return Array.isArray(tokens) ? [...new Set(tokens)] : [];
}

function note(conflict: ConflictRecord, e: AnyEvent): void {
  if (!conflict.events.includes(e.id)) conflict.events.push(e.id);
  if (e.type === 'right.committed') conflict.taskId ??= e.body.taskId;
}

const seat = (actor: ActorId, token: TokenId) => `${actor} ${token}`;

class Ledger {
  private readonly capsule: MissionCapsule;
  private readonly tokens = new Map<TokenId, LedgerToken>();
  private readonly teams = new Map<ActorId, TeamId>();
  private readonly transfers = new Map<TransferId, Transfer>();
  private readonly rejectedOffers = new Map<TransferId, RejectedOffer[]>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  /** Each actor's latest spend of each token: the point a second spend forks from. */
  private readonly lastSpend = new Map<string, EventId>();
  /** Who accepted a rejected offer, and the conflict that explains why they hold nothing. */
  private readonly falseClaims = new Map<string, ConflictRecord>();

  constructor(capsule: MissionCapsule, custodians: Record<TeamId, ActorId>, genesis: EventId | undefined) {
    this.capsule = capsule;
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
    switch (e.type) {
      case 'actor.joined':
        if (!this.teams.has(e.actor)) this.teams.set(e.actor, e.body.team);
        break;
      case 'right.committed':
      case 'right.offered':
        this.spend(e);
        break;
      case 'right.accepted':
      case 'right.declined':
        this.answer(e);
        break;
    }
  }

  result(): DerivedTokens {
    return { tokens: Object.fromEntries(this.tokens), violations: [...this.conflicts.values()] };
  }

  private holds(actor: ActorId, id: TokenId): boolean {
    const token = this.tokens.get(id);
    return token?.state === 'held' && token.holder === actor;
  }

  /** All or nothing: one token the signer cannot spend voids the whole event. */
  private spend(e: Spend): void {
    const ids = distinct(e.body.tokens);
    if (ids.length === 0) return;

    const transferTaken = e.type === 'right.offered' && this.transfers.has(e.body.transfer);
    const invalid = transferTaken ? ids : ids.filter((id) => !this.holds(e.actor, id));
    if (invalid.length > 0) {
      const conflicts = invalid.map((id) => this.blame(id, e));
      if (e.type === 'right.offered') {
        const offers = this.rejectedOffers.get(e.body.transfer) ?? [];
        this.rejectedOffers.set(e.body.transfer, [...offers, { to: e.body.to, tokens: ids, conflicts }]);
      }
      return;
    }

    if (e.type === 'right.offered') {
      this.transfers.set(e.body.transfer, { from: e.actor, to: e.body.to, tokens: ids });
    }
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

  /** Only the recipient's first answer moves a token. Nothing else ever leaves in-transit. */
  private answer(e: Answer): void {
    const transfer = this.transfers.get(e.body.transfer);
    if (transfer?.to === e.actor) {
      this.settle(transfer, e);
      return;
    }
    const rejected = this.rejectedOffers.get(e.body.transfer) ?? [];
    const addressed = rejected.find((offer) => offer.to === e.actor);
    if (addressed) {
      this.answerRejected(addressed, e);
      return;
    }
    for (const id of transfer?.tokens ?? rejected[0]?.tokens ?? []) this.blame(id, e);
  }

  private settle(transfer: Transfer, e: Answer): void {
    if (transfer.answer) {
      if (transfer.answer.type !== e.type) {
        for (const id of transfer.tokens) note(this.fork(id, transfer.answer.id, e.actor), e);
      }
      return;
    }

    transfer.answer = e;
    const accepted = e.type === 'right.accepted';
    for (const id of transfer.tokens) {
      const token = this.tokens.get(id)!;
      token.state = 'held';
      token.holder = accepted ? transfer.to : transfer.from;
      if (accepted) token.holderTeam = this.teams.get(transfer.to) ?? token.holderTeam;
      delete token.transfer;
      delete token.from;
      delete token.to;
      token.chain.push(e.id);
    }
  }

  /** The recipient of a rejected offer acted in good faith, so it joins the original conflict. */
  private answerRejected(offer: RejectedOffer, e: Answer): void {
    for (const conflict of offer.conflicts) note(conflict, e);
    if (e.type !== 'right.accepted') return;
    for (const id of offer.tokens) {
      const conflict = offer.conflicts.find((c) => c.tokenId === id) ?? offer.conflicts[0]!;
      this.falseClaims.set(seat(e.actor, id), conflict);
    }
  }

  /** Files a rejected event against the conflict that explains it. */
  private blame(id: TokenId, e: AnyEvent): ConflictRecord {
    const spent = this.lastSpend.get(seat(e.actor, id));
    const conflict = spent
      ? this.fork(id, spent, e.actor)
      : (this.falseClaims.get(seat(e.actor, id)) ?? this.forged(id, e));
    note(conflict, e);
    return conflict;
  }

  /** `events[0]` is the successor that stands; every later entry has no effect. */
  private fork(id: TokenId, kept: EventId, signer: ActorId): ConflictRecord {
    const what = resourcePhrase(this.capsule, this.tokens.get(id)!.resource);
    return this.file({
      id: `token-fork:${id}:${kept}`,
      severity: 'violation',
      kind: 'token-fork',
      tokenId: id,
      events: [kept],
      summary: `${this.party(signer)} signed two moves of ${what}. The first stands and the other has no effect.`,
      resolved: false,
    });
  }

  private forged(id: TokenId, e: AnyEvent): ConflictRecord {
    const token = this.tokens.get(id);
    const claim = token
      ? `moved ${resourcePhrase(this.capsule, token.resource)} without holding it`
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

  private file(conflict: ConflictRecord): ConflictRecord {
    const existing = this.conflicts.get(conflict.id);
    if (existing) return existing;
    this.conflicts.set(conflict.id, conflict);
    return conflict;
  }

  private party(actor: ActorId): string {
    const team = this.capsule.teams.find((t) => t.id === this.teams.get(actor));
    return team?.name ?? `Device ${actor.slice(0, 6)}`;
  }
}

/**
 * Derives every token's state from the mission's events.
 *
 * Tokens start with their team's custodian, or with no one if the team has none. Each token moves
 * along one chain of signed successors: a current holder may commit or offer it, an offer locks it
 * in transit, and only the recipient's accept or decline moves it on. Commitment is final. A lost
 * answer therefore leaves the token in transit, never refunded, so a partition cannot spend it
 * twice.
 *
 * Every other right event has no effect and is reported. Two signed successors from one holder are
 * a token-fork: the first in causal order stands, which is the lowest lamport then lowest id when
 * neither caused the other. Rights spent by someone who never held them are a forged-event.
 *
 * Pure, and a function of the event set alone: input order and duplicates do not matter. Events are
 * expected to have passed signature checks on their way into the log.
 */
export function deriveTokens(
  capsule: MissionCapsule,
  events: AnyEvent[],
  custodians: Record<TeamId, ActorId>,
): DerivedTokens {
  const ordered = causalOrder(events.filter((e) => e.mission === capsule.id));
  const genesis = ordered.find(
    (e) => e.type === 'mission.issued' && e.actor === capsule.issuer && e.body.capsule?.id === capsule.id,
  );
  const ledger = new Ledger(capsule, custodians, genesis?.id);
  for (const e of ordered) ledger.apply(e);
  return ledger.result();
}
