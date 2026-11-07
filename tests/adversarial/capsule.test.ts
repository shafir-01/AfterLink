import { describe, expect, it } from 'vitest';
import { festivalCapsule, provision, validateCapsule, verifyCredential } from '@afterlink/mission';
import { generateKeys } from '@afterlink/protocol';
import type { MissionCapsule } from '@afterlink/protocol';
import { assemble } from '../../apps/relay/src/ai/compile.ts';

const base = (): MissionCapsule => structuredClone(festivalCapsule(generateKeys(), { now: 1 }));
type Mutation = [string, (c: MissionCapsule & Record<string, unknown>) => void];

const REJECTED: Mutation[] = [
  ['one token listed under two teams', (c) => c.resources[1]!.tokens.push({ id: c.resources[1]!.tokens[0]!.id, holderTeam: c.teams[0]!.id })],
  ['one token listed under two resources', (c) => c.resources[0]!.tokens.push({ id: c.resources[1]!.tokens[0]!.id, holderTeam: c.teams[0]!.id })],
  ['token held by an unknown team', (c) => (c.resources[0]!.tokens[0]!.holderTeam = 'ghosts')],
  ['duplicate team', (c) => c.teams.push(c.teams[0]!)],
  ['duplicate resource', (c) => c.resources.push(c.resources[0]!)],
  ['dependency cycle', (c) => {
    c.tasks[0]!.dependsOn = [c.tasks[1]!.id];
    c.tasks[1]!.dependsOn = [c.tasks[0]!.id];
  }],
  ['task depends on itself', (c) => (c.tasks[0]!.dependsOn = [c.tasks[0]!.id])],
  ['task needs more than exists', (c) => (c.tasks[0]!.needs = [{ resource: c.resources[0]!.id, count: 99 }])],
  ['task needs an unknown resource', (c) => (c.tasks[0]!.needs = [{ resource: 'unicorn', count: 1 }])],
  ['task requires a skill no team has', (c) => (c.tasks[0]!.requires = ['teleport'])],
  ['fractional count', (c) => (c.tasks[0]!.needs = [{ resource: c.resources[0]!.id, count: 0.5 }])],
  ['negative cover delay', (c) => (c.fallback.coverAfterMs = -1)],
  ['cover delay of zero: no wait before taking over', (c) => (c.fallback.coverAfterMs = 0)],
  ['non-numeric cover delay', (c) => ((c.fallback as unknown as Record<string, unknown>).coverAfterMs = 'soon')],
  ['priority out of range', (c) => ((c.tasks[0] as unknown as Record<string, unknown>).priority = 0)],
  ['location off the map', (c) => (c.tasks[0]!.location = { x: 1e9, y: -5 })],
  ['extra field', (c) => (c.backdoor = true)],
  ['wrong version', (c) => ((c as unknown as Record<string, unknown>).v = 2)],
  ['issuer that is not a key', (c) => (c.issuer = 'not-a-key')],
  ['empty team list', (c) => (c.teams = [])],
];

describe('malformed capsule from the AI path', () => {
  it('the unmodified capsule is accepted', () => {
    expect(validateCapsule(base()).ok).toBe(true);
  });

  for (const [name, mutate] of REJECTED) {
    it(`rejects: ${name}`, () => {
      const c = base() as MissionCapsule & Record<string, unknown>;
      mutate(c);
      expect(validateCapsule(c).ok).toBe(false);
    });
  }

  it('never throws on arbitrary input', () => {
    for (const x of [null, 1, 'x', [], {}, { teams: 5 }, { resources: [null] }, { tasks: [null] }, { contingencies: [{ then: 5 }] }, { fallback: null }]) {
      expect(() => validateCapsule(x)).not.toThrow();
    }
  });

  it('refuses to sign an invalid capsule, or one naming another issuer', () => {
    const issuer = generateKeys();
    const good = festivalCapsule(issuer, { now: 1 });
    expect(() => provision({ ...good, teams: [] }, issuer, 'r')).toThrow();
    expect(() => provision(good, generateKeys(), 'r')).toThrow();
  });

  it('no bundle carries the issuer secret, and every credential chains to the issuer', () => {
    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer, { now: 1 });
    const { bundles } = provision(capsule, issuer, 'r');
    for (const b of Object.values(bundles)) {
      expect(JSON.stringify(b)).not.toContain(issuer.secretKey);
      expect(verifyCredential(b.credential, issuer.publicKey)).toBe(true);
      for (const other of Object.values(bundles)) {
        if (other.actor.publicKey !== b.actor.publicKey) expect(JSON.stringify(b)).not.toContain(other.actor.secretKey);
      }
    }
  });
});

const draft = (over: Record<string, unknown> = {}) => {
  const c = festivalCapsule(generateKeys(), { now: 1 });
  return {
    name: c.name,
    objective: c.objective,
    objectives: c.objectives,
    teams: c.teams,
    resources: [{ id: 'aed', name: 'AED', basis: 'two AEDs', tokens: [{ id: 'aed#1', holderTeam: 'medics' }, { id: 'aed#2', holderTeam: 'medics' }] }],
    tasks: [],
    contingencies: [],
    fallback: c.fallback,
    ...over,
  } as Parameters<typeof assemble>[0];
};

describe('rights invented by the model', () => {
  const source = 'We have two AEDs, held by the medics, at a small event.';

  it('drops a resource whose quote is not in the organiser text', () => {
    const d = draft({ resources: [{ id: 'cart', name: 'Cart', basis: 'four golf carts', tokens: [{ id: 'cart#1', holderTeam: 'supply' }] }] });
    const { rights, rejectedRights } = assemble(d, source, generateKeys().publicKey);
    expect(rights).toEqual([]);
    expect(rejectedRights).toEqual(['cart']);
  });

  it('a one-letter quote is not evidence for a resource', () => {
    const d = draft({ resources: [{ id: 'helicopter', name: 'Helicopter', basis: 'a', tokens: [{ id: 'helicopter#1', holderTeam: 'medics' }] }] });
    expect(assemble(d, source, generateKeys().publicKey).rights).toEqual([]);
  });

  it('a quote about two items cannot mint ten tokens', () => {
    const tokens = Array.from({ length: 10 }, (_, i) => ({ id: `aed#${i}`, holderTeam: 'medics' }));
    const d = draft({ resources: [{ id: 'aed', name: 'AED', basis: 'two AEDs', tokens }] });
    const { rights } = assemble(d, source, generateKeys().publicKey);
    expect(rights.find((r) => r.resource === 'aed')?.tokens ?? 0).toBeLessThanOrEqual(2);
  });

  it('dropping a resource must not turn a task that needed it into a task that needs nothing', () => {
    const spec = {
      id: 'lift', kind: 'lift', title: 'Lift', brief: 'Lift', objective: 'safety', priority: 1, location: { x: 1, y: 1 }, locationName: 'x',
      requires: [], needs: [{ resource: 'crane', count: 1 }], dependsOn: [], reversible: false,
    };
    const d = draft({ resources: [{ id: 'crane', name: 'Crane', basis: 'a crane we do not have', tokens: [{ id: 'crane#1', holderTeam: 'supply' }] }], tasks: [spec] });
    const { capsule } = assemble(d, source, generateKeys().publicKey) as { capsule: MissionCapsule };
    expect(capsule.tasks.filter((t) => t.id === 'lift' && t.needs.length === 0)).toEqual([]);
  });
});
