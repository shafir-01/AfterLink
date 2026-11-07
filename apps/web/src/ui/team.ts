import type { TeamId } from '@afterlink/protocol';

const KNOWN = ['medics', 'access', 'facilities', 'supply'];

/** CSS colour for a team. Small accents only: dots, hairlines, initials. */
export function teamColor(team: TeamId): string {
  const key = team.toLowerCase();
  const known = KNOWN.find((name) => key.includes(name));
  if (known) return `var(--team-${known})`;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--team-${KNOWN[hash % KNOWN.length]})`;
}
