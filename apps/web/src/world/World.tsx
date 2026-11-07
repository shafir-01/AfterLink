import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import type { ActorId, Point, TaskId } from '@afterlink/protocol';
import type { RequestKind, StageController, StageLink, StageState } from '../stage/contract';
import { teamColor } from '../ui/team';
import { Engine, type Hit } from './engine';
import { pairKey, plainReason } from './knowledge';
import { MapArt } from './MapArt';
import { groupsSentence, sentence } from './say';
import { frameFor, siteAt, TOWER, toPx, towerLamp, type Frame } from './site';
import { sound } from './sound';
import './world.css';

const COMPACT_BELOW = 760;
const DRAG_FROM = 7;
const NOTE_MS = 9000;
const HOVER_MS = 80;

const REQUESTS: { kind: RequestKind; label: string }[] = [
  { kind: 'first-aid', label: 'First aid' },
  { kind: 'blocked-path', label: 'Blocked path' },
  { kind: 'wheelchair', label: 'Wheelchair needed' },
];

interface MapNote {
  id: string;
  taskId: TaskId;
  at: Point;
  text: string;
  tone: 'stop' | 'ok';
}

interface Press {
  hit: Hit;
  x: number;
  y: number;
  dragging: boolean;
  cuts: number;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function useDark(engine: Engine | null) {
  useEffect(() => {
    if (!engine) return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = () => engine.retheme();
    const watcher = new MutationObserver(update);
    watcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    query.addEventListener('change', update);
    return () => {
      watcher.disconnect();
      query.removeEventListener('change', update);
    };
  }, [engine]);
}

export function World({ controller }: { controller: StageController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const shell = useRef<HTMLElement>(null);
  const map = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const topProbe = useRef<HTMLElement>(null);
  const bottomProbe = useRef<HTMLElement>(null);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [hovered, setHovered] = useState<ActorId | null>(null);
  const [locked, setLocked] = useState<ActorId | null>(null);
  const [cursor, setCursor] = useState<string>('');
  const [towerHot, setTowerHot] = useState(false);
  const [radial, setRadial] = useState<{ x: number; y: number } | null>(null);
  const [notes, setNotes] = useState<MapNote[]>([]);
  const [said, setSaid] = useState('');
  const [acted, setActed] = useState(false);
  const [carried, setCarried] = useState(false);
  const [muted, setMuted] = useState(false);
  const press = useRef<Press | null>(null);
  const hoverTimer = useRef(0);
  const lastTeam = useRef<ActorId | null>(null);
  const radialFirst = useRef<HTMLButtonElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const lens = hovered ?? locked;

  useLayoutEffect(() => {
    if (!canvas.current || !shell.current) return;
    const made = new Engine(canvas.current, shell.current);
    made.start();
    setEngine(made);
    return () => made.stop();
  }, []);

  useDark(engine);

  useEffect(() => {
    if (!engine) return;
    engine.arrived = () => controller.carried();
    engine.step = () => sound.play('step');
  }, [engine, controller]);

  useEffect(() => {
    if (!engine) return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => engine.setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [engine]);

  useLayoutEffect(() => {
    const el = map.current;
    const root = shell.current;
    if (!el || !root || !engine) return;
    const read = () => {
      const width = root.clientWidth;
      const compact = width < COMPACT_BELOW;
      root.toggleAttribute('data-compact', compact);
      const top = topProbe.current?.offsetHeight ?? 0;
      const bottom = compact ? 16 : (bottomProbe.current?.offsetHeight ?? 0);
      const next = frameFor(el.clientWidth, el.clientHeight, top + (compact ? 8 : 44), bottom + (compact ? 0 : 34), compact);
      engine.setFrame(next, Math.min(window.devicePixelRatio || 1, 2));
      setFrame(next);
    };
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(root);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [engine]);

  useEffect(() => {
    engine?.setState(state);
  }, [engine, state]);

  useEffect(() => {
    engine?.setLens(lens);
  }, [engine, lens]);

  useEffect(() => {
    setNotes([]);
    setLocked(null);
    setHovered(null);
    setActed(false);
    setCarried(false);
    setRadial(null);
  }, [state.run]);

  useEffect(() => {
    let queue: string[] = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      setSaid(queue.join(' '));
      queue = [];
    };
    const addNote = (taskId: TaskId, text: string, tone: MapNote['tone']) => {
      const task = stateRef.current.truth.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const id = `${taskId}:${tone}:${Date.now()}`;
      setNotes((n) => [...n.filter((x) => x.taskId !== taskId), { id, taskId, at: task.location, text, tone }]);
      setTimeout(() => setNotes((n) => n.filter((x) => x.id !== id)), NOTE_MS);
    };
    return controller.on((e) => {
      engine?.event(e);
      const text = sentence(e, stateRef.current);
      if (text) {
        queue.push(text);
        if (!timer) timer = window.setTimeout(flush, 350);
      }
      switch (e.kind) {
        case 'link':
          if (e.state === 'cut') sound.play('snap');
          break;
        case 'sync':
          sound.play('chime');
          break;
        case 'hq':
          sound.play(e.alive ? 'up' : 'down');
          break;
        case 'request':
          sound.play('drop');
          break;
        case 'refused':
          if (e.protective) {
            sound.play('thud');
            addNote(e.taskId, plainReason(e.reason), 'stop');
          }
          break;
        case 'allocated':
          addNote(e.taskId, `${e.resource} allocated`, 'ok');
          break;
        default:
          break;
      }
    });
  }, [controller, engine]);

  const groupCount = state.groups.length;
  useEffect(() => {
    if (stateRef.current.phase === 'live') setSaid(groupsSentence(stateRef.current));
  }, [groupCount]);

  useEffect(() => {
    if (radial) radialFirst.current?.focus({ preventScroll: true });
  }, [radial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setRadial(null);
      setLocked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const local = (e: ReactPointerEvent) => {
    const box = map.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const tapTeam = useCallback(
    (id: ActorId) => {
      lastTeam.current = id;
      setLocked(locked === id ? null : id);
      setActed(true);
    },
    [locked],
  );

  const tapTower = useCallback(() => {
    if (stateRef.current.hq.alive) controller.killHq();
    else controller.restoreHq();
    setActed(true);
  }, [controller]);

  const toggleLink = useCallback(
    (l: StageLink) => {
      if (l.state === 'cut' || l.blocked) controller.heal(l.a, l.b);
      else controller.cut(l.a, l.b);
      setActed(true);
    },
    [controller],
  );

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !engine) return;
    sound.wake();
    if (radial) {
      setRadial(null);
      press.current = null;
      return;
    }
    const { x, y } = local(e);
    const hit = engine.hit(x, y);
    press.current = { hit, x, y, dragging: false, cuts: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit?.kind === 'courier') {
      const from = engine.stands().find((s) => s.id === hit.id)?.at ?? { x, y };
      engine.beginDrag(from, 'currentColor', true);
      press.current.dragging = true;
      setCursor('grabbing');
    } else if (!hit || hit.kind === 'pin') {
      engine.bladeStart(x, y);
    }
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!engine) return;
    const { x, y } = local(e);
    const p = press.current;
    if (!p) {
      if (e.pointerType !== 'mouse') return;
      const hit = engine.hit(x, y);
      engine.setHover(hit);
      setTowerHot(hit?.kind === 'tower');
      const near = !hit && engine.linkNear(x, y);
      setCursor(hit?.kind === 'courier' ? 'grab' : hit ? 'act' : near ? 'cut' : '');
      clearTimeout(hoverTimer.current);
      const team = hit?.kind === 'team' ? hit.id : null;
      if (team) hoverTimer.current = window.setTimeout(() => setHovered(team), HOVER_MS);
      else setHovered(null);
      return;
    }
    const far = Math.hypot(x - p.x, y - p.y) > DRAG_FROM;
    if (!p.hit || p.hit.kind === 'pin') {
      if (far) p.dragging = true;
      for (const l of engine.bladeMove(x, y)) {
        controller.cut(l.a, l.b);
        p.cuts++;
        setActed(true);
      }
      return;
    }
    if (p.hit.kind === 'team' && far && !p.dragging) {
      p.dragging = true;
      setHovered(null);
      const from = engine.figureAt(p.hit.id);
      if (from) engine.beginDrag({ x: from.x, y: from.y - 11 * (frame?.u ?? 1) }, engine.colourOf(p.hit.id), false);
    }
    if (p.dragging) {
      const over = engine.hit(x, y);
      const source = p.hit.kind === 'team' || p.hit.kind === 'courier' ? p.hit.id : null;
      const target = over?.kind === 'team' && over.id !== source ? over.id : null;
      engine.moveDrag({ x, y }, target && validTarget(stateRef.current, p.hit, target) ? target : null);
    }
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!engine || !p) return;
    engine.bladeEnd();
    engine.endDrag();
    const { x, y } = local(e);
    if (p.dragging) {
      setCursor('');
      if (p.hit?.kind === 'team' || p.hit?.kind === 'courier') {
        const over = engine.hit(x, y);
        if (over?.kind === 'team' && over.id !== p.hit.id && validTarget(stateRef.current, p.hit, over.id)) {
          if (p.hit.kind === 'team') controller.heal(p.hit.id, over.id);
          else {
            controller.carry(p.hit.id, over.id);
            setCarried(true);
          }
          setActed(true);
        }
      }
      return;
    }
    if (p.hit?.kind === 'team') {
      tapTeam(p.hit.id);
      return;
    }
    if (p.hit?.kind === 'tower') {
      tapTower();
      return;
    }
    if (p.hit?.kind === 'pin') {
      engine.setHover(p.hit);
      return;
    }
    if (locked) {
      setLocked(null);
      return;
    }
    if (state.phase === 'live') setRadial({ x, y });
  };

  const onLeave = () => {
    if (press.current) return;
    clearTimeout(hoverTimer.current);
    setHovered(null);
    setTowerHot(false);
    setCursor('');
    engine?.setHover(null);
  };

  const drop = (kind: RequestKind) => {
    if (!frame || !radial) return;
    controller.dropRequest(siteAt(frame, radial.x, radial.y), kind);
    setRadial(null);
    setActed(true);
  };

  const openRequestByKey = () => {
    if (!frame) return;
    const at = (lastTeam.current && engine?.figureAt(lastTeam.current)) || toPx(frame, { x: 50, y: 44 });
    setRadial({ x: at.x, y: at.y });
  };

  const names = useMemo(() => new Map(state.seats.map((d) => [d.id, d.name])), [state.seats]);
  const lensName = lens ? names.get(lens) : null;
  const lensDevice = lens ? state.seats.find((d) => d.id === lens) : null;
  const stands = engine && state.groups.length > 1 ? carryRoutes(state) : [];
  const hint = state.phase !== 'live' ? null : !acted && state.story.step === 'break' ? 'Drag across a line to cut it' : stands.length && !carried && !state.carry ? 'Drag a courier to the other group' : null;

  return (
    <section className="w" ref={shell} aria-label="Festival site">
      <i ref={topProbe} className="w-sr" style={{ height: 'var(--stage-inset-top, 0px)', width: 1 }} aria-hidden="true" />
      <i ref={bottomProbe} className="w-sr" style={{ height: 'var(--stage-inset-bottom, 0px)', width: 1 }} aria-hidden="true" />
      <div className="w-map" ref={map} data-cursor={cursor || undefined} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onLeave}>
        {frame && <MapArt frame={frame} />}
        <canvas className="w-canvas" ref={canvas} aria-hidden="true" />

        {frame && (
          <>
            <TowerTag state={state} frame={frame} hot={towerHot} />
            <p className="w-reader" style={{ top: frame.oy - (frame.compact ? 0 : 14) }}>
              {lensName ? (
                <>
                  <strong>What {lensName} knows.</strong> {lensDevice?.view ? `${lensDevice.view.tasks.length} tasks, from its own device.` : ''}
                </>
              ) : (
                state.phase === 'live' && 'Every device combined. No team sees this.'
              )}
            </p>
            {hint && !frame.compact && (
              <p className="w-hint" style={{ top: frame.oy + frame.mh * 0.02 }}>
                {hint}
              </p>
            )}
            {notes
              .filter((n) => !lensDevice?.view || lensDevice.view.tasks.some((t) => t.id === n.taskId))
              .map((n) => {
                const at = toPx(frame, n.at);
                return (
                  <p key={n.id} className="w-note" data-tone={n.tone} style={{ left: at.x, top: at.y }}>
                    {n.text}
                  </p>
                );
              })}
            {radial && (
              <div className="w-radial" style={{ transform: `translate(${radial.x}px, ${radial.y}px)` }} role="group" aria-label="Raise a request here">
                <span className="w-radial-dot" aria-hidden="true" />
                {REQUESTS.map((r, i) => {
                  const { dx, dy } = radialSpot(i, radial, frame);
                  return (
                    <button key={r.kind} ref={i === 0 ? radialFirst : undefined} style={{ '--x': `${dx}px`, '--y': `${dy}px`, animationDelay: `${i * 30}ms` } as React.CSSProperties} onClick={() => drop(r.kind)}>
                      {r.label}
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}

        <div className="w-keys">
          {state.seats.map((d) => (
            <button key={d.id} className="w-key" ref={(el) => engine?.bindAnchor(`team:${d.id}`, el)} onClick={() => tapTeam(d.id)} onFocus={() => (lastTeam.current = d.id)} aria-label={teamLabel(d.name, d.task?.title, lens === d.id)}>
              {d.name}
            </button>
          ))}
          {state.pairs.map((l) => (
            <button key={pairKey(l.a, l.b)} className="w-key" ref={(el) => engine?.bindAnchor(`link:${pairKey(l.a, l.b)}`, el)} onClick={() => toggleLink(l)} aria-label={linkLabel(l, names)}>
              {names.get(l.a)} to {names.get(l.b)}
            </button>
          ))}
          {frame && (
            <button className="w-key w-key-tower" style={{ transform: `translate(${towerLamp(frame).x - 32}px, ${towerLamp(frame).y}px)` }} onClick={tapTower} aria-label={state.hq.alive ? 'HQ tower. Press Enter to kill HQ.' : 'HQ tower, down. Press Enter to restart HQ.'}>
              HQ
            </button>
          )}
          {stands.map((s) => (
            <button
              key={`${s.from}-${s.to}`}
              className="w-sr"
              onClick={() => {
                controller.carry(s.from, s.to);
                setCarried(true);
              }}
            >
              Carry an update from {names.get(s.from)} to {names.get(s.to)}
            </button>
          ))}
          <button className="w-sr" onClick={openRequestByKey}>
            Raise a request
          </button>
        </div>

        {frame && (
          <button
            className="w-sound"
            style={{ top: frame.compact ? 4 : frame.oy - 22 }}
            aria-pressed={!muted}
            onClick={() => {
              sound.muted = !muted;
              setMuted(!muted);
              if (muted) sound.wake();
            }}
          >
            {muted ? 'Sound off' : 'Sound on'}
          </button>
        )}
      </div>

      {frame?.compact && <List state={state} lens={lens} onTeam={tapTeam} onLink={toggleLink} onTower={tapTower} onCarry={(a, b) => controller.carry(a, b)} routes={stands} names={names} />}

      <div className="w-devices" aria-hidden="true">
        {state.seats.map((d) => (
          <iframe key={d.id} ref={(el) => controller.attach(d.id, el)} title={`${d.name} device`} src={d.src} allow="microphone; camera; autoplay" tabIndex={-1} />
        ))}
      </div>

      <p className="w-sr" role="status" aria-live="polite">
        {said}
      </p>
    </section>
  );
}

function radialSpot(i: number, at: { x: number; y: number }, f: Frame) {
  const radius = f.compact ? 62 : 84;
  const below = at.y < 150;
  const angles = below ? [150, 90, 30] : [-150, -90, -30];
  const a = (angles[i]! * Math.PI) / 180;
  const edge = Math.max(0, 96 - at.x) - Math.max(0, at.x + 96 - f.width);
  return { dx: Math.cos(a) * radius * 1.2 + edge, dy: Math.sin(a) * radius };
}

const teamLabel = (name: string, task: string | undefined, looking: boolean) => `${name}. ${task ? `Working on: ${task}.` : 'No task.'} Press Enter to ${looking ? 'leave its view' : 'see what this team knows'}.`;

const linkLabel = (l: StageLink, names: Map<ActorId, string>) => {
  const pair = `Link between ${names.get(l.a)} and ${names.get(l.b)}`;
  if (l.waitingForHq) return `${pair}, waiting for HQ.`;
  return l.state === 'cut' ? `${pair}, cut. Press Enter to heal it.` : `${pair}, ${l.state === 'open' ? 'open' : 'forming'}. Press Enter to cut it.`;
};

/** A heal joins two teams that are apart. A carry crosses from one group to another. */
function validTarget(state: StageState, source: NonNullable<Hit>, target: ActorId): boolean {
  if (source.kind === 'team') {
    const link = state.pairs.find((l) => pairKey(l.a, l.b) === pairKey(source.id, target));
    return !!link && link.state !== 'open';
  }
  if (source.kind === 'courier') return !state.groups.some((g) => g.includes(source.id) && g.includes(target));
  return false;
}

/** One sensible carry between each pair of groups, for keyboards and phones. */
function carryRoutes(state: StageState): { from: ActorId; to: ActorId }[] {
  const running = state.carry && state.carry.phase !== 'done' && state.carry.phase !== 'failed';
  if (running || state.phase !== 'live') return [];
  const out: { from: ActorId; to: ActorId }[] = [];
  state.groups.forEach((g, i) => {
    state.groups.slice(i + 1).forEach((h) => {
      out.push({ from: g[0]!, to: h[0]! });
      out.push({ from: h[0]!, to: g[0]! });
    });
  });
  return out;
}

function TowerTag({ state, frame, hot }: { state: StageState; frame: Frame; hot: boolean }) {
  const base = toPx(frame, TOWER);
  const alive = state.hq.alive;
  const confirmed = state.hq.lastConfirmedAt;
  const line = hot ? (alive ? 'Click to kill it' : 'Click to restart it') : alive ? `Sees ${state.hq.teams} ${state.hq.teams === 1 ? 'team' : 'teams'}` : confirmed ? `Last confirmed ${clock(confirmed)}` : 'Not confirmed';
  return (
    <p className="w-tag w-tower-tag" data-state={alive ? 'live' : 'dead'} style={{ left: base.x - 30 * frame.u, top: base.y - 66 * frame.u }}>
      <strong>{alive ? 'HQ' : 'HQ down'}</strong>
      {line}
    </p>
  );
}

function List({
  state,
  lens,
  onTeam,
  onLink,
  onTower,
  onCarry,
  routes,
  names,
}: {
  state: StageState;
  lens: ActorId | null;
  onTeam: (id: ActorId) => void;
  onLink: (l: StageLink) => void;
  onTower: () => void;
  onCarry: (a: ActorId, b: ActorId) => void;
  routes: { from: ActorId; to: ActorId }[];
  names: Map<ActorId, string>;
}) {
  return (
    <div className="w-list">
      <h2>Teams</h2>
      <ul>
        {state.seats.map((d) => (
          <li className="w-row" key={d.id}>
            <span className="w-row-dot" style={{ background: teamColor(d.team) }} aria-hidden="true" />
            <button className="w-row-main" aria-pressed={lens === d.id} onClick={() => onTeam(d.id)}>
              <b>{d.name}</b>
              <span>{d.task ? d.task.title : 'No task'}</span>
            </button>
          </li>
        ))}
      </ul>
      <h2>Links</h2>
      <ul>
        {state.pairs.map((l) => (
          <li className="w-row" key={pairKey(l.a, l.b)}>
            <div className="w-row-main">
              <b>
                {names.get(l.a)} and {names.get(l.b)}
              </b>
              <span>{l.waitingForHq ? 'Waiting for HQ' : l.state === 'open' ? 'Open' : l.state === 'cut' ? 'Cut' : 'Forming'}</span>
            </div>
            <button className="w-act" onClick={() => onLink(l)}>
              {l.state === 'cut' || l.blocked ? 'Heal' : 'Cut'}
            </button>
          </li>
        ))}
      </ul>
      {routes.length > 0 && (
        <>
          <h2>Courier</h2>
          <ul>
            {routes.map((r) => (
              <li className="w-row" key={`${r.from}-${r.to}`}>
                <div className="w-row-main">
                  <b>
                    {names.get(r.from)} to {names.get(r.to)}
                  </b>
                </div>
                <button className="w-act" onClick={() => onCarry(r.from, r.to)}>
                  Carry
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>HQ</h2>
      <ul>
        <li className="w-row">
          <div className="w-row-main">
            <b>{state.hq.alive ? 'Up' : 'Down'}</b>
          </div>
          <button className="w-act" onClick={onTower}>
            {state.hq.alive ? 'Kill' : 'Restart'}
          </button>
        </li>
      </ul>
    </div>
  );
}

export default World;
