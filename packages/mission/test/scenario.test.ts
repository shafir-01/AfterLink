import { describe, expect, it } from 'vitest';
import { generateKeys } from '@afterlink/protocol';
import type { TaskSpec } from '@afterlink/protocol';
import { festivalCapsule, scenarioBeats, scenarioSplit, validateCapsule, validateTaskSpec } from '../src/index.ts';
import { accept, claim, complete, cover, create, decision, stateOf, sync, world } from './helpers.ts';

const capsule = festivalCapsule(generateKeys(), { now: 1_000 });
const beat = (id: string) => scenarioBeats.find((b) => b.id === id)!;
const specOf = (id: string): TaskSpec => beat(id).spec!;

describe('festivalCapsule', () => {
  it('is Field Day, valid and stable for one issuer and time', () => {
    const issuer = generateKeys();
    const a = festivalCapsule(issuer, { now: 5 });
    expect(a.name).toBe('Field Day');
    expect(a).toEqual(festivalCapsule(issuer, { now: 5 }));
    expect(validateCapsule(a).ok).toBe(true);
    expect(festivalCapsule(issuer, { name: 'Spring Fair' }).name).toBe('Spring Fair');
  });

  it('has four teams with distinct capabilities and homes', () => {
    expect(capsule.teams.map((t) => t.name)).toEqual(['Medics', 'Access', 'Facilities', 'Supply']);
    const sets = capsule.teams.map((t) => [...t.capabilities].sort().join());
    expect(new Set(sets).size).toBe(4);
    const homes = capsule.teams.map((t) => `${t.home.x},${t.home.y}`);
    expect(new Set(homes).size).toBe(4);
  });

  it('issues the agreed resources to the agreed holders', () => {
    const holders = Object.fromEntries(capsule.resources.map((r) => [r.id, r.tokens.map((t) => t.holderTeam)]));
    expect(holders).toEqual({ 'evac-chair': ['access'], aed: ['medics', 'supply'], cart: ['supply', 'facilities'] });
  });

  it('has 6 to 8 tasks with real dependencies, each doable by some team', () => {
    expect(capsule.tasks.length).toBeGreaterThanOrEqual(6);
    expect(capsule.tasks.length).toBeLessThanOrEqual(8);
    expect(capsule.tasks.filter((t) => t.dependsOn.length > 0).length).toBeGreaterThanOrEqual(3);
    for (const t of capsule.tasks) {
      expect(capsule.teams.some((team) => t.requires.every((c) => team.capabilities.includes(c)))).toBe(true);
    }
  });

  it('reroutes support when the north gate closes', () => {
    const [rule] = capsule.contingencies;
    expect(rule?.when).toEqual({ key: 'gate.north.open', equals: false });
    expect(rule?.then.spawn?.[0]?.id).toBe('west-gate-reroute');
  });
});

describe('scenarioBeats', () => {
  const STEPS = ['connected', 'hq-down', 'split', 'contested', 'ferry', 'restored'];

  it('walks the six steps in order', () => {
    const seen = scenarioBeats.map((b) => b.step).filter((s, i, all) => s !== all[i - 1]);
    expect(seen).toEqual(STEPS);
  });

  it('uses unique ids, known teams and valid specs', () => {
    expect(new Set(scenarioBeats.map((b) => b.id)).size).toBe(scenarioBeats.length);
    const teams = capsule.teams.map((t) => t.id);
    const ids = new Set(capsule.tasks.map((t) => t.id));
    for (const b of scenarioBeats) {
      expect(teams).toContain(b.team);
      expect(b.label.length).toBeGreaterThan(0);
      if (!b.spec) continue;
      expect(validateTaskSpec(b.spec)).toEqual([]);
      expect(ids.has(b.spec.id)).toBe(false);
      ids.add(b.spec.id);
      for (const dep of b.spec.dependsOn) expect(ids.has(dep)).toBe(true);
    }
  });

  it('has no dashes that read badly aloud and no placeholder text', () => {
    const text = [...scenarioBeats.map((b) => `${b.label} ${b.spec?.title ?? ''} ${b.spec?.brief ?? ''}`), ...capsule.tasks.map((t) => `${t.title} ${t.brief}`)].join(' ');
    expect(text).not.toMatch(/—|TODO|lorem/i);
    for (const b of scenarioBeats) if (b.spec) expect(b.spec.title.length).toBeLessThanOrEqual(50);
  });

  it('splits the teams into the agreed groups', () => {
    expect(scenarioSplit).toEqual({ a: ['medics', 'supply'], b: ['access', 'facilities'] });
  });

  it('gives each group work only that group can do after the split', () => {
    const can = (team: string, spec: TaskSpec) => {
      const caps = capsule.teams.find((t) => t.id === team)!.capabilities;
      return spec.requires.every((c) => caps.includes(c));
    };
    const stock = (team: string, resource: string) =>
      capsule.resources.find((r) => r.id === resource)!.tokens.filter((t) => t.holderTeam === team).length;
    const inGroup = (group: string[], spec: TaskSpec) =>
      group.some((team) => can(team, spec) && spec.needs.every((n) => stock(team, n.resource) >= n.count));
    const { a, b } = scenarioSplit;
    expect(inGroup(a, specOf('split-field-aed'))).toBe(true);
    expect(inGroup(b, specOf('split-field-aed'))).toBe(false);
    expect(inGroup(b, specOf('split-hall-ramp'))).toBe(true);
    expect(inGroup(a, specOf('split-hall-ramp'))).toBe(false);
    expect(inGroup(a, specOf('contested-upper-stand'))).toBe(false);
    expect(a.some((team) => can(team, specOf('contested-upper-stand')))).toBe(true);
    expect(inGroup(b, specOf('contested-hall-chair'))).toBe(true);
    const reroute = capsule.contingencies[0]!.then.spawn![0]!;
    expect(inGroup(a, reroute)).toBe(false);
    expect(inGroup(b, reroute)).toBe(true);
  });

  it('leaves exactly one task that both groups could cover', () => {
    const cross = [...capsule.tasks, ...scenarioBeats.flatMap((b) => (b.spec ? [b.spec] : []))].filter((t) => {
      if (t.priority > capsule.fallback.coverMaxPriority) return false;
      const able = capsule.teams.filter((team) => t.requires.every((c) => team.capabilities.includes(c))).map((team) => team.id);
      return able.some((x) => scenarioSplit.a.includes(x)) && able.some((x) => scenarioSplit.b.includes(x));
    });
    expect(cross.map((t) => t.id)).toEqual(['queue-water']);
  });

  it('plays through to one duplicate-effort conflict, no violations, and one chair allocation', () => {
    const w = world();
    const groupA = [w.medics, w.supply];
    const groupB = [w.access, w.facilities];

    // Connected: Access reports, Medics take it.
    create(w.access, specOf('connected-faint'));
    sync(...w.all);
    claim(w.medics, 'faint-main-stage');
    accept(w.medics, 'faint-main-stage');
    sync(...w.all);
    complete(w.medics, 'faint-main-stage', 'Visitor is sitting up.');
    sync(...w.all);

    // Central service gone: peers still sync directly.
    create(w.supply, specOf('hq-down-quiet-tent'));
    sync(...w.all);
    claim(w.access, 'guide-quiet-tent');
    complete(w.access, 'guide-quiet-tent', 'Visitor is settled.');
    sync(...w.all);
    create(w.medics, specOf('hq-down-queue-water'));
    sync(...w.all);
    claim(w.supply, 'queue-water');
    accept(w.supply, 'queue-water');
    sync(...w.all);

    // Split: each group does its own work.
    create(w.supply, specOf('split-field-aed'));
    sync(...groupA);
    claim(w.supply, 'field-aed');
    w.supply.author.emit('right.committed', { tokens: ['aed#2'], taskId: 'field-aed' }, 3_000);
    accept(w.supply, 'field-aed');
    complete(w.supply, 'field-aed', 'AED on the sports field.');
    create(w.facilities, specOf('split-hall-ramp'));
    sync(...groupB);
    claim(w.facilities, 'hall-ramp');
    w.facilities.author.emit('right.committed', { tokens: ['cart#2'], taskId: 'hall-ramp' }, 3_000);
    accept(w.facilities, 'hall-ramp');
    complete(w.facilities, 'hall-ramp', 'Ramp fixed.');
    sync(...groupA);
    sync(...groupB);
    expect(stateOf(w.medics).tasks['hall-ramp']).toBeUndefined();
    expect(stateOf(w.access).tasks['field-aed']).toBeUndefined();

    // Owner unreachable: the far group covers while the owner finishes anyway.
    cover(w.facilities, 'queue-water');
    complete(w.facilities, 'queue-water', 'Facilities brought water.');
    complete(w.supply, 'queue-water', 'Supply brought water.');
    sync(...groupA);
    sync(...groupB);

    // Contested: the group without the chair refuses, the group with it allocates.
    create(w.medics, specOf('contested-upper-stand'));
    sync(...groupA);
    w.medics.author.emit(
      'task.refused',
      { taskId: 'upper-stand-carry', decision: decision(w.medics.id, 'upper-stand-carry', 'REFUSED', { refusal: 'NO_RIGHT', next: ['WAIT_FOR_CONTACT'] }) },
      4_000,
    );
    create(w.access, specOf('contested-hall-chair'));
    sync(...groupB);
    claim(w.access, 'hall-chair');
    w.access.author.emit('right.committed', { tokens: ['evac-chair#1'], taskId: 'hall-chair' }, 4_000);
    accept(w.access, 'hall-chair');
    sync(...groupA);
    sync(...groupB);
    expect(stateOf(w.medics).tasks['upper-stand-carry']?.status).toBe('refused');
    expect(stateOf(w.access).tokens['evac-chair#1']).toMatchObject({ state: 'committed', committedTo: 'hall-chair' });
    expect(stateOf(w.medics).tokens['evac-chair#1']?.state).toBe('held');

    // Ferry: the gate news crosses by hand and unlocks work in the far group.
    const gate = beat('ferry-north-gate').observation!;
    w.supply.author.emit('observation.recorded', { observation: { ...gate, observedAt: 5_000, validForMs: 0, source: w.supply.id } }, 5_000);
    sync(...groupA);
    expect(stateOf(w.access).tasks['west-gate-reroute']).toBeUndefined();
    const carried = w.supply.log.all();
    w.access.log.ingestMany(carried);
    expect(stateOf(w.access).tasks['west-gate-reroute']?.status).toBe('open');
    sync(...groupB);
    claim(w.access, 'west-gate-reroute');
    complete(w.access, 'west-gate-reroute', 'Arrivals are using the west gate.');

    // Restored: one account, one duplicate to show.
    sync(...w.all);
    sync(...w.all);
    const states = w.all.map(stateOf);
    const finalState = states[0]!;
    for (const s of states) expect(s).toEqual(finalState);
    expect(finalState.conflicts).toHaveLength(1);
    expect(finalState.conflicts[0]).toMatchObject({ kind: 'duplicate-effort', severity: 'policy', taskId: 'queue-water' });
    expect(finalState.tasks['queue-water']).toMatchObject({ status: 'completed', owner: w.supply.id, coveredBy: [w.facilities.id] });
    expect(finalState.tasks['west-gate-reroute']?.status).toBe('completed');
    expect(finalState.tasks['upper-stand-carry']?.status).toBe('refused');
    const chair = Object.values(finalState.tokens).filter((t) => t.resource === 'evac-chair');
    expect(chair).toHaveLength(1);
    expect(chair[0]?.committedTo).toBe('hall-chair');
  });
});
