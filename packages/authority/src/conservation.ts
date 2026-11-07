import type { MissionRecord, MissionState, ResourceId, TokenId, TokenRecord } from '@afterlink/protocol';

type Row = MissionRecord['conservation'][number];

/** A token is in exactly one state: it carries no field that belongs to another. */
function inOneState(t: TokenRecord): boolean {
  switch (t.state) {
    case 'held':
      return t.committedTo === undefined && t.transfer === undefined;
    case 'in-transit':
      return t.committedTo === undefined && t.holder === null;
    case 'committed':
      return t.transfer === undefined;
    default:
      return false;
  }
}

/**
 * The safety invariant. For every resource,
 *
 *   committed + held + inTransit == issued
 *
 * and every issued token appears once, in exactly one state, with no token the capsule did not
 * issue. A row reports ok false if a right has been minted, lost or left in two states at once.
 */
export function conservation(state: MissionState): MissionRecord['conservation'] {
  if (!state.capsule) return [];

  const issuedAs = new Map<TokenId, ResourceId>();
  const rows = new Map<ResourceId, Row>();
  const blank = (resource: ResourceId, issued: number): Row => ({
    resource,
    issued,
    committed: 0,
    held: 0,
    inTransit: 0,
    ok: true,
  });

  for (const resource of state.capsule.resources) {
    rows.set(resource.id, blank(resource.id, resource.tokens.length));
    for (const token of resource.tokens) issuedAs.set(token.id, resource.id);
  }

  for (const token of Object.values(state.tokens)) {
    let row = rows.get(token.resource);
    if (!row) {
      row = blank(token.resource, 0);
      rows.set(token.resource, row);
    }
    if (token.state === 'committed') row.committed += 1;
    else if (token.state === 'held') row.held += 1;
    else if (token.state === 'in-transit') row.inTransit += 1;
    if (issuedAs.get(token.id) !== token.resource || !inOneState(token)) row.ok = false;
  }

  for (const row of rows.values()) {
    if (row.committed + row.held + row.inTransit !== row.issued) row.ok = false;
  }
  return [...rows.values()];
}
