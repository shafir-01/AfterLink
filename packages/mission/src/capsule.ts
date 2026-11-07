import { canonicalize, createEvent, generateKeys, signBytes, verifyBytes } from '@afterlink/protocol';
import type {
  ActorId,
  Credential,
  EventEnvelope,
  MissionCapsule,
  ProvisionBundle,
  TaskSpec,
  TeamId,
} from '@afterlink/protocol';

type Roster = ProvisionBundle['roster'];
type Rec = Record<string, unknown>;

const ACTOR_ID = /^[A-Za-z0-9_-]{43}$/;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

function isJson(v: unknown): boolean {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJson);
  return isRec(v) && Object.values(v).every(isJson);
}

/** Errors for missing required fields and for any field the contract does not define. */
function checkKeys(o: Rec, path: string, required: string[], optional: string[], errors: string[]): void {
  for (const k of required) if (o[k] === undefined) errors.push(`${path}.${k}: missing`);
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) errors.push(`${path}.${k}: unknown field`);
  }
}

function checkText(v: unknown, path: string, errors: string[]): void {
  if (v !== undefined && !isText(v)) errors.push(`${path}: must be non-empty text`);
}

function checkPoint(v: unknown, path: string, errors: string[]): void {
  if (v === undefined) return;
  if (!isRec(v)) {
    errors.push(`${path}: must be a point`);
    return;
  }
  checkKeys(v, path, ['x', 'y'], [], errors);
  for (const axis of ['x', 'y']) {
    const n = v[axis];
    if (n !== undefined && (!isNum(n) || n < 0 || n > 100)) errors.push(`${path}.${axis}: must be between 0 and 100`);
  }
}

function checkTextList(v: unknown, path: string, errors: string[], unique = true): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be a list`);
    return [];
  }
  const seen = new Set<string>();
  v.forEach((item, i) => {
    if (!isText(item)) errors.push(`${path}[${i}]: must be non-empty text`);
    else if (unique && seen.has(item)) errors.push(`${path}[${i}]: duplicate "${item}"`);
    else seen.add(item);
  });
  return [...seen];
}

/** Shape of one task. Used for capsule tasks and for every task created at runtime. */
export function validateTaskSpec(spec: unknown, path = 'task'): string[] {
  const errors: string[] = [];
  if (!isRec(spec)) return [`${path}: must be an object`];
  checkKeys(
    spec,
    path,
    ['id', 'kind', 'title', 'brief', 'objective', 'priority', 'location', 'locationName', 'requires', 'needs', 'dependsOn', 'reversible'],
    ['reliesOn', 'deadlineMs'],
    errors,
  );
  for (const k of ['id', 'kind', 'title', 'brief', 'objective', 'locationName']) checkText(spec[k], `${path}.${k}`, errors);
  if (spec.priority !== undefined && spec.priority !== 1 && spec.priority !== 2 && spec.priority !== 3) {
    errors.push(`${path}.priority: must be 1, 2 or 3`);
  }
  checkPoint(spec.location, `${path}.location`, errors);
  checkTextList(spec.requires, `${path}.requires`, errors);
  checkTextList(spec.dependsOn, `${path}.dependsOn`, errors);
  if (spec.reversible !== undefined && typeof spec.reversible !== 'boolean') errors.push(`${path}.reversible: must be true or false`);
  if (spec.reliesOn !== undefined) checkTextList(spec.reliesOn, `${path}.reliesOn`, errors);
  if (spec.deadlineMs !== undefined && !isPosInt(spec.deadlineMs)) errors.push(`${path}.deadlineMs: must be a positive whole number`);
  if (spec.needs !== undefined) {
    if (!Array.isArray(spec.needs)) errors.push(`${path}.needs: must be a list`);
    else {
      spec.needs.forEach((need: unknown, i) => {
        const p = `${path}.needs[${i}]`;
        if (!isRec(need)) {
          errors.push(`${p}: must be an object`);
          return;
        }
        checkKeys(need, p, ['resource', 'count'], [], errors);
        checkText(need.resource, `${p}.resource`, errors);
        if (need.count !== undefined && !isPosInt(need.count)) errors.push(`${p}.count: must be a positive whole number`);
      });
    }
  }
  return errors;
}

function checkTaskRefs(
  task: TaskSpec,
  path: string,
  allTaskIds: Set<string>,
  objectives: Set<string>,
  capabilities: Set<string>,
  stock: Map<string, number>,
  errors: string[],
): void {
  if (!objectives.has(task.objective)) errors.push(`${path}.objective: unknown objective "${task.objective}"`);
  task.requires.forEach((cap, i) => {
    if (!capabilities.has(cap)) errors.push(`${path}.requires[${i}]: no team has capability "${cap}"`);
  });
  task.dependsOn.forEach((dep, i) => {
    if (dep === task.id) errors.push(`${path}.dependsOn[${i}]: a task cannot depend on itself`);
    else if (!allTaskIds.has(dep)) errors.push(`${path}.dependsOn[${i}]: unknown task "${dep}"`);
  });
  task.needs.forEach((need, i) => {
    const total = stock.get(need.resource);
    if (total === undefined) errors.push(`${path}.needs[${i}].resource: unknown resource "${need.resource}"`);
    else if (need.count > total) errors.push(`${path}.needs[${i}].count: needs ${need.count} but only ${total} issued`);
  });
}

function findCycles(tasks: TaskSpec[]): string[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const cycles: string[][] = [];
  const visit = (id: string, trail: string[]): void => {
    const at = trail.indexOf(id);
    if (at >= 0) {
      cycles.push([...trail.slice(at), id]);
      return;
    }
    if (done.has(id)) return;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep !== id) visit(dep, [...trail, id]);
    }
    done.add(id);
  };
  for (const t of tasks) visit(t.id, []);
  return cycles;
}

function checkUnique(ids: unknown[], path: string, label: string, errors: string[]): void {
  const seen = new Set<unknown>();
  ids.forEach((id, i) => {
    if (id === undefined) return;
    if (seen.has(id)) errors.push(`${path}[${i}]: duplicate ${label} "${String(id)}"`);
    seen.add(id);
  });
}

/** The gate every capsule passes before it can be signed, whoever or whatever wrote it. */
export function validateCapsule(c: unknown): { ok: true; capsule: MissionCapsule } | { ok: false; errors: string[] } {
  if (!isRec(c)) return { ok: false, errors: ['capsule: must be an object'] };
  const errors: string[] = [];
  checkKeys(
    c,
    'capsule',
    ['v', 'id', 'version', 'name', 'objective', 'objectives', 'teams', 'resources', 'tasks', 'contingencies', 'fallback', 'issuer', 'issuedAt'],
    [],
    errors,
  );
  if (c.v !== undefined && c.v !== 1) errors.push('capsule.v: must be 1');
  checkText(c.id, 'capsule.id', errors);
  checkText(c.name, 'capsule.name', errors);
  checkText(c.objective, 'capsule.objective', errors);
  if (c.version !== undefined && !isPosInt(c.version)) errors.push('capsule.version: must be a positive whole number');
  if (c.issuer !== undefined && !(typeof c.issuer === 'string' && ACTOR_ID.test(c.issuer))) {
    errors.push('capsule.issuer: must be a base64url public key');
  }
  if (c.issuedAt !== undefined && !(isNum(c.issuedAt) && c.issuedAt >= 0)) errors.push('capsule.issuedAt: must be a timestamp');

  const list = (field: string): Rec[] => {
    const v = c[field];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      errors.push(`capsule.${field}: must be a list`);
      return [];
    }
    return v.filter((item, i) => {
      if (isRec(item)) return true;
      errors.push(`capsule.${field}[${i}]: must be an object`);
      return false;
    });
  };

  const objectives = list('objectives');
  if (Array.isArray(c.objectives) && c.objectives.length === 0) errors.push('capsule.objectives: at least one is required');
  objectives.forEach((o, i) => {
    const p = `capsule.objectives[${i}]`;
    checkKeys(o, p, ['id', 'title', 'rank'], [], errors);
    checkText(o.id, `${p}.id`, errors);
    checkText(o.title, `${p}.title`, errors);
    if (o.rank !== undefined && !Number.isInteger(o.rank)) errors.push(`${p}.rank: must be a whole number`);
  });
  checkUnique(objectives.map((o) => o.id), 'capsule.objectives', 'objective', errors);

  const teams = list('teams');
  if (Array.isArray(c.teams) && c.teams.length === 0) errors.push('capsule.teams: at least one is required');
  const capabilities = new Set<string>();
  teams.forEach((t, i) => {
    const p = `capsule.teams[${i}]`;
    checkKeys(t, p, ['id', 'name', 'capabilities', 'home'], [], errors);
    checkText(t.id, `${p}.id`, errors);
    checkText(t.name, `${p}.name`, errors);
    checkPoint(t.home, `${p}.home`, errors);
    const caps = checkTextList(t.capabilities, `${p}.capabilities`, errors);
    if (Array.isArray(t.capabilities) && t.capabilities.length === 0) errors.push(`${p}.capabilities: at least one is required`);
    caps.forEach((cap) => capabilities.add(cap));
  });
  checkUnique(teams.map((t) => t.id), 'capsule.teams', 'team', errors);
  const teamIds = new Set(teams.map((t) => t.id));

  const resources = list('resources');
  const stock = new Map<string, number>();
  const tokenIds: unknown[] = [];
  resources.forEach((r, i) => {
    const p = `capsule.resources[${i}]`;
    checkKeys(r, p, ['id', 'name', 'tokens'], [], errors);
    checkText(r.id, `${p}.id`, errors);
    checkText(r.name, `${p}.name`, errors);
    if (r.tokens === undefined) return;
    if (!Array.isArray(r.tokens) || r.tokens.length === 0) {
      errors.push(`${p}.tokens: at least one is required`);
      return;
    }
    r.tokens.forEach((tok: unknown, j) => {
      const q = `${p}.tokens[${j}]`;
      if (!isRec(tok)) {
        errors.push(`${q}: must be an object`);
        return;
      }
      checkKeys(tok, q, ['id', 'holderTeam'], [], errors);
      checkText(tok.id, `${q}.id`, errors);
      if (tok.holderTeam !== undefined && !teamIds.has(tok.holderTeam)) errors.push(`${q}.holderTeam: unknown team "${String(tok.holderTeam)}"`);
      tokenIds.push(tok.id);
    });
    if (typeof r.id === 'string') stock.set(r.id, r.tokens.length);
  });
  checkUnique(resources.map((r) => r.id), 'capsule.resources', 'resource', errors);
  checkUnique(tokenIds, 'capsule.resources tokens', 'token', errors);

  const rawTasks = c.tasks === undefined ? [] : Array.isArray(c.tasks) ? c.tasks : (errors.push('capsule.tasks: must be a list'), []);
  const taskErrors = rawTasks.map((t, i) => validateTaskSpec(t, `capsule.tasks[${i}]`));
  taskErrors.forEach((e) => errors.push(...e));

  const contingencies = list('contingencies');
  const spawned: { path: string; spec: unknown; errors: string[] }[] = [];
  contingencies.forEach((rule, i) => {
    const p = `capsule.contingencies[${i}]`;
    checkKeys(rule, p, ['id', 'when', 'then'], [], errors);
    checkText(rule.id, `${p}.id`, errors);
    if (rule.when !== undefined) {
      if (!isRec(rule.when)) errors.push(`${p}.when: must be an object`);
      else {
        checkKeys(rule.when, `${p}.when`, ['key', 'equals'], [], errors);
        checkText(rule.when.key, `${p}.when.key`, errors);
        if (rule.when.equals !== undefined && !isJson(rule.when.equals)) errors.push(`${p}.when.equals: must be plain data`);
      }
    }
    if (rule.then !== undefined) {
      if (!isRec(rule.then)) errors.push(`${p}.then: must be an object`);
      else {
        checkKeys(rule.then, `${p}.then`, ['note'], ['blockKinds', 'spawn'], errors);
        checkText(rule.then.note, `${p}.then.note`, errors);
        if (rule.then.blockKinds !== undefined) checkTextList(rule.then.blockKinds, `${p}.then.blockKinds`, errors);
        if (rule.then.spawn !== undefined) {
          if (!Array.isArray(rule.then.spawn)) errors.push(`${p}.then.spawn: must be a list`);
          else {
            rule.then.spawn.forEach((spec: unknown, j) => {
              const path = `${p}.then.spawn[${j}]`;
              const shape = validateTaskSpec(spec, path);
              errors.push(...shape);
              spawned.push({ path, spec, errors: shape });
            });
          }
        }
      }
    }
  });
  checkUnique(contingencies.map((r) => r.id), 'capsule.contingencies', 'contingency', errors);

  if (c.fallback !== undefined) {
    if (!isRec(c.fallback)) errors.push('capsule.fallback: must be an object');
    else {
      const f = c.fallback;
      checkKeys(f, 'capsule.fallback', ['coverAfterMs', 'coverMaxPriority', 'humanApprovalKinds'], [], errors);
      if (f.coverAfterMs !== undefined && !(isNum(f.coverAfterMs) && f.coverAfterMs >= 0)) errors.push('capsule.fallback.coverAfterMs: must not be negative');
      if (f.coverMaxPriority !== undefined && ![0, 1, 2, 3].includes(f.coverMaxPriority as number)) {
        errors.push('capsule.fallback.coverMaxPriority: must be 0, 1, 2 or 3');
      }
      checkTextList(f.humanApprovalKinds, 'capsule.fallback.humanApprovalKinds', errors);
    }
  }

  const wellFormed = rawTasks.filter((_, i) => taskErrors[i]?.length === 0) as TaskSpec[];
  const allTasks = [...wellFormed, ...spawned.filter((s) => s.errors.length === 0).map((s) => s.spec as TaskSpec)];
  const allTaskIds = new Set(allTasks.map((t) => t.id));
  const objectiveIds = new Set(objectives.map((o) => o.id as string));

  checkUnique(rawTasks.map((t: unknown) => (isRec(t) ? t.id : undefined)), 'capsule.tasks', 'task', errors);
  const capsuleTaskIds = new Set(rawTasks.map((t: unknown) => (isRec(t) ? t.id : undefined)));
  const seenSpawn = new Set<unknown>();
  for (const s of spawned) {
    const id = isRec(s.spec) ? s.spec.id : undefined;
    if (id === undefined) continue;
    if (capsuleTaskIds.has(id) || seenSpawn.has(id)) errors.push(`${s.path}.id: duplicate task "${String(id)}"`);
    seenSpawn.add(id);
  }

  rawTasks.forEach((t, i) => {
    if (taskErrors[i]?.length === 0) checkTaskRefs(t as TaskSpec, `capsule.tasks[${i}]`, allTaskIds, objectiveIds, capabilities, stock, errors);
  });
  for (const s of spawned) {
    if (s.errors.length === 0) checkTaskRefs(s.spec as TaskSpec, s.path, allTaskIds, objectiveIds, capabilities, stock, errors);
  }
  for (const cycle of findCycles(allTasks)) errors.push(`capsule.tasks: dependency cycle ${cycle.join(' -> ')}`);

  return errors.length > 0 ? { ok: false, errors } : { ok: true, capsule: c as unknown as MissionCapsule };
}

function credentialBytes(c: Omit<Credential, 'sig'>): Uint8Array {
  return new TextEncoder().encode(
    canonicalize({ purpose: 'afterlink-credential', mission: c.mission, actor: c.actor, team: c.team, custodian: c.custodian }),
  );
}

export function signCredential(c: Omit<Credential, 'sig'>, issuer: { secretKey: string }): Credential {
  return { mission: c.mission, actor: c.actor, team: c.team, custodian: c.custodian, sig: signBytes(issuer.secretKey, credentialBytes(c)) };
}

export function verifyCredential(c: Credential, issuer: ActorId): boolean {
  try {
    return verifyBytes(issuer, credentialBytes(c), c.sig);
  } catch {
    return false;
  }
}

/** The single device allowed to act on each team's tokens. */
export function custodiansOf(roster: Roster): Record<TeamId, ActorId> {
  const custodians: Record<TeamId, ActorId> = {};
  for (const r of roster) if (r.custodian && custodians[r.team] === undefined) custodians[r.team] = r.actor;
  return custodians;
}

/** Offline check of a whole roster: every credential is genuine and each team has exactly one custodian. */
export function verifyRoster(roster: Roster, capsule: MissionCapsule): { ok: true } | { ok: false; reason: string } {
  const actors = new Set<ActorId>();
  const custodianCount = new Map<TeamId, number>();
  const teams = new Set(capsule.teams.map((t) => t.id));
  for (const r of roster) {
    if (actors.has(r.actor)) return { ok: false, reason: `actor ${r.actor} is listed twice` };
    actors.add(r.actor);
    if (!teams.has(r.team)) return { ok: false, reason: `unknown team ${r.team}` };
    const c = r.credential;
    if (c.actor !== r.actor || c.team !== r.team || c.custodian !== r.custodian || c.mission !== capsule.id) {
      return { ok: false, reason: `credential for ${r.name} does not match the roster` };
    }
    if (!verifyCredential(c, capsule.issuer)) return { ok: false, reason: `credential for ${r.name} is not signed by the issuer` };
    if (r.custodian) custodianCount.set(r.team, (custodianCount.get(r.team) ?? 0) + 1);
  }
  for (const t of capsule.teams) {
    const n = custodianCount.get(t.id) ?? 0;
    if (n !== 1) return { ok: false, reason: `team ${t.id} has ${n} custodians` };
  }
  return { ok: true };
}

export function provision(
  capsule: MissionCapsule,
  issuer: { publicKey: ActorId; secretKey: string },
  room: string,
): { genesis: EventEnvelope<'mission.issued'>; bundles: Record<TeamId, ProvisionBundle> } {
  const checked = validateCapsule(capsule);
  if (!checked.ok) throw new Error(`Refusing to sign an invalid capsule: ${checked.errors.join('; ')}`);
  if (issuer.publicKey !== capsule.issuer) throw new Error('Refusing to sign: this key is not the capsule issuer');

  const genesis = createEvent({
    keys: issuer,
    mission: capsule.id,
    seq: 1,
    prev: null,
    parents: [],
    lamport: 1,
    wall: capsule.issuedAt,
    type: 'mission.issued',
    body: { capsule },
  });

  const devices = capsule.teams.map((team) => {
    const actor = generateKeys();
    const credential = signCredential({ mission: capsule.id, actor: actor.publicKey, team: team.id, custodian: true }, issuer);
    return { actor, team, credential };
  });
  const roster: Roster = devices.map(({ actor, team, credential }) => ({
    actor: actor.publicKey,
    team: team.id,
    name: team.name,
    custodian: true,
    credential,
  }));

  const bundles: Record<TeamId, ProvisionBundle> = {};
  for (const { actor, team, credential } of devices) {
    bundles[team.id] = { v: 1, room, genesis, actor, team: team.id, name: team.name, credential, roster };
  }
  return { genesis, bundles };
}
