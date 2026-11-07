import type { Capability, ObjectiveId, Point, TaskSpec, TeamId } from '@afterlink/protocol';
import { rngFor, type Rng } from './seed';

/** Every place a team can be sent to. Same names and coordinates as the mission's site. */
export const PLACES = {
  northGate: { name: 'North gate', at: { x: 50, y: 6 } },
  westGate: { name: 'West gate', at: { x: 6, y: 50 } },
  upperStand: { name: 'Upper stand', at: { x: 30, y: 16 } },
  mainStage: { name: 'Main stage', at: { x: 50, y: 28 } },
  firstAidPost: { name: 'First aid post', at: { x: 30, y: 34 } },
  accessHub: { name: 'Access hub', at: { x: 70, y: 36 } },
  sportsHall: { name: 'Sports hall', at: { x: 88, y: 22 } },
  sportsField: { name: 'Sports field', at: { x: 14, y: 24 } },
  foodCourt: { name: 'Food court', at: { x: 50, y: 56 } },
  quietTent: { name: 'Quiet tent', at: { x: 68, y: 56 } },
  supplyDepot: { name: 'Supply depot', at: { x: 24, y: 72 } },
  workshop: { name: 'Workshop', at: { x: 78, y: 72 } },
  ticketQueue: { name: 'Ticket queue', at: { x: 50, y: 88 } },
} as const satisfies Record<string, { name: string; at: Point }>;

export type PlaceId = keyof typeof PLACES;

const BASES: Record<TeamId, Point> = {
  medics: PLACES.firstAidPost.at,
  access: PLACES.accessHub.at,
  facilities: PLACES.workshop.at,
  supply: PLACES.supplyDepot.at,
};
const TEAMS = Object.keys(BASES);

interface Work {
  kind: string;
  title: string;
  /** `{place}` becomes where it happened. */
  brief: string;
  objective: ObjectiveId;
  priority: 1 | 2 | 3;
  requires: Capability[];
  needs?: TaskSpec['needs'];
  reversible?: boolean;
}

/** A job that can start anywhere on this list. */
type Placed = Work & { places: PlaceId[] };

interface Fact {
  /** Read aloud in refusals: "the report on the west gate is 12 seconds old". */
  key: string;
  says: string;
  place: PlaceId;
}

/** One draw from a bag: a job, a job that opens the way for a second, or a report a job leans on. */
type Entry = { work: Placed; then?: Work } | { fact: Fact; then: Work };

const need = (resource: string): TaskSpec['needs'] => [{ resource, count: 1 }];

const EASY: Entry[] = [
  { work: { kind: 'medical', title: 'Help a dizzy visitor', brief: 'A visitor feels faint at the {place}. Sit them down and check on them.', objective: 'safety', priority: 2, requires: ['first-aid'], places: ['foodCourt', 'ticketQueue', 'mainStage', 'quietTent'] } },
  { work: { kind: 'medical', title: 'Clean a grazed knee', brief: 'A student fell at the {place}. Clean the graze and check they can walk.', objective: 'safety', priority: 3, requires: ['first-aid'], places: ['sportsField', 'mainStage', 'foodCourt'] } },
  { work: { kind: 'visitor-help', title: 'Reunite a lost child', brief: 'A child is alone at the {place}. Stay with them and find their parents.', objective: 'safety', priority: 1, requires: ['wayfinding'], places: ['foodCourt', 'ticketQueue', 'mainStage'] } },
  { work: { kind: 'visitor-help', title: 'Guide a visitor with low vision', brief: 'A visitor at the {place} needs a guide to the step-free route.', objective: 'access', priority: 2, requires: ['mobility'], places: ['accessHub', 'northGate', 'foodCourt'] } },
  { work: { kind: 'repair', title: 'Fix a loose barrier', brief: 'A crowd barrier at the {place} has come loose. Bolt it back together.', objective: 'access', priority: 2, requires: ['repair'], places: ['ticketQueue', 'mainStage', 'northGate'] } },
  { work: { kind: 'power', title: 'Reset a tripped socket', brief: 'The sockets at the {place} have tripped. Find the fault and reset them.', objective: 'service', priority: 2, requires: ['power'], places: ['foodCourt', 'mainStage', 'workshop'] } },
  { work: { kind: 'supply-run', title: 'Restock hand gel', brief: 'The hand gel at the {place} has run out. Bring two more bottles.', objective: 'service', priority: 3, requires: ['stock'], places: ['foodCourt', 'ticketQueue', 'firstAidPost'] } },
  { work: { kind: 'water-run', title: 'Hand out water', brief: 'People at the {place} are hot. Bring water and hand it out.', objective: 'safety', priority: 2, requires: ['haul'], places: ['ticketQueue', 'sportsField', 'upperStand'] } },
];

const MEDIUM: Entry[] = [
  { work: { kind: 'water-run', title: 'Cart water across the site', brief: 'The {place} needs crates of water. Load the cart and take them over.', objective: 'safety', priority: 2, requires: ['haul'], needs: need('cart'), places: ['ticketQueue', 'sportsField'] } },
  { work: { kind: 'supply-run', title: 'Place the spare AED', brief: 'Take the spare AED to the {place} and tell the stewards where it is.', objective: 'safety', priority: 2, requires: ['stock'], needs: need('aed'), places: ['sportsField', 'upperStand'] } },
  {
    work: { kind: 'repair', title: 'Secure a fallen fence panel', brief: 'A fence panel came down at the {place}. Fix it before anyone walks through.', objective: 'safety', priority: 2, requires: ['repair'], places: ['ticketQueue', 'northGate'] },
    then: { kind: 'visitor-help', title: 'Reopen the lane', brief: 'The fence at the {place} is safe. Walk people back through the lane.', objective: 'access', priority: 2, requires: ['wayfinding'] },
  },
  {
    work: { kind: 'power', title: 'Restore the stage power', brief: 'The {place} has lost power. Find the fault and bring it back.', objective: 'service', priority: 1, requires: ['power'], places: ['mainStage'] },
    then: { kind: 'briefing', title: 'Walk the stewards back in', brief: 'Power is back at the {place}. Walk the stewards to their positions.', objective: 'service', priority: 3, requires: ['mobility'] },
  },
  {
    work: { kind: 'medical', title: 'Check a visitor for an allergy', brief: 'A visitor at the {place} has a rash after eating. Check how bad it is.', objective: 'safety', priority: 1, requires: ['triage'], places: ['foodCourt'] },
    then: { kind: 'supply-run', title: 'Fetch the allergy kit', brief: 'The medics at the {place} need the allergy kit from the depot.', objective: 'safety', priority: 1, requires: ['stock'] },
  },
  {
    work: { kind: 'repair', title: 'Clear a spill on the ramp', brief: 'Oil has spilled on the ramp at the {place}. Clear it before someone slips.', objective: 'access', priority: 2, requires: ['haul'], places: ['accessHub', 'sportsHall'] },
    then: { kind: 'visitor-help', title: 'Test the ramp', brief: 'The ramp at the {place} is clear. Walk it with a wheelchair user.', objective: 'access', priority: 2, requires: ['mobility'] },
  },
];

const HARD: Entry[] = [
  {
    fact: { key: 'the west gate', says: 'West gate is clear', place: 'westGate' },
    then: { kind: 'crowd', title: 'Send the queue through the west gate', brief: 'The ticket queue is too long. Move it through the west gate. It cannot be called back.', objective: 'safety', priority: 1, requires: ['wayfinding'], reversible: false },
  },
  {
    fact: { key: 'the hall ramp', says: 'Hall ramp is holding', place: 'sportsHall' },
    then: { kind: 'crowd', title: 'Bring a group down the hall ramp', brief: 'Bring the wheelchair group down the sports hall ramp. There is no way back up.', objective: 'access', priority: 1, requires: ['mobility'], reversible: false },
  },
  {
    fact: { key: 'the field ground', says: 'Field ground is firm', place: 'sportsField' },
    then: { kind: 'crowd', title: 'Move the food queue onto the field', brief: 'Move the food queue onto the sports field. Once it moves it stays there.', objective: 'service', priority: 2, requires: ['wayfinding'], reversible: false },
  },
  {
    fact: { key: 'the stand stairs', says: 'Stand stairs are clear', place: 'upperStand' },
    then: { kind: 'crowd', title: 'Clear the upper stand', brief: 'Walk everyone out of the upper stand by the stairs. Do not stop halfway.', objective: 'safety', priority: 1, requires: ['mobility'], reversible: false },
  },
  { work: { kind: 'medical', title: 'Treat a collapsed visitor', brief: 'Someone has collapsed at the {place}. Bring the AED now.', objective: 'safety', priority: 1, requires: ['first-aid'], needs: need('aed'), reversible: false, places: ['mainStage', 'sportsField', 'foodCourt'] } },
  { work: { kind: 'power', title: 'Haul in the spare generator', brief: 'The {place} is on its last power feed. Bring the generator by cart.', objective: 'service', priority: 1, requires: ['power'], needs: need('cart'), places: ['foodCourt', 'sportsHall'] } },
];

interface Common {
  n: number;
  tier: 1 | 2 | 3;
  /** The team that hears about it first. While split, nobody else does. */
  team: TeamId;
  /** Seeded wobble on the wait after this one, so the stream never ticks like a metronome. */
  jitter: number;
}
export interface TaskIncident extends Common {
  type: 'task';
  spec: TaskSpec;
}
export interface ReportIncident extends Common {
  type: 'report';
  key: string;
  says: string;
  locationName: string;
  validForMs: number;
}
export type Incident = TaskIncident | ReportIncident;

export const DECK_LENGTH = 96;
const REPORT_VALID_MS = 30_000;
const START_GAP_MS = 4200;
const MIN_GAP_MS = 1200;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const away = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const wobble = (rng: Rng) => 0.85 + rng() * 0.3;

/** Fisher-Yates over a seeded stream. */
function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const usesRights = (e: Entry) => 'work' in e && !!e.work.needs?.length;

/** Draws without repeats. Scarce gear appears once per bag: a right that is spent stays spent, so asking again is only noise. */
class Bag {
  private left: Entry[];
  constructor(
    private readonly rng: Rng,
    private readonly entries: Entry[],
  ) {
    this.left = shuffled(rng, entries);
  }
  draw(): Entry {
    if (!this.left.length) this.left = shuffled(this.rng, this.entries.filter((e) => !usesRights(e)));
    return this.left.pop()!;
  }
}

/** Early incidents are simple. Scarce gear, dependencies and work that cannot be undone come in as the stream goes on. */
function tierAt(n: number, rng: Rng): 1 | 2 | 3 {
  const hard = clamp((n - 10) / 20, 0, 0.5);
  const medium = clamp((n - 3) / 10, 0, 0.6);
  const roll = rng();
  if (roll < hard) return 3;
  return roll < hard + medium ? 2 : 1;
}

/** Usually the team nearest the trouble hears first, but anyone can walk past it. */
function hearer(rng: Rng, at: Point): TeamId {
  const nearest = TEAMS.reduce((best, team) => (away(BASES[team]!, at) < away(BASES[best]!, at) ? team : best));
  return rng() < 0.6 ? nearest : pick(rng, TEAMS);
}

function specOf(seed: string, n: number, work: Work, place: PlaceId, rest: Partial<TaskSpec> = {}): TaskSpec {
  const { name, at } = PLACES[place];
  return {
    id: `play-${seed}-${n}`,
    kind: work.kind,
    title: work.title,
    brief: work.brief.replace('{place}', name.toLowerCase()),
    objective: work.objective,
    priority: work.priority,
    location: at,
    locationName: name,
    requires: work.requires,
    needs: work.needs ?? [],
    dependsOn: [],
    reversible: work.reversible ?? true,
    ...rest,
  };
}

/**
 * The whole stream for one seed. Nothing here reads the run: the same seed always gives the same
 * incidents in the same order. Cutting links only brings the next one sooner, see `gapAfter`.
 */
export function buildDeck(seed: string, length = DECK_LENGTH): Incident[] {
  const rng = rngFor(seed);
  const bags = { 1: new Bag(rng, EASY), 2: new Bag(rng, MEDIUM), 3: new Bag(rng, HARD) };
  const deck: Incident[] = [];
  const later: { at: number; make: (n: number) => Incident }[] = [];

  while (deck.length < length) {
    const n = deck.length;
    const due = later.findIndex((l) => l.at <= n);
    if (due >= 0) {
      deck.push(later.splice(due, 1)[0]!.make(n));
      continue;
    }

    const tier = tierAt(n, rng);
    const entry = bags[tier].draw();
    const jitter = wobble(rng);
    let place: PlaceId;
    let rest: Partial<TaskSpec>;
    if ('fact' in entry) {
      const { key, says } = entry.fact;
      place = entry.fact.place;
      rest = { reliesOn: [key] };
      const { name, at } = PLACES[place];
      deck.push({ type: 'report', n, tier, team: hearer(rng, at), jitter, key, says, locationName: name, validForMs: REPORT_VALID_MS });
    } else {
      place = pick(rng, entry.work.places);
      const spec = specOf(seed, n, entry.work, place);
      rest = { dependsOn: [spec.id] };
      deck.push({ type: 'task', n, tier, team: hearer(rng, spec.location), jitter, spec });
    }

    const follow = entry.then;
    if (!follow) continue;
    const team = hearer(rng, PLACES[place].at);
    const followJitter = wobble(rng);
    later.push({
      at: n + 1 + Math.floor(rng() * 3),
      make: (m) => ({ type: 'task', n: m, tier, team, jitter: followJitter, spec: specOf(seed, m, follow, place, rest) }),
    });
  }
  return deck;
}

/** Each link cut brings the next incident sooner, so a player who cuts more reaches the hard part of the deck faster. */
export function gapAfter(incident: Pick<Incident, 'n' | 'jitter'>, cuts: number): number {
  const ramp = Math.max(0.5, 1 - incident.n * 0.02);
  const pressure = 1 / (1 + cuts * 0.12);
  return Math.max(MIN_GAP_MS, Math.round(START_GAP_MS * ramp * pressure * incident.jitter));
}
