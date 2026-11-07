import { describe, expect, it } from 'vitest';
import { createActor, createMemoryStorage, type ActorNode } from '@afterlink/actor';
import { MemoryNetwork, VirtualClock } from '@afterlink/mesh';
import { festivalCapsule, provision, scenarioBeats, validateTaskSpec } from '@afterlink/mission';
import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventId, Json, RefusalCode, TaskSource, TaskSpec, TeamId } from '@afterlink/protocol';
import type { ObserveOptions } from '../bridge';
import { compactView } from '../device/compact';
import type { StageCarry, StageDevice, StageState } from '../stage/contract';
import type { PlayController } from './contract';
import { chairVerdict, inFlight, isAlone } from './dares';
import { PlayEngine } from './engine';
import { buildDeck, gapAfter, PLACES, type TaskIncident } from './incidents';
import { CHAIR, endLine, readBest, readShare, shareUrl, writeBest } from './score';
import { cleanSeed, newSeed, rngFor } from './seed';

const SEED = 'K7Q2MX';
const capsule = festivalCapsule({ publicKey: 'site', secretKey: '' }, { now: 0 });
const tasks = (seed: string, length?: number) => buildDeck(seed, length).filter((i): i is TaskIncident => i.type === 'task');

describe('seeds', () => {
  it('draws the same numbers for the same seed', () => {
    const a = rngFor(SEED);
    const b = rngFor(SEED);
    expect(Array.from({ length: 50 }, a)).toEqual(Array.from({ length: 50 }, b));
    expect(rngFor('K7Q2MY')()).not.toBe(rngFor(SEED)());
  });

  it('round-trips new seeds and refuses anything else', () => {
    const seed = newSeed(rngFor('fixed'));
    expect(cleanSeed(seed.toLowerCase())).toBe(seed);
    for (const bad of ['', 'short', 'TOOLONG1', 'K7Q2M0', 'K7Q2MI', '<b>x1', 7, null]) expect(cleanSeed(bad)).toBeNull();
  });
});

describe('incident stream', () => {
  it('is identical for a seed, and differs between seeds', () => {
    expect(buildDeck(SEED)).toEqual(buildDeck(SEED));
    expect(tasks(SEED).map((t) => t.spec.title)).not.toEqual(tasks('M3NP8T').map((t) => t.spec.title));
  });

  it('gives a longer deck the same opening', () => {
    expect(buildDeck(SEED, 96).slice(0, 40)).toEqual(buildDeck(SEED, 40));
  });

  for (const seed of [SEED, 'M3NP8T', '222222', 'ZZZZZZ', 'HQ4T7V']) {
    it(`raises only tasks the mission can actually run (${seed})`, () => {
      const skills = new Set(capsule.teams.flatMap((t) => t.capabilities));
      const resources = new Set(capsule.resources.map((r) => r.id));
      const objectives = new Set(capsule.objectives.map((o) => o.id));
      const teams = new Set(capsule.teams.map((t) => t.id));
      const places = new Map(Object.values(PLACES).map((p) => [p.name, p.at]));
      const seen = new Set<string>();
      const reports = new Set<string>();
      const deck = buildDeck(seed);

      for (const incident of deck) {
        expect(teams.has(incident.team)).toBe(true);
        if (incident.type === 'report') {
          reports.add(incident.key);
          continue;
        }
        const { spec } = incident;
        expect(validateTaskSpec(spec)).toEqual([]);
        expect(spec.brief).not.toContain('{');
        expect(seen.has(spec.id)).toBe(false);
        expect(spec.dependsOn.every((id) => seen.has(id))).toBe(true);
        expect(spec.reliesOn?.every((key) => reports.has(key)) ?? true).toBe(true);
        expect(spec.requires.every((c) => skills.has(c))).toBe(true);
        expect(spec.needs.every((n) => resources.has(n.resource))).toBe(true);
        expect(objectives.has(spec.objective)).toBe(true);
        expect(places.get(spec.locationName)).toEqual(spec.location);
        seen.add(spec.id);
      }
    });
  }

  it('keeps every place on the mission map', () => {
    const named = [...capsule.tasks, ...scenarioBeats.flatMap((b) => (b.spec ? [b.spec] : []))];
    for (const spec of named) expect(Object.values(PLACES).find((p) => p.name === spec.locationName)?.at).toEqual(spec.location);
    for (const team of capsule.teams) expect(Object.values(PLACES).some((p) => p.at.x === team.home.x && p.at.y === team.home.y)).toBe(true);
  });

  it('leaves the chair free for the dare', () => {
    expect(tasks(SEED).some((t) => t.spec.needs.some((n) => n.resource === CHAIR))).toBe(false);
  });

  it('asks for scarce gear only a few times per run', () => {
    const scarce = tasks(SEED).filter((t) => t.spec.needs.length);
    expect(scarce.length).toBeGreaterThan(0);
    expect(scarce.length).toBeLessThanOrEqual(4);
  });

  it('starts simple and gets harder along the deck', () => {
    const deck = buildDeck(SEED);
    expect(deck.slice(0, 5).every((i) => i.tier === 1)).toBe(true);
    const hard = (from: number, to: number) => deck.slice(from, to).filter((i) => i.tier === 3).length;
    expect(hard(0, 12)).toBe(0);
    expect(hard(30, 60)).toBeGreaterThan(5);
    const opening = deck.slice(0, 10).filter((i) => i.type === 'task' && (i.spec.dependsOn.length || i.spec.needs.length || !i.spec.reversible)).length;
    const later = deck.slice(30, 40).filter((i) => i.type === 'task' && (i.spec.dependsOn.length || i.spec.needs.length || !i.spec.reversible)).length;
    expect(later).toBeGreaterThan(opening);
  });

  it('comes faster the more links are cut, without changing what comes', () => {
    const first = buildDeck(SEED)[3]!;
    const gaps = [0, 2, 6].map((cuts) => gapAfter(first, cuts));
    expect(gaps[0]).toBeGreaterThan(gaps[1]!);
    expect(gaps[1]).toBeGreaterThan(gaps[2]!);
    expect(gapAfter({ n: 90, jitter: 0.85 }, 6)).toBeGreaterThanOrEqual(1200);
    expect(gapAfter(first, 0)).toBe(gapAfter(first, 0));
  });
});

describe('end line', () => {
  it('reads like the brief', () => {
    expect(endLine({ cuts: 6, finished: 14, chairSafe: true })).toBe('You cut 6 links. They finished 14 tasks and never promised the chair twice.');
  });
  it('counts one properly and admits a double promise', () => {
    expect(endLine({ cuts: 1, finished: 1, chairSafe: true })).toBe('You cut 1 link. They finished 1 task and never promised the chair twice.');
    expect(endLine({ cuts: 0, finished: 3, chairSafe: false })).toBe('You cut nothing. They finished 3 tasks but promised the chair twice.');
  });
});

describe('sharing', () => {
  const at = { origin: 'https://example.test', pathname: '/' };

  it('encodes the seed and the score and nothing else', () => {
    const url = new URL(shareUrl({ seed: SEED, score: 5 }, at));
    expect(url.hash).toBe(`#/?seed=${SEED}&score=5`);
    expect(url.search).toBe('');
    expect(readShare(url.hash)).toEqual({ seed: SEED, score: 5 });
  });

  it('ignores a link it cannot trust', () => {
    for (const hash of ['', '#/', '#/?seed=K7Q2MX', '#/?score=5', '#/?seed=nope&score=5', '#/?seed=K7Q2MX&score=-1', '#/?seed=K7Q2MX&score=1e3', '#/?seed=K7Q2MX&score=99999']) {
      expect(readShare(hash)).toBeNull();
    }
  });
});

describe('best score', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage;
  };

  it('survives a reload', () => {
    const store = memory();
    writeBest({ score: 7, seed: SEED }, store);
    expect(readBest(store)).toEqual({ score: 7, seed: SEED });
  });

  it('never throws when storage does', () => {
    const broken = {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readBest(broken)).toBeNull();
    expect(() => writeBest({ score: 1, seed: SEED }, broken)).not.toThrow();
    expect(readBest(null)).toBeNull();
  });

  it('ignores a tampered entry', () => {
    const store = memory();
    store.setItem('afterlink.play.best', '{"score":"lots","seed":"<x>"}');
    expect(readBest(store)).toBeNull();
    store.setItem('afterlink.play.best', 'not json');
    expect(readBest(store)).toBeNull();
  });
});

const STEP_MS = 100;
const PROTECTIVE = new Set<RefusalCode>(['NO_RIGHT', 'TOKEN_IN_TRANSIT', 'STALE_KNOWLEDGE', 'HUMAN_APPROVAL_REQUIRED']);

/** Four real actors over a real mesh in virtual time, behind the same controller the stage gives free play. */
async function realStage(seed = 1) {
  const clock = new VirtualClock(1_000_000);
  const network = new MemoryNetwork({ seed, clock, latencyMs: 5, signalLatencyMs: 5 });
  const issuer = generateKeys();
  const mission = festivalCapsule(issuer, { now: clock.now() });
  const { bundles } = provision(mission, issuer, 'play');
  const teams = mission.teams.map((t) => t.id);
  const nodes = new Map<TeamId, ActorNode>(
    teams.map((team) => {
      const bundle = bundles[team]!;
      const id = bundle.actor.publicKey;
      const node = createActor({ bundle, connector: network.connector(id), signal: network.signal(id), storage: createMemoryStorage(), now: () => clock.now(), autopilot: true, autopilotDelayMs: 1500, tickMs: 500 });
      return [team, node];
    }),
  );
  for (const node of nodes.values()) await node.start();

  const idOf = (team: TeamId): ActorId => bundles[team]!.actor.publicKey;
  const teamOf = (id: ActorId) => teams.find((t) => idOf(t) === id)!;
  const node = (team: TeamId) => nodes.get(team)!;

  const listeners = new Set<() => void>();
  const blocked = new Map<ActorId, Set<ActorId>>(teams.map((t) => [idOf(t), new Set()]));
  const raised: { team: TeamId; id: string }[] = [];
  const reported: string[] = [];
  let run = 0;
  let cuts = 0;
  let hqAlive = true;
  let carry: StageCarry | null = null;

  const apply = (id: ActorId) => node(teamOf(id)).setFaults({ blocked: [...blocked.get(id)!] });

  const snapshot = (): StageState => {
    const devices: StageDevice[] = teams.map((team) => {
      const view = compactView(node(team).view(), clock.now());
      const home = mission.teams.find((t) => t.id === team)!.home;
      return { id: idOf(team), team, name: mission.teams.find((t) => t.id === team)!.name, home, view, signalUp: view.signalUp, task: null, goal: home, decisions: [...view.refusals].reverse() };
    });
    const groups: ActorId[][] = [];
    for (const d of devices) {
      if (groups.some((g) => g.includes(d.id))) continue;
      groups.push([d.id, ...d.view!.reachable]);
    }
    const byId = new Map<string, StageState['truth']['tasks'][number]>();
    const rank = ['open', 'deferred', 'refused', 'claimed', 'accepted', 'completed'];
    for (const d of devices) {
      for (const t of d.view!.tasks) {
        const had = byId.get(t.id);
        if (!had || rank.indexOf(t.status) > rank.indexOf(had.status)) byId.set(t.id, { ...t, knownBy: [...(had?.knownBy ?? []), d.id] });
        else had.knownBy.push(d.id);
      }
    }
    const safe = new Set(devices.flatMap((d) => d.decisions.filter((r) => r.refusal && PROTECTIVE.has(r.refusal)).map((r) => `${r.actor}|${r.taskId}|${r.refusal}`)));
    return {
      run,
      phase: 'live',
      failure: null,
      capsule: mission,
      devices,
      links: [],
      groups,
      hq: { alive: hqAlive, teams: 4, done: 0, lastConfirmedAt: null, blind: [], firstAt: null, ticks: [] },
      story: { step: 'break', label: '', busy: false, line: '', finished: false },
      score: { tasksFinished: [...byId.values()].filter((t) => t.status === 'completed').length, unsafeRefused: safe.size, linksCut: cuts },
      carry,
      truth: { tasks: [...byId.values()], tokens: devices[0]!.view!.tokens },
      phone: null,
    };
  };

  const stage: PlayController = {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    on: () => () => undefined,
    advance: () => undefined,
    restart: () => {
      run++;
    },
    killHq: () => {
      hqAlive = false;
      network.killHub();
    },
    reviveHq: () => {
      hqAlive = true;
      network.restoreHub();
    },
    cut: (a, b) => {
      blocked.get(a)!.add(b);
      blocked.get(b)!.add(a);
      apply(a);
      apply(b);
      cuts++;
    },
    heal: (a, b) => {
      blocked.get(a)!.delete(b);
      blocked.get(b)!.delete(a);
      apply(a);
      apply(b);
    },
    healAll: () => undefined,
    dropRequest: () => null,
    carry: (from, to) => {
      if (carry && carry.phase !== 'done' && carry.phase !== 'failed') return false;
      carry = { phase: 'walking', from, to, have: 0, total: 1, newEvents: 0, walkMs: 6000 };
      const packet = node(teamOf(from)).buildFerry();
      clock.setTimeout(() => {
        const result = node(teamOf(to)).ingestFerry(packet);
        carry = { ...carry!, phase: 'done', have: 1, newEvents: result.newEvents };
      }, 6000);
      return true;
    },
    carryArrived: () => undefined,
    openPhone: () => undefined,
    openWhy: () => undefined,
    addTask: (team: TeamId, spec: TaskSpec, source: TaskSource) => {
      raised.push({ team, id: spec.id });
      return node(team).submitTask(spec, source);
    },
    observe: (team: TeamId, key: string, value: Json, options?: ObserveOptions) => {
      reported.push(key);
      return node(team).observe(key, value, options);
    },
    collect: async () => {
      const events = new Map<EventId, AnyEvent>();
      const hqSeen = new Set<EventId>();
      for (const n of nodes.values()) {
        for (const e of n.events()) events.set(e.id, e);
        for (const id of n.view().hqSeen) hqSeen.add(id);
      }
      return { events: [...events.values()], hqSeen: [...hqSeen], episodes: [] };
    },
  };

  const pump = async (ms: number) => {
    for (let spent = 0; spent < ms; spent += STEP_MS) {
      clock.advance(STEP_MS);
      await new Promise((r) => setImmediate(r));
      listeners.forEach((fn) => fn());
    }
  };
  const until = async (what: string, done: () => boolean, maxMs = 30_000) => {
    for (let spent = 0; spent <= maxMs; spent += STEP_MS) {
      if (done()) return;
      await pump(STEP_MS);
    }
    throw new Error(`Timed out waiting for: ${what}`);
  };

  const saved: unknown[] = [];
  const bestStore: { best: { score: number; seed: string } | null } = { best: null };
  const engine = new PlayEngine(stage, {
    now: () => clock.now(),
    every: (ms, fn) => {
      let live = true;
      const loop = () => {
        if (!live) return;
        fn();
        clock.setTimeout(loop, ms);
      };
      clock.setTimeout(loop, ms);
      return () => {
        live = false;
      };
    },
    save: async (input) => void saved.push(input),
    newSeed: () => SEED,
    loadBest: () => bestStore.best,
    storeBest: (best) => void (bestStore.best = best),
    hash: () => '',
  });

  await until('all links open', () => teams.every((t) => node(t).view().reachable.length === 3));
  const split = (left: TeamId[], right: TeamId[]) => {
    for (const a of left) for (const b of right) stage.cut(idOf(a), idOf(b));
  };
  return { stage, engine, pump, until, node, idOf, teams, raised, reported, saved, bestStore, split, snapshot };
}

type Real = Awaited<ReturnType<typeof realStage>>;

async function playOut(s: Real, seconds = 30) {
  s.engine.setSeconds(seconds);
  s.engine.begin();
  await s.until('run starts', () => s.engine.snapshot().phase === 'running');
}

const ended = (s: Real) => s.until('end card', () => s.engine.snapshot().phase === 'ended', 200_000);

describe('a run on real actors', () => {
  it('raises the stream through the devices and ends with what the logs say', async () => {
    const s = await realStage();
    await playOut(s);
    await ended(s);
    const { end, counters, best, newBest } = s.engine.snapshot();

    const deck = buildDeck(SEED);
    expect(s.raised.length).toBeGreaterThan(5);
    expect(s.raised.map((r) => r.id)).toEqual(deck.flatMap((i) => (i.type === 'task' ? [i.spec.id] : [])).slice(0, s.raised.length));

    expect(end?.recorded).toBe(true);
    expect(end?.line).toMatch(/^You cut nothing\. They finished \d+ tasks and never promised the chair twice\.$/);
    expect(end!.finished).toBeGreaterThan(5);
    expect(end!.finished).toBeGreaterThanOrEqual(counters.finished);
    expect(end!.raised).toBe(s.raised.length);
    expect(end!.stopped).toBeLessThanOrEqual(end!.raised);
    expect(s.saved).toHaveLength(1);
    expect(newBest).toBe(true);
    expect(best).toEqual({ score: end!.stopped, seed: SEED });
  });

  it('replays the same incidents from a seed, whatever the player cuts', async () => {
    const calm = await realStage(2);
    await playOut(calm, 25);
    await ended(calm);

    const wild = await realStage(3);
    await playOut(wild, 25);
    await wild.pump(5000);
    wild.split(['medics', 'supply'], ['access', 'facilities']);
    await ended(wild);

    const shared = Math.min(calm.raised.length, wild.raised.length);
    expect(shared).toBeGreaterThan(3);
    expect(wild.raised.slice(0, shared)).toEqual(calm.raised.slice(0, shared));
    expect(wild.raised.length).toBeGreaterThan(calm.raised.length);
  });

  it('turns cuts into refusals, not into broken promises', async () => {
    const s = await realStage(4);
    await playOut(s, 60);
    await s.pump(4000);
    s.split(['medics', 'supply'], ['access', 'facilities']);
    await ended(s);
    const { end } = s.engine.snapshot();
    expect(end?.cuts).toBe(4);
    expect(end?.line).toContain('You cut 4 links.');
    expect(end?.line).toContain('never promised the chair twice');
    expect(end!.stopped).toBeGreaterThan(0);
  });

  it('counts only what the devices report', async () => {
    const s = await realStage(5);
    await playOut(s, 20);
    await s.pump(8000);
    const live = s.engine.snapshot().counters;
    const state = s.snapshot();
    expect(live.finished).toBe(state.score.tasksFinished);
    expect(live.refused).toBe(state.score.unsafeRefused);
    expect(live.cuts).toBe(0);
  });

  it('stops when the stage is restarted underneath it', async () => {
    const s = await realStage(6);
    await playOut(s, 30);
    s.stage.restart();
    await s.pump(STEP_MS);
    expect(s.engine.snapshot().phase).toBe('idle');
    expect(s.engine.snapshot().active).toBe(false);
  });
});

describe('dares on real actors', () => {
  it('one chair, two groups: one promise and one reasoned refusal', async () => {
    const s = await realStage(7);
    await playOut(s, 60);

    s.engine.arm('chair');
    expect(s.engine.snapshot().note).toBe('Split the teams first.');
    await s.pump(500);
    expect(s.raised.some((r) => r.id.startsWith('dare-chair'))).toBe(false);

    s.split(['medics', 'supply'], ['access', 'facilities']);
    await s.until('groups form', () => s.snapshot().groups.length === 2);
    await s.until('the dare settles', () => s.engine.snapshot().dares.find((d) => d.id === 'chair')?.status === 'done');
    const dare = s.engine.snapshot().dares.find((d) => d.id === 'chair')!;
    expect(dare.outcome).toMatch(/^Access got the chair\. (Medics|Supply) refused\.$/);
    expect(dare.why).toBe('Access holds the evacuation chair and cannot be reached.');
    expect(s.raised.filter((r) => r.id.startsWith('dare-chair'))).toHaveLength(2);

    const state = s.snapshot();
    const committed = new Set(state.devices.flatMap((d) => d.view!.tokens.filter((t) => t.resource === CHAIR && t.committedTo).map((t) => t.committedTo)));
    expect(committed.size).toBe(1);
    expect(chairVerdict(state)).not.toBeNull();

    await ended(s);
    expect(s.engine.snapshot().end?.line).toContain('never promised the chair twice');
  });

  it('Medics cut off finish their work alone', async () => {
    const s = await realStage(8);
    await playOut(s, 60);
    s.engine.arm('isolate');
    expect(s.engine.snapshot().note).toBe('Cut all three of their links.');
    s.split(['medics'], ['access', 'facilities', 'supply']);
    await s.until('Medics stand alone', () => isAlone(s.snapshot(), 'medics'));
    await s.until('the dare settles', () => s.engine.snapshot().dares.find((d) => d.id === 'isolate')?.status === 'done');
    const dare = s.engine.snapshot().dares.find((d) => d.id === 'isolate')!;
    expect(dare.outcome).toBe('Medics finished a task alone.');
    expect(dare.why).toBeTruthy();
    const others = s.snapshot().devices.filter((d) => d.team !== 'medics');
    for (const d of others) expect(d.view!.tasks.some((t) => t.id.startsWith('dare-alone'))).toBe(false);
  });

  it('counts isolating Medics even if the dare was never pressed', async () => {
    const s = await realStage(9);
    await playOut(s, 60);
    s.split(['medics'], ['access', 'facilities', 'supply']);
    await s.until('the dare settles', () => s.engine.snapshot().dares.find((d) => d.id === 'isolate')?.status === 'done');
  });

  it('HQ killed mid transfer: the update still lands', async () => {
    const s = await realStage(10);
    await playOut(s, 60);
    s.engine.arm('hq');
    expect(s.engine.snapshot().note).toBe('Transfer under way. Kill HQ now.');
    expect(inFlight(s.snapshot())).toBe('carry');
    await s.pump(1000);
    s.stage.killHq();
    await s.until('the dare settles', () => s.engine.snapshot().dares.find((d) => d.id === 'hq')?.status === 'done');
    const dare = s.engine.snapshot().dares.find((d) => d.id === 'hq')!;
    expect(dare.outcome).toBe('The update arrived anyway.');
    expect(s.snapshot().carry?.phase).toBe('done');
  });

  it('a transfer that lands first leaves the dare open', async () => {
    const s = await realStage(11);
    await playOut(s, 60);
    s.engine.arm('hq');
    await s.until('it lands', () => s.snapshot().carry?.phase === 'done');
    await s.pump(STEP_MS * 2);
    const snap = s.engine.snapshot();
    expect(snap.dares.find((d) => d.id === 'hq')?.status).toBe('open');
    expect(snap.note).toBe('It arrived first. Try again.');
  });
});

describe('explore', () => {
  const report = (label: string, s: Real) => {
    const snap = s.engine.snapshot();
    const e = snap.end!;
    const reasons = new Map<string, number>();
    const all = s.snapshot();
    for (const d of all.devices) for (const r of d.decisions) reasons.set(r.refusal ?? 'none', (reasons.get(r.refusal ?? 'none') ?? 0) + 1);
    console.log(label, JSON.stringify({ raised: e.raised, finished: e.finished, refused: e.refused, stopped: e.stopped, cuts: e.cuts }), [...reasons.entries()].join(' '), e.line);
  };
  for (const seed of ['K7Q2MX', 'M3NP8T', 'HQ4T7V']) {
    it('calm ' + seed, async () => {
      const s = await realStage(21);
      s.engine.setSeconds(90);
      s.engine.begin(seed);
      await s.until('run', () => s.engine.snapshot().phase === 'running');
      await ended(s);
      report('calm ' + seed, s);
    });
    it('split ' + seed, async () => {
      const s = await realStage(22);
      s.engine.setSeconds(90);
      s.engine.begin(seed);
      await s.until('run', () => s.engine.snapshot().phase === 'running');
      await s.pump(15000);
      s.split(['medics', 'supply'], ['access', 'facilities']);
      await ended(s);
      report('split ' + seed, s);
    });
    it('shatter ' + seed, async () => {
      const s = await realStage(23);
      s.engine.setSeconds(90);
      s.engine.begin(seed);
      await s.until('run', () => s.engine.snapshot().phase === 'running');
      await s.pump(15000);
      s.split(['medics'], ['access', 'facilities', 'supply']);
      await s.pump(10000);
      s.split(['access'], ['facilities', 'supply']);
      await s.pump(10000);
      s.split(['facilities'], ['supply']);
      await ended(s);
      report('shatter ' + seed, s);
    });
  }
});
