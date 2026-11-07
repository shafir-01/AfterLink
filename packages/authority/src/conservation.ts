import type { MissionRecord, MissionState, ResourceId, TokenId, TokenRecord } from '@afterlink/protocol';
import type { RightsAudit } from './audit.ts';
import type { LedgerToken } from './ledger.ts';

export type ConservationRow = MissionRecord['conservation'][number] & { disputed: number };

/** A token is in exactly one state: it carries no field that belongs to another. */
function inOneState(t: TokenRecord): boolean {
  switch (t.state) {
    case 'held':
      return t.committedTo === undefined && t.transfer === undefined;
    case 'in-transit':
      return t.committedTo === undefined && t.holder === null;
    case 'committed':
      return t.transfer === undefined;
    case 'disputed':
      return t.committedTo === undefined && t.transfer === undefined && t.holder === null;
    default:
      return false;
  }
}

/**
 * The safety invariant. For every resource,
 *
 *   committed + held + inTransit + disputed == issued
 *
 * and every issued token appears once, in exactly one state, with no token the capsule did not
 * issue. One record per token keeps those sums true almost by construction, so a row also fails if
 * any holder signed a token away twice, and if the raw-event `audit` found a double spend the
 * ledger missed. A token frozen by a dispute with nothing promised twice is not a failure.
 */
export function conservation(state: MissionState, audit: RightsAudit[] = []): ConservationRow[] {
  if (!state.capsule) return [];

  const issuedAs = new Map<TokenId, ResourceId>();
  const rows = new Map<ResourceId, ConservationRow>();
  const blank = (resource: ResourceId, issued: number): ConservationRow => ({
    resource,
    issued,
    committed: 0,
    held: 0,
    inTransit: 0,
    disputed: 0,
    ok: true,
  });

  for (const resource of state.capsule.resources) {
    rows.set(resource.id, blank(resource.id, resource.tokens.length));
    for (const token of resource.tokens) issuedAs.set(token.id, resource.id);
  }

  for (const token of Object.values(state.tokens) as LedgerToken[]) {
    let row = rows.get(token.resource);
    if (!row) {
      row = blank(token.resource, 0);
      rows.set(token.resource, row);
    }
    if (token.state === 'committed') row.committed += 1;
    else if (token.state === 'held') row.held += 1;
    else if (token.state === 'in-transit') row.inTransit += 1;
    else if (token.state === 'disputed') row.disputed += 1;
    if (issuedAs.get(token.id) !== token.resource || !inOneState(token) || token.overspent) row.ok = false;
  }

  for (const row of rows.values()) {
    if (row.committed + row.held + row.inTransit + row.disputed !== row.issued) row.ok = false;
  }
  for (const finding of audit) {
    const row = rows.get(finding.resource);
    if (row && !finding.ok) row.ok = false;
  }
  return [...rows.values()];
}
