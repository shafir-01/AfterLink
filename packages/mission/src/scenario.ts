import { sha256 } from '@afterlink/protocol';
import type { ActorId, Json, MissionCapsule, Point, TaskId, TaskSpec, TeamId } from '@afterlink/protocol';

export type DemoStep = 'connected' | 'hq-down' | 'split' | 'contested' | 'ferry' | 'restored';

export interface DemoBeat {
  id: string;
  step: DemoStep;
  /** The team whose device raises this beat. */
  team: TeamId;
  label: string;
  spec?: TaskSpec;
  observation?: { key: string; value: Json; subject: string };
  /** Split the peers as soon as this task is claimed, so the far group covers it while its owner is still at work. */
  splitOnClaim?: boolean;
}

const place = (name: string, x: number, y: number): { locationName: string; location: Point } => ({ locationName: name, location: { x, y } });

const SITE = {
  northGate: place('North gate', 50, 6),
  westGate: place('West gate', 6, 50),
  upperStand: place('Upper stand', 30, 16),
  mainStage: place('Main stage', 50, 28),
  firstAidPost: place('First aid post', 30, 34),
  accessHub: place('Access hub', 70, 36),
  sportsHall: place('Sports hall', 88, 22),
  sportsField: place('Sports field', 14, 24),
  foodCourt: place('Food court', 50, 56),
  quietTent: place('Quiet tent', 68, 56),
  supplyDepot: place('Supply depot', 24, 72),
  workshop: place('Workshop', 78, 72),
  ticketQueue: place('Ticket queue', 50, 88),
};

const GATE_KEY = 'gate.north.open';

const task = (
  id: TaskId,
  kind: string,
  title: string,
  brief: string,
  where: { locationName: string; location: Point },
  rest: Pick<TaskSpec, 'objective' | 'priority' | 'requires'> & Partial<TaskSpec>,
): TaskSpec => ({ id, kind, title, brief, ...where, needs: [], dependsOn: [], reversible: true, ...rest });

const CAPSULE_TASKS: TaskSpec[] = [
  task('open-first-aid', 'setup', 'Open the first aid post', 'Set up the first aid post by the main stage and check the kit.', SITE.firstAidPost, {
    objective: 'safety',
    priority: 1,
    requires: ['first-aid'],
  }),
  task('stock-first-aid', 'supply-run', 'Stock the first aid post', 'Take water, blankets and dressings to the first aid post by cart.', SITE.firstAidPost, {
    objective: 'safety',
    priority: 2,
    requires: ['stock'],
    needs: [{ resource: 'cart', count: 1 }],
    dependsOn: ['open-first-aid'],
  }),
  task('clear-north-path', 'north-route', 'Clear the north path', 'Lift the loose cable covers on the north path so wheelchairs can get through.', SITE.northGate, {
    objective: 'access',
    priority: 2,
    requires: ['repair'],
    reliesOn: [GATE_KEY],
  }),
  task('mark-step-free', 'north-route', 'Mark the step-free route', 'Put up the blue signs from the north gate to the main stage.', SITE.northGate, {
    objective: 'access',
    priority: 2,
    requires: ['wayfinding'],
    dependsOn: ['clear-north-path'],
    reliesOn: [GATE_KEY],
  }),
  task('connect-water', 'setup', 'Connect the water station', 'Run the hose to the food court and test the tap.', SITE.foodCourt, {
    objective: 'service',
    priority: 2,
    requires: ['repair'],
  }),
  task('stock-water', 'supply-run', 'Stock the water station', 'Take cups and crates to the water station at the food court.', SITE.foodCourt, {
    objective: 'service',
    priority: 3,
    requires: ['stock'],
    dependsOn: ['connect-water'],
  }),
  task('brief-stewards', 'briefing', 'Brief the stewards', 'Walk the stewards along the step-free route and show them the first aid post.', SITE.mainStage, {
    objective: 'access',
    priority: 3,
    requires: ['mobility'],
    dependsOn: ['open-first-aid', 'mark-step-free'],
  }),
];

const REROUTE_TASK = task(
  'west-gate-reroute',
  'reroute',
  'Reroute arrivals to the west gate',
  'The north gate is closed. Put up the reroute signs and walk arrivals to the west gate.',
  SITE.westGate,
  { objective: 'access', priority: 1, requires: ['wayfinding'] },
);

export function festivalCapsule(issuer: { publicKey: ActorId; secretKey: string }, opts: { name?: string; now?: number } = {}): MissionCapsule {
  const name = opts.name ?? 'Field Day';
  const issuedAt = opts.now ?? Date.now();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    v: 1,
    id: `${slug}-${sha256(`${issuer.publicKey}:${issuedAt}`).slice(0, 8)}`,
    version: 1,
    name,
    objective: 'Keep everyone safe and moving through the day.',
    objectives: [
      { id: 'safety', title: 'Keep people safe', rank: 1 },
      { id: 'access', title: 'Keep the site open to everyone', rank: 2 },
      { id: 'service', title: 'Keep the day running', rank: 3 },
    ],
    teams: [
      { id: 'medics', name: 'Medics', capabilities: ['first-aid', 'triage'], home: SITE.firstAidPost.location },
      { id: 'access', name: 'Access', capabilities: ['mobility', 'wayfinding'], home: SITE.accessHub.location },
      { id: 'facilities', name: 'Facilities', capabilities: ['repair', 'power', 'haul'], home: SITE.workshop.location },
      { id: 'supply', name: 'Supply', capabilities: ['stock', 'haul'], home: SITE.supplyDepot.location },
    ],
    resources: [
      { id: 'evac-chair', name: 'Evacuation chair', tokens: [{ id: 'evac-chair#1', holderTeam: 'access' }] },
      {
        id: 'aed',
        name: 'AED',
        tokens: [
          { id: 'aed#1', holderTeam: 'medics' },
          { id: 'aed#2', holderTeam: 'supply' },
        ],
      },
      {
        id: 'cart',
        name: 'Cart',
        tokens: [
          { id: 'cart#1', holderTeam: 'supply' },
          { id: 'cart#2', holderTeam: 'facilities' },
        ],
      },
    ],
    tasks: CAPSULE_TASKS,
    contingencies: [
      {
        id: 'north-gate-closed',
        when: { key: GATE_KEY, equals: false },
        then: {
          blockKinds: ['north-route'],
          spawn: [REROUTE_TASK],
          note: 'North gate closed. Send support through the west gate.',
        },
      },
    ],
    fallback: { coverAfterMs: 4000, coverMaxPriority: 1, humanApprovalKinds: ['site-closure'] },
    issuer: issuer.publicKey,
    issuedAt,
  };
}

/** How the stage divides the peers when it splits the network. */
export const scenarioSplit: { a: TeamId[]; b: TeamId[] } = { a: ['medics', 'supply'], b: ['access', 'facilities'] };

export const scenarioBeats: DemoBeat[] = [
  {
    id: 'connected-faint',
    step: 'connected',
    team: 'access',
    label: 'A visitor fainted at the main stage.',
    spec: task('faint-main-stage', 'medical', 'Help a visitor who fainted', 'A visitor has fainted at the main stage. Go now and check on them.', SITE.mainStage, {
      objective: 'safety',
      priority: 1,
      requires: ['first-aid'],
    }),
  },
  {
    id: 'hq-down-quiet-tent',
    step: 'hq-down',
    team: 'supply',
    label: 'A visitor needs the quiet tent. HQ is gone, so the teams sort it out.',
    spec: task('guide-quiet-tent', 'visitor-help', 'Guide a visitor to the quiet tent', 'A visitor is overwhelmed at the food court. Walk with them to the quiet tent.', SITE.quietTent, {
      objective: 'access',
      priority: 2,
      requires: ['wayfinding'],
    }),
  },
  {
    id: 'hq-down-queue-water',
    step: 'hq-down',
    team: 'medics',
    label: 'The ticket queue needs water.',
    splitOnClaim: true,
    spec: task('queue-water', 'water-run', 'Take water to the ticket queue', 'The ticket queue is long and hot. Bring water and hand it out.', SITE.ticketQueue, {
      objective: 'safety',
      priority: 1,
      requires: ['haul'],
    }),
  },
  {
    id: 'split-field-aed',
    step: 'split',
    team: 'supply',
    label: 'The sports field needs the spare AED.',
    spec: task('field-aed', 'supply-run', 'Take the spare AED to the sports field', 'Take the spare AED to the sports field and tell the stewards where it is.', SITE.sportsField, {
      objective: 'safety',
      priority: 2,
      requires: ['stock'],
      needs: [{ resource: 'aed', count: 1 }],
    }),
  },
  {
    id: 'split-hall-ramp',
    step: 'split',
    team: 'facilities',
    label: 'The sports hall ramp has come loose.',
    spec: task('hall-ramp', 'repair', 'Fix the sports hall ramp', 'The ramp at the sports hall has come loose. Bring the cart and fix it.', SITE.sportsHall, {
      objective: 'access',
      priority: 2,
      requires: ['repair'],
      needs: [{ resource: 'cart', count: 1 }],
    }),
  },
  {
    id: 'contested-upper-stand',
    step: 'contested',
    team: 'medics',
    label: 'Medics need the evacuation chair. It is with Access, out of reach.',
    spec: task('upper-stand-carry', 'evacuation', 'Bring a visitor down from the upper stand', 'A visitor with a twisted ankle cannot manage the stairs. Bring the evacuation chair.', SITE.upperStand, {
      objective: 'safety',
      priority: 1,
      requires: ['first-aid'],
      needs: [{ resource: 'evac-chair', count: 1 }],
      reversible: false,
    }),
  },
  {
    id: 'contested-hall-chair',
    step: 'contested',
    team: 'access',
    label: 'The sports hall lift has stopped. Access has the chair.',
    spec: task('hall-chair', 'evacuation', 'Help a wheelchair user out of the sports hall', 'The sports hall lift has stopped. Use the evacuation chair to bring a wheelchair user down.', SITE.sportsHall, {
      objective: 'safety',
      priority: 1,
      requires: ['mobility'],
      needs: [{ resource: 'evac-chair', count: 1 }],
      reversible: false,
    }),
  },
  {
    id: 'ferry-north-gate',
    step: 'ferry',
    team: 'supply',
    label: 'Supply sees the north gate is closed. Carry the news across by QR.',
    observation: { key: GATE_KEY, value: false, subject: 'North gate' },
  },
  {
    id: 'restored-queue-water',
    step: 'restored',
    team: 'facilities',
    label: 'Two teams took water to the ticket queue. Both records kept.',
  },
];
