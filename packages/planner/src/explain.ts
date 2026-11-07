/** Every sentence a volunteer reads about a decision. Plain words, one sentence each. */

export function listOf(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function clauses(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function capabilityName(capability: string): string {
  return capability.replaceAll('-', ' ');
}

/** "Evacuation chair" reads as "evacuation chair" mid sentence; "AED" stays "AED". */
export function thingName(name: string): string {
  const second = name[1];
  if (second && second === second.toUpperCase() && second !== second.toLowerCase()) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export interface Fit {
  team: string;
  capabilities: string[];
  only: boolean;
  closest: boolean;
  leastBusy: boolean;
  held: string[];
  shaky: string[];
}

export function assigned(f: Fit): string {
  const role = f.only ? 'only team here' : f.closest ? 'closest team' : f.leastBusy ? 'least busy team' : 'best placed team';
  const skills = f.capabilities.length ? ` with ${listOf(f.capabilities.map(capabilityName))}` : '';
  const parts = [`${role}${skills}`];
  if (f.held.length) parts.push(`you hold the ${listOf(f.held.map(thingName))}`);
  if (f.shaky.length) parts.push(`this can be undone if the word on ${listOf(f.shaky)} is out of date`);
  return `Assigned to ${f.team}: ${clauses(parts)}.`;
}

export function covering(owner: string, silentMs: number, priority: number): string {
  return `Covering for ${owner}: no contact for ${duration(silentMs)}, and this is priority ${priority} work.`;
}

export function lostRace(winner: string): string {
  return `${winner} took this task first, so you can leave it to them.`;
}

export function asking(holders: readonly string[], things: readonly string[]): string {
  const verb = holders.length === 1 ? 'holds' : 'hold';
  return `Cannot start yet: ${listOf(holders)} ${verb} the ${listOf(things.map(thingName))}, so you have asked for it.`;
}

export function holderOutOfReach(holder: string, thing: string): string {
  return `Cannot start: ${holder} holds the ${thingName(thing)} and cannot be reached.`;
}

export function inTransit(thing: string): string {
  return `Cannot start: the ${thingName(thing)} is being handed over and nobody can use it yet.`;
}

export function allCommitted(thing: string): string {
  return `Cannot start: every ${thingName(thing)} is already committed to other work.`;
}

export function noCapability(capabilities: readonly string[]): string {
  return `Cannot start: no team here has ${listOf(capabilities.map(capabilityName))}.`;
}

export function everyoneDeclined(): string {
  return 'Cannot start: everyone here who could do this has declined it.';
}

export function waitingOn(title: string): string {
  return `Waiting: "${title}" has to finish first.`;
}

export function waitingOnUnknown(): string {
  return 'Waiting: this depends on work you have not heard about yet.';
}

export function dependencyCancelled(title: string): string {
  return `Waiting: this depends on "${title}", which was cancelled.`;
}

export function needsPerson(): string {
  return 'Needs a person: this kind of work must be approved by a human.';
}

export function blocked(note: string): string {
  const text = note.trim();
  return `Blocked: ${/[.!?]$/.test(text) ? text : `${text}.`}`;
}

export function staleFact(subject: string, ageMs: number): string {
  return `Cannot start: this cannot be undone and the report on ${subject} is ${duration(ageMs)} old.`;
}

export function unreachableFact(subject: string, ageMs: number): string {
  return `Cannot start: this cannot be undone and the report on ${subject} is ${duration(ageMs)} old, from a team you cannot reach.`;
}

export function disputedFact(subject: string): string {
  return `Cannot start: this cannot be undone and reports on ${subject} disagree.`;
}

export function missingFact(subject: string): string {
  return `Cannot start: this cannot be undone and nobody has reported on ${subject} yet.`;
}
