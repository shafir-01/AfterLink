import type {
  ActorId,
  AnyEvent,
  EventId,
  MissionCapsule,
  ResourceId,
  TeamId,
  TokenId,
  TransferId,
} from '@afterlink/protocol';

export interface RightsAudit {
  token: TokenId;
  resource: ResourceId;
  /** Every signed commitment of this token, on any branch, whether or not the ledger honoured it. */
  commits: EventId[];
  /** Commitments later handed back. */
  released: number;
  /** Actors who signed this token away more times than it ever reached them. */
  overspent: ActorId[];
  /** Offers of this token answered more than once. */
  reanswered: EventId[];
  ok: boolean;
}

interface Offer {
  id: EventId;
  from: ActorId;
  to: ActorId;
  tokens: TokenId[];
  answers: number;
}

const names = (tokens: unknown): TokenId[] => (Array.isArray(tokens) ? [...new Set<TokenId>(tokens)] : []);

/**
 * A second opinion on the ledger, sharing none of its logic. It walks no chain and trusts no order:
 * it only counts signed events, across every forked branch. Rights are conserved when, for each
 * token and actor, what the actor signed away never exceeds what reached it.
 */
export function auditRights(
  capsule: MissionCapsule,
  events: AnyEvent[],
  custodians: Record<TeamId, ActorId>,
): RightsAudit[] {
  const unique = [...new Map(events.filter((e) => e.mission === capsule.id).map((e) => [e.id, e])).values()];
  const rows = new Map<TokenId, RightsAudit>();
  const received = new Map<string, number>();
  const signed = new Map<string, number>();
  const count = (tally: Map<string, number>, actor: ActorId, token: TokenId) => {
    const key = `${actor} ${token}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  };

  for (const resource of capsule.resources) {
    for (const { id, holderTeam } of resource.tokens) {
      rows.set(id, { token: id, resource: resource.id, commits: [], released: 0, overspent: [], reanswered: [], ok: true });
      const custodian = custodians[holderTeam];
      if (custodian !== undefined) count(received, custodian, id);
    }
  }

  const offers = new Map<TransferId, Offer[]>();
  const commits = new Map<string, TokenId[]>();
  for (const e of unique) {
    if (e.type !== 'right.committed' && e.type !== 'right.offered') continue;
    const tokens = names(e.body.tokens).filter((id) => rows.has(id));
    for (const id of tokens) count(signed, e.actor, id);
    if (e.type === 'right.offered') {
      const offer = { id: e.id, from: e.actor, to: e.body.to, tokens, answers: 0 };
      offers.set(e.body.transfer, [...(offers.get(e.body.transfer) ?? []), offer]);
    } else {
      for (const id of tokens) rows.get(id)!.commits.push(e.id);
      const key = `${e.actor} ${e.body.taskId}`;
      commits.set(key, [...(commits.get(key) ?? []), ...tokens]);
    }
  }

  for (const e of unique) {
    if (e.type === 'right.accepted' || e.type === 'right.declined') {
      for (const offer of offers.get(e.body.transfer) ?? []) {
        if (offer.to !== e.actor) continue;
        offer.answers += 1;
        if (offer.answers > 1) {
          for (const id of offer.tokens) rows.get(id)!.reanswered.push(offer.id);
          continue;
        }
        for (const id of offer.tokens) count(received, e.type === 'right.accepted' ? offer.to : offer.from, id);
      }
    } else if (e.type === 'task.released') {
      for (const id of commits.get(`${e.actor} ${e.body.taskId}`) ?? []) {
        rows.get(id)!.released += 1;
        count(received, e.actor, id);
      }
      commits.delete(`${e.actor} ${e.body.taskId}`);
    } else if (e.type === 'conflict.resolved' && e.actor === capsule.issuer) {
      const ruling = (e.body as { tokenHolder?: { tokenId: TokenId; holder: ActorId } }).tokenHolder;
      if (ruling && rows.has(ruling.tokenId)) count(received, ruling.holder, ruling.tokenId);
    }
  }

  for (const [key, spent] of signed) {
    const [actor, id] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
    if (spent > (received.get(key) ?? 0)) rows.get(id)!.overspent.push(actor);
  }
  for (const row of rows.values()) {
    row.ok = row.commits.length - row.released <= 1 && row.overspent.length === 0 && row.reanswered.length === 0;
  }
  return [...rows.values()];
}
