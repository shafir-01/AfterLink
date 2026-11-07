import { describe, expect, it } from 'vitest';
import { generateKeys, verifyEvent } from '@afterlink/protocol';
import type { MissionCapsule } from '@afterlink/protocol';
import { festivalCapsule, provision, validateCapsule, validateTaskSpec, verifyCredential, verifyRoster } from '../src/index.ts';

const issuer = generateKeys();
const fresh = (): MissionCapsule => JSON.parse(JSON.stringify(festivalCapsule(issuer, { now: 1_000 })));

type Loose = MissionCapsule & Record<string, any>;

function errorsOf(mutate: (c: Loose) => void): string[] {
  const c = fresh();
  mutate(c as Loose);
  const result = validateCapsule(c);
  return result.ok ? [] : result.errors;
}

describe('validateCapsule', () => {
  it('accepts the festival capsule, including after a JSON round trip', () => {
    expect(validateCapsule(festivalCapsule(issuer)).ok).toBe(true);
    expect(validateCapsule(fresh()).ok).toBe(true);
  });

  it.each([null, undefined, 3, 'capsule', []])('rejects %j without throwing', (value) => {
    expect(validateCapsule(value).ok).toBe(false);
  });

  it('collects every missing top-level field', () => {
    const result = validateCapsule({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const field of ['v', 'id', 'version', 'name', 'objective', 'objectives', 'teams', 'resources', 'tasks', 'contingencies', 'fallback', 'issuer', 'issuedAt']) {
      expect(result.errors).toContain(`capsule.${field}: missing`);
    }
  });

  const rejected: [string, (c: Loose) => void, RegExp][] = [
    ['wrong version', (c) => { c.v = 2 as 1; }, /capsule\.v/],
    ['empty name', (c) => { c.name = '  '; }, /capsule\.name/],
    ['bad revision', (c) => { c.version = 0; }, /capsule\.version/],
    ['issuer that is not a key', (c) => { c.issuer = 'someone'; }, /capsule\.issuer/],
    ['negative issue time', (c) => { c.issuedAt = -1; }, /capsule\.issuedAt/],
    ['unknown top-level field', (c) => { c.notes = 'hello'; }, /capsule\.notes: unknown field/],
    ['no objectives', (c) => { c.objectives = []; }, /capsule\.objectives/],
    ['non-integer rank', (c) => { c.objectives[0]!.rank = 1.5; }, /rank/],
    ['duplicate objective', (c) => { c.objectives[1]!.id = c.objectives[0]!.id; }, /duplicate objective/],
    ['no teams', (c) => { c.teams = []; }, /capsule\.teams/],
    ['duplicate team', (c) => { c.teams[1]!.id = c.teams[0]!.id; }, /duplicate team/],
    ['team without capabilities', (c) => { c.teams[0]!.capabilities = []; }, /capabilities/],
    ['home off the map', (c) => { c.teams[0]!.home.x = 101; }, /home\.x/],
    ['token owned by an unknown team', (c) => { c.resources[0]!.tokens[0]!.holderTeam = 'ghosts'; }, /unknown team "ghosts"/],
    ['token issued twice in one resource', (c) => { c.resources[1]!.tokens[1]!.id = c.resources[1]!.tokens[0]!.id; }, /duplicate token/],
    ['token issued twice across resources', (c) => { c.resources[2]!.tokens[0]!.id = c.resources[0]!.tokens[0]!.id; }, /duplicate token/],
    ['resource with no tokens', (c) => { c.resources[0]!.tokens = []; }, /tokens/],
    ['duplicate resource', (c) => { c.resources[1]!.id = c.resources[0]!.id; }, /duplicate resource/],
    ['duplicate task', (c) => { c.tasks[1]!.id = c.tasks[0]!.id; }, /duplicate task/],
    ['unknown dependency', (c) => { c.tasks[0]!.dependsOn = ['nothing']; }, /unknown task "nothing"/],
    ['self dependency', (c) => { c.tasks[0]!.dependsOn = [c.tasks[0]!.id]; }, /cannot depend on itself/],
    ['unknown objective', (c) => { c.tasks[0]!.objective = 'glory'; }, /unknown objective "glory"/],
    ['capability no team has', (c) => { c.tasks[0]!.requires = ['flying']; }, /no team has capability "flying"/],
    ['unknown resource', (c) => { c.tasks[0]!.needs = [{ resource: 'drone', count: 1 }]; }, /unknown resource "drone"/],
    ['more tokens than issued', (c) => { c.tasks[0]!.needs = [{ resource: 'evac-chair', count: 2 }]; }, /only 1 issued/],
    ['zero count', (c) => { c.tasks[0]!.needs = [{ resource: 'cart', count: 0 }]; }, /count/],
    ['bad priority', (c) => { (c.tasks[0] as any).priority = 4; }, /priority/],
    ['non-boolean reversible', (c) => { (c.tasks[0] as any).reversible = 'yes'; }, /reversible/],
    ['bad deadline', (c) => { c.tasks[0]!.deadlineMs = -5; }, /deadlineMs/],
    ['unknown task field', (c) => { (c.tasks[0] as any).owner = 'me'; }, /unknown field/],
    ['bad location', (c) => { (c.tasks[0] as any).location = { x: 'a', y: 1 }; }, /location\.x/],
    ['duplicate contingency', (c) => { c.contingencies.push(c.contingencies[0]!); }, /duplicate contingency/],
    ['contingency that blocks nothing readable', (c) => { (c.contingencies[0]!.then as any).blockKinds = [1]; }, /blockKinds/],
    ['contingency spawn reuses a task id', (c) => { c.contingencies[0]!.then.spawn![0]!.id = c.tasks[0]!.id; }, /duplicate task/],
    ['contingency spawn with an unknown objective', (c) => { c.contingencies[0]!.then.spawn![0]!.objective = 'glory'; }, /unknown objective/],
    ['contingency without a note', (c) => { delete (c.contingencies[0]!.then as any).note; }, /then\.note: missing/],
    ['negative cover delay', (c) => { c.fallback.coverAfterMs = -1; }, /coverAfterMs/],
    ['cover priority out of range', (c) => { c.fallback.coverMaxPriority = 4; }, /coverMaxPriority/],
    ['approval kinds that are not a list', (c) => { (c.fallback as any).humanApprovalKinds = 'all'; }, /humanApprovalKinds/],
  ];

  it.each(rejected)('rejects %s', (_name, mutate, pattern) => {
    const errors = errorsOf(mutate);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('lets a rule block a kind that only arrives at runtime', () => {
    expect(errorsOf((c) => { c.contingencies[0]!.then.blockKinds = ['parade']; })).toEqual([]);
  });

  it('names the cycle when dependencies loop', () => {
    const errors = errorsOf((c) => {
      c.tasks[0]!.dependsOn = [c.tasks[2]!.id];
      c.tasks[2]!.dependsOn = [c.tasks[1]!.id];
      c.tasks[1]!.dependsOn = [c.tasks[0]!.id];
    });
    expect(errors.join('\n')).toMatch(/dependency cycle .+ -> .+ -> .+ -> /);
  });

  it('finds a cycle that passes through a contingency task', () => {
    const errors = errorsOf((c) => {
      c.tasks[0]!.dependsOn = ['west-gate-reroute'];
      c.contingencies[0]!.then.spawn![0]!.dependsOn = [c.tasks[0]!.id];
    });
    expect(errors.join('\n')).toMatch(/dependency cycle/);
  });

  it('rejects a key smuggled in through parsed JSON', () => {
    const c = JSON.parse(JSON.stringify(fresh()).replace('{"v":1', '{"__proto__":{"admin":true},"v":1'));
    expect(validateCapsule(c).ok).toBe(false);
  });

  it('reports all problems at once', () => {
    const errors = errorsOf((c) => {
      c.name = '';
      c.tasks[0]!.objective = 'glory';
      c.resources[0]!.tokens[0]!.holderTeam = 'ghosts';
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateTaskSpec', () => {
  it('passes a well-formed task and rejects junk', () => {
    expect(validateTaskSpec(fresh().tasks[0])).toEqual([]);
    expect(validateTaskSpec(null).length).toBe(1);
    expect(validateTaskSpec({ id: 'x' }).length).toBeGreaterThan(5);
  });
});

describe('provision', () => {
  const capsule = festivalCapsule(issuer, { now: 1_000 });
  const { genesis, bundles } = provision(capsule, issuer, 'room-1');
  const teams = capsule.teams.map((t) => t.id);

  it('signs a genesis event any peer can verify', () => {
    expect(verifyEvent(genesis)).toEqual({ ok: true });
    expect(genesis.actor).toBe(issuer.publicKey);
    expect(genesis.mission).toBe(capsule.id);
    expect(genesis.body.capsule).toEqual(JSON.parse(JSON.stringify(capsule)));
  });

  it('gives each team its own device key, credential and the full roster', () => {
    expect(Object.keys(bundles).sort()).toEqual([...teams].sort());
    const keys = new Set(teams.map((t) => bundles[t]!.actor.publicKey));
    expect(keys.size).toBe(teams.length);
    for (const team of teams) {
      const b = bundles[team]!;
      expect(b.room).toBe('room-1');
      expect(b.team).toBe(team);
      expect(b.genesis).toBe(genesis);
      expect(b.credential.actor).toBe(b.actor.publicKey);
      expect(verifyCredential(b.credential, issuer.publicKey)).toBe(true);
      expect(b.roster.map((r) => r.team).sort()).toEqual([...teams].sort());
    }
  });

  it('keeps secret keys out of the roster', () => {
    const roster = JSON.stringify(bundles.medics!.roster);
    for (const team of teams) expect(roster).not.toContain(bundles[team]!.actor.secretKey);
  });

  it('names exactly one custodian per team', () => {
    const roster = bundles.medics!.roster;
    for (const team of teams) expect(roster.filter((r) => r.team === team && r.custodian)).toHaveLength(1);
    expect(verifyRoster(roster, capsule)).toEqual({ ok: true });
  });

  it('refuses an invalid capsule and a key that is not the issuer', () => {
    expect(() => provision({ ...capsule, tasks: [{ ...capsule.tasks[0]!, objective: 'glory' }] }, issuer, 'r')).toThrow(/invalid capsule/);
    expect(() => provision(capsule, generateKeys(), 'r')).toThrow(/not the capsule issuer/);
  });
});

describe('verifyCredential', () => {
  const capsule = festivalCapsule(issuer, { now: 1_000 });
  const { bundles } = provision(capsule, issuer, 'room');
  const credential = bundles.access!.credential;

  it('fails when any bound field changes', () => {
    expect(verifyCredential({ ...credential, team: 'medics' }, issuer.publicKey)).toBe(false);
    expect(verifyCredential({ ...credential, custodian: false }, issuer.publicKey)).toBe(false);
    expect(verifyCredential({ ...credential, mission: 'other' }, issuer.publicKey)).toBe(false);
    expect(verifyCredential({ ...credential, actor: bundles.medics!.actor.publicKey }, issuer.publicKey)).toBe(false);
  });

  it('fails for another issuer and for junk without throwing', () => {
    expect(verifyCredential(credential, generateKeys().publicKey)).toBe(false);
    expect(verifyCredential({ ...credential, sig: 'not a signature' }, issuer.publicKey)).toBe(false);
    expect(verifyCredential(credential, 'not a key')).toBe(false);
  });
});

describe('verifyRoster', () => {
  const capsule = festivalCapsule(issuer, { now: 1_000 });
  const { bundles } = provision(capsule, issuer, 'room');
  const roster = bundles.medics!.roster;

  it('rejects a second custodian, a missing custodian and a tampered entry', () => {
    const other = provision(capsule, issuer, 'room').bundles.medics!;
    const extra = { actor: other.actor.publicKey, team: 'medics', name: 'Medics 2', custodian: true, credential: other.credential };
    expect(verifyRoster([...roster, extra], capsule).ok).toBe(false);
    expect(verifyRoster(roster.slice(1), capsule).ok).toBe(false);
    expect(verifyRoster(roster.map((r, i) => (i === 0 ? { ...r, team: 'supply' } : r)), capsule).ok).toBe(false);
  });
});
