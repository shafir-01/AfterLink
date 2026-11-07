import type { MissionCapsule, RefusalCode, TaskSpec } from '@afterlink/protocol';

export const PHRASES = {
  accepted: 'Task accepted',
  completed: 'Task marked complete.',
  declined: 'Understood. Marked as cannot do.',
  networkLost: 'Network lost. You can keep working.',
  networkBack: 'Network restored.',
  confirmAccept: 'Accept this task? Say yes or no.',
  confirmComplete: 'Mark this task complete? Say yes or no.',
  confirmDecline: 'Mark this task as cannot do? Say yes or no.',
  cancelled: 'Cancelled.',
  notHeard: 'I did not catch that. Try again, or use the buttons.',
  nothingNext: 'Nothing is waiting for you.',
} as const;

export type PhraseId = keyof typeof PHRASES;

const REFUSAL_TEXT: Record<Exclude<RefusalCode, 'NO_RIGHT'>, string> = {
  NO_CAPABILITY: 'Your team cannot do this task.',
  DEPENDENCY_UNMET: 'This task has to wait for an earlier one.',
  STALE_KNOWLEDGE: 'Your information may be out of date. Confirm before acting.',
  HUMAN_APPROVAL_REQUIRED: 'A person must approve this first.',
  TOKEN_IN_TRANSIT: 'That resource is being handed over. Wait for the answer.',
  BLOCKED_BY_CONTINGENCY: 'This task is blocked by a change on site.',
};

export function humanResource(id: string): string {
  return id.replace(/^evac(?=-|$)/, 'evacuation').replace(/-/g, ' ');
}

/** Spoken refusal as ordered segments, so each part can be played from its own clip. */
export function refusalSegments(code: RefusalCode, o: { resource?: string; team?: string } = {}): string[] {
  if (code !== 'NO_RIGHT') return [REFUSAL_TEXT[code]];
  const resource = o.resource ? humanResource(o.resource) : 'a resource you do not hold';
  const need = `That needs the ${resource}.`;
  return o.team ? [need, `${o.team} holds it, and you cannot reach them.`] : [need, 'Its holder is out of reach.'];
}

export function taskBriefText(spec: TaskSpec): string {
  return `${spec.title}. ${spec.brief}`;
}

export function roleBriefingText(capsule: MissionCapsule, teamId: string): string {
  const team = capsule.teams.find((t) => t.id === teamId);
  const name = team?.name ?? teamId;
  const caps = team?.capabilities.map((c) => c.replace(/-/g, ' ')) ?? [];
  const held = capsule.resources
    .map((r) => ({ name: humanResource(r.id), n: r.tokens.filter((t) => t.holderTeam === teamId).length }))
    .filter((r) => r.n > 0)
    .map((r) => (r.n > 1 ? `${r.n} ${r.name}s` : `the ${r.name}`));
  const parts = [`${name} briefing.`, `Mission: ${capsule.objective}.`];
  if (caps.length) parts.push(`Your team covers ${caps.join(', ')}.`);
  if (held.length) parts.push(`You hold ${held.join(' and ')}.`);
  parts.push('Say accept, complete, cannot do, or what next.');
  return parts.join(' ');
}

export interface PackItem {
  text: string;
  role: string;
}

/** Everything a device needs spoken offline: every team briefing, every task brief, phrases and refusals. */
export function packItems(capsule: MissionCapsule, myTeam: string): PackItem[] {
  const items: PackItem[] = [];
  for (const t of capsule.teams) items.push({ text: roleBriefingText(capsule, t.id), role: t.id });
  for (const spec of capsule.tasks) items.push({ text: taskBriefText(spec), role: myTeam });
  for (const text of Object.values(PHRASES)) items.push({ text, role: myTeam });
  for (const code of Object.keys(REFUSAL_TEXT) as Exclude<RefusalCode, 'NO_RIGHT'>[]) items.push({ text: REFUSAL_TEXT[code], role: myTeam });
  for (const r of capsule.resources) {
    const teams = new Set(r.tokens.map((t) => t.holderTeam));
    for (const holder of teams) {
      if (holder === myTeam) continue;
      const name = capsule.teams.find((t) => t.id === holder)?.name ?? holder;
      const segs = refusalSegments('NO_RIGHT', { resource: r.id, team: name });
      for (const s of [...segs, segs.join(' ')]) items.push({ text: s, role: myTeam });
    }
  }
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = `${i.role}\n${i.text}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
