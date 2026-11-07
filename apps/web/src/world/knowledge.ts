import type { ActorId, Point, TaskId } from '@afterlink/protocol';
import type { CompactTask } from '../bridge';
import type { StageDevice, StageState } from '../stage/contract';

/** A pin on the map, as one reader of the map would see it. */
export interface PinView {
  id: TaskId;
  title: string;
  at: Point;
  place: string;
  status: CompactTask['status'];
  owner?: ActorId;
  /** The news about this task comes from someone out of contact. */
  ghost: boolean;
  /** When the reader last heard from that someone. */
  heardAt: number | null;
}

export interface FigureView {
  id: ActorId;
  /** Seen live by this reader. */
  live: boolean;
  /** Where this reader last placed them, when not live. */
  at: Point | null;
  heardAt: number | null;
}

/** What one reader of the map can honestly claim. A null lens is every device combined. */
export interface Reading {
  lens: ActorId | null;
  pins: PinView[];
  figures: FigureView[];
  /** Pairs this reader can vouch for. Null means all of them. */
  links: Set<string> | null;
  signalUp: boolean;
}

const ACTIVE: ReadonlySet<CompactTask['status']> = new Set(['claimed', 'accepted']);

export const pairKey = (a: ActorId, b: ActorId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const lastPlace = (other: StageDevice, tasks: CompactTask[]): Point => {
  const theirs = tasks.filter((t) => t.owner === other.id).sort((a, b) => b.updatedAt - a.updatedAt);
  return (theirs.find((t) => ACTIVE.has(t.status)) ?? theirs[0])?.location ?? other.home;
};

function everything(state: StageState): Reading {
  return {
    lens: null,
    pins: state.truth.tasks.map((t) => ({ id: t.id, title: t.title, at: t.location, place: t.locationName, status: t.status, owner: t.owner, ghost: false, heardAt: null })),
    figures: state.seats.map((d) => ({ id: d.id, live: true, at: null, heardAt: null })),
    links: null,
    signalUp: state.hq.alive,
  };
}

/** One device's own report and nothing else: what it does not know does not appear. */
function through(state: StageState, device: StageDevice): Reading {
  const view = device.view!;
  const reachable = new Set(view.reachable);
  const inContact = (id?: ActorId) => !id || id === device.id || reachable.has(id);
  const heard = (id: ActorId) => view.lastHeard[id] ?? null;
  return {
    lens: device.id,
    pins: view.tasks.map((t) => {
      const ghost = ACTIVE.has(t.status) && !inContact(t.owner);
      return { id: t.id, title: t.title, at: t.location, place: t.locationName, status: t.status, owner: t.owner, ghost, heardAt: ghost ? heard(t.owner!) : null };
    }),
    figures: state.seats.map((d) => (inContact(d.id) ? { id: d.id, live: true, at: null, heardAt: null } : { id: d.id, live: false, at: lastPlace(d, view.tasks), heardAt: heard(d.id) })),
    links: new Set(view.links.filter((l) => l.state === 'open').map((l) => pairKey(device.id, l.peer))),
    signalUp: view.signalUp,
  };
}

export function read(state: StageState, lens: ActorId | null): Reading {
  const device = lens ? state.seats.find((d) => d.id === lens) : null;
  return device?.view ? through(state, device) : everything(state);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where a team waits when it has nothing to do. A split group closes up and moves away from the
 * others, so the gap on the map is the gap in the network.
 */
export function restPoints(state: StageState): Map<ActorId, Point> {
  const rest = new Map<ActorId, Point>();
  const homes = new Map(state.seats.map((d) => [d.id, d.home]));
  const centre = (ids: ActorId[]) => {
    const points = ids.map((id) => homes.get(id)).filter((p): p is Point => !!p);
    const n = points.length || 1;
    return { x: points.reduce((s, p) => s + p.x, 0) / n, y: points.reduce((s, p) => s + p.y, 0) / n };
  };
  for (const d of state.seats) rest.set(d.id, d.home);
  if (state.groups.length < 2) return rest;
  const all = centre(state.seats.map((d) => d.id));
  for (const group of state.groups) {
    const mid = centre(group);
    const dx = mid.x - all.x;
    const dy = mid.y - all.y;
    const norm = Math.hypot(dx, dy) || 1;
    const pull = group.length > 1 ? 0.5 : 0;
    for (const id of group) {
      const home = homes.get(id);
      if (!home) continue;
      rest.set(id, {
        x: clamp(home.x + (mid.x - home.x) * pull + (dx / norm) * 14, 6, 90),
        y: clamp(home.y + (mid.y - home.y) * pull + (dy / norm) * 9, 8, 92),
      });
    }
  }
  return rest;
}

/** Text for a refusal, without the opening the volunteer already sees on their device. */
export function plainReason(reason: string): string {
  const text = reason.replace(/^Cannot start( yet)?:\s*/i, '').trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : reason;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}
