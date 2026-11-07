import { conservation, deriveTokens, pendingTransfers } from '@afterlink/authority';
import { provision, reduce } from '@afterlink/mission';
import { EventLog, createEvent, generateKeys, verifyEvent } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventId, MissionCapsule, MissionState, ProvisionBundle, TokenId } from '@afterlink/protocol';
import { classify } from '@afterlink/reconcile';

export interface WorldConfig {
  actors: number;
  tokens: number;
  /** Most events any run may sign. Bounds the search. */
  budget: number;
  /** Times actor 0 may lose its newest event and carry on, as a restored device would. */
  rollbacks?: number;
  /** Adds explicit network groups, so a message crosses only inside a group. */
  partitions?: boolean;
  /** Breaks the honest actor on purpose, to show the oracles can fail. */
  mutant?: 'refund-on-timeout' | 'spend-without-checking';
}

export interface Keys {
  publicKey: ActorId;
  secretKey: string;
}

export interface World {
  capsule: MissionCapsule;
  genesis: AnyEvent;
  keys: Keys[];
  roster: ProvisionBundle['roster'];
  custodians: Record<string, ActorId>;
  tokenIds: TokenId[];
}

const TASKS = ['job-a', 'job-b'];

export function buildWorld(actors: number, tokens: number, id = 'explorer-mission'): World {
  const issuer = generateKeys();
  const teams = Array.from({ length: actors }, (_, i) => ({ id: `team${i}`, name: `Team ${i}`, capabilities: ['work'], home: { x: 0, y: 0 } }));
  const tokenIds = Array.from({ length: tokens }, (_, i) => `kit#${i}`);
  const capsule: MissionCapsule = {
    v: 1,
    id,
    version: 1,
    name: 'Explorer',
    objective: 'Move rights',
    objectives: [{ id: 'o', title: 'Objective', rank: 1 }],
    teams,
    resources: [{ id: 'kit', name: 'Kit', tokens: tokenIds.map((t, i) => ({ id: t, holderTeam: `team${i % actors}` })) }],
    tasks: TASKS.map((id) => ({
      id,
      kind: 'work',
      title: id,
      brief: 'Do the job',
      objective: 'o',
      priority: 1 as const,
      location: { x: 1, y: 1 },
      locationName: 'Here',
      requires: [],
      needs: [],
      dependsOn: [],
      reversible: true,
    })),
    contingencies: [],
    fallback: { coverAfterMs: 1000, coverMaxPriority: 1, humanApprovalKinds: [] },
    issuer: issuer.publicKey,
    issuedAt: 1,
  };
  const { genesis, bundles } = provision(capsule, issuer, 'explorer-room');
  const ordered = teams.map((t) => bundles[t.id]!);
  const roster = ordered[0]!.roster;
  const custodians: Record<string, ActorId> = {};
  for (const r of roster) if (r.custodian) custodians[r.team] = r.actor;
  return { capsule, genesis: genesis as AnyEvent, keys: ordered.map((b) => b.actor), roster, custodians, tokenIds };
}

function setPartitions(n: number): number[][][] {
  const out: number[][][] = [];
  const grow = (i: number, groups: number[][]) => {
    if (i === n) {
      out.push(groups.map((g) => [...g]));
      return;
    }
    for (const g of groups) {
      g.push(i);
      grow(i + 1, groups);
      g.pop();
    }
    groups.push([i]);
    grow(i + 1, groups);
    groups.pop();
  };
  grow(0, []);
  return out;
}

interface View {
  /** Tokens this replica sees as held by each actor index. */
  held: Map<number, TokenId[]>;
  pending: Map<number, { transfer: string; tokens: TokenId[] }[]>;
}

export interface Finding {
  invariant: string;
  detail: string;
  trace: string[];
}

export interface Report {
  states: number;
  transitions: number;
  eventSets: number;
  signedEvents: number;
  terminalUnions: number;
  forkedUnions: number;
  doubleCommitUnions: number;
  doubleCommitConservationOk: number;
  findings: Finding[];
  truncated: boolean;
}

interface Node {
  sets: number[];
  spent: number;
  group: number;
  rollbacks: number;
}

/**
 * Walks every interleaving of the rights protocol inside the bound, using the real event, ledger,
 * reducer and classifier code. Replicas are event sets, so delivering an event twice cannot change
 * a state: the duplicate-delivery claim is checked separately against a real EventLog for every
 * distinct set reached. Without explicit groups any message may be delayed forever, which is a
 * superset of every partition schedule, so safety shown there holds for all of them.
 */
export class Explorer {
  readonly world: World;
  private readonly cfg: Required<WorldConfig>;
  private readonly events: AnyEvent[] = [];
  private readonly internKey = new Map<string, number>();
  private readonly deps: number[][] = [];
  private readonly setIds = new Map<string, number>();
  private readonly sets: number[][] = [];
  private readonly views = new Map<number, View>();
  private readonly checked = new Set<number>();
  private readonly unionChecked = new Set<number>();
  private readonly idIndex = new Map<EventId, number>();
  private readonly groups: number[][][];
  private readonly groupOf: Map<number, number>[];
  private readonly findings: Finding[] = [];
  private readonly maxFindings = 5;
  private readonly keyIndex = new Map<ActorId, number>();
  private terminalUnions = 0;
  private forkedUnions = 0;
  private doubleCommitUnions = 0;
  private doubleCommitConservationOk = 0;

  constructor(cfg: WorldConfig) {
    this.cfg = { rollbacks: 0, partitions: false, mutant: undefined as never, ...cfg };
    this.world = buildWorld(cfg.actors, cfg.tokens);
    this.world.keys.forEach((k, i) => this.keyIndex.set(k.publicKey, i));
    this.groups = this.cfg.partitions ? setPartitions(cfg.actors) : [[Array.from({ length: cfg.actors }, (_, i) => i)]];
    this.groupOf = this.groups.map((g) => {
      const m = new Map<number, number>();
      g.forEach((members, gi) => members.forEach((a) => m.set(a, gi)));
      return m;
    });
  }

  private intern(e: AnyEvent): number {
    const known = this.idIndex.get(e.id);
    if (known !== undefined) return known;
    const idx = this.events.length;
    this.events.push(e);
    this.idIndex.set(e.id, idx);
    this.deps.push([e.prev, ...e.parents].filter((x): x is string => x !== null).map((id) => this.idIndex.get(id)!));
    return idx;
  }

  private setId(members: number[]): number {
    const sorted = [...members].sort((a, b) => a - b);
    const key = sorted.join(',');
    let id = this.setIds.get(key);
    if (id === undefined) {
      id = this.sets.length;
      this.sets.push(sorted);
      this.setIds.set(key, id);
    }
    return id;
  }

  private eventsOf(set: number): AnyEvent[] {
    return this.sets[set]!.map((i) => this.events[i]!);
  }

  private view(set: number): View {
    let v = this.views.get(set);
    if (v) return v;
    const { tokens } = deriveTokens(this.world.capsule, this.eventsOf(set), this.world.custodians);
    const held = new Map<number, TokenId[]>();
    for (const t of Object.values(tokens)) {
      if (t.state !== 'held' || !t.holder) continue;
      const i = this.keyIndex.get(t.holder);
      if (i !== undefined) held.set(i, [...(held.get(i) ?? []), t.id]);
    }
    const pending = new Map<number, { transfer: string; tokens: TokenId[] }[]>();
    const asState = { tokens } as unknown as MissionState;
    this.world.keys.forEach((k, i) => {
      const list = pendingTransfers(asState, k.publicKey);
      if (list.length) pending.set(i, list);
    });
    v = { held, pending };
    this.views.set(set, v);
    return v;
  }

  private sign(actor: number, set: number, type: AnyEvent['type'], body: unknown): number {
    const keys = this.world.keys[actor]!;
    const members = this.sets[set]!;
    const own = members.map((i) => this.events[i]!).filter((e) => e.actor === keys.publicKey);
    const head = own.sort((a, b) => b.seq - a.seq || (a.id < b.id ? -1 : 1))[0];
    const depended = new Set<number>();
    for (const i of members) for (const d of this.deps[i]!) depended.add(d);
    const tips = members.filter((i) => !depended.has(i)).map((i) => this.events[i]!);
    const lamport = Math.max(...members.map((i) => this.events[i]!.lamport)) + 1;
    const e = createEvent({
      keys,
      mission: this.world.capsule.id,
      seq: (head?.seq ?? 0) + 1,
      prev: head?.id ?? null,
      parents: tips.filter((t) => t.actor !== keys.publicKey).map((t) => t.id),
      lamport,
      wall: 1,
      type,
      body: body as never,
    }) as AnyEvent;
    return this.intern(e);
  }

  /** Every honest action this actor can take from what it knows now. */
  private moves(actor: number, set: number): { label: string; event: number }[] {
    const out: { label: string; event: number }[] = [];
    const view = this.view(set);
    const seq = this.sets[set]!.filter((i) => this.events[i]!.actor === this.world.keys[actor]!.publicKey).length;
    for (const token of this.spendable(actor, set, view)) {
      for (const taskId of TASKS) {
        out.push({ label: `a${actor} commit ${token} to ${taskId}`, event: this.sign(actor, set, 'right.committed', { tokens: [token], taskId }) });
      }
      for (let to = 0; to < this.cfg.actors; to++) {
        if (to === actor) continue;
        const transfer = `x${actor}.${seq}.${token}.${to}`;
        out.push({
          label: `a${actor} offer ${token} to a${to}`,
          event: this.sign(actor, set, 'right.offered', { transfer, tokens: [token], to: this.world.keys[to]!.publicKey }),
        });
      }
    }
    for (const p of view.pending.get(actor) ?? []) {
      out.push({ label: `a${actor} accept ${p.transfer}`, event: this.sign(actor, set, 'right.accepted', { transfer: p.transfer }) });
      out.push({ label: `a${actor} decline ${p.transfer}`, event: this.sign(actor, set, 'right.declined', { transfer: p.transfer }) });
    }
    return out;
  }

  private spendable(actor: number, set: number, view: View): TokenId[] {
    const held = view.held.get(actor) ?? [];
    if (this.cfg.mutant === 'spend-without-checking') return this.world.tokenIds;
    if (this.cfg.mutant !== 'refund-on-timeout') return held;
    const { tokens } = deriveTokens(this.world.capsule, this.eventsOf(set), this.world.custodians);
    const key = this.world.keys[actor]!.publicKey;
    const offered = Object.values(tokens).filter((t) => t.state === 'in-transit' && t.from === key).map((t) => t.id);
    return [...held, ...offered];
  }

  private ready(idx: number, member: Set<number>): boolean {
    return this.deps[idx]!.every((d) => member.has(d));
  }

  /** The device loses its newest own event and everything built on it, as a stale backup would. */
  private rolledBack(actor: number, set: number): number | null {
    const key = this.world.keys[actor]!.publicKey;
    const members = this.sets[set]!;
    const own = members.filter((i) => this.events[i]!.actor === key);
    if (!own.length) return null;
    const newest = own.reduce((a, b) => (this.events[a]!.seq >= this.events[b]!.seq ? a : b));
    const gone = new Set<number>([newest]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of members) {
        if (!gone.has(i) && this.deps[i]!.some((d) => gone.has(d))) {
          gone.add(i);
          grew = true;
        }
      }
    }
    return this.setId(members.filter((i) => !gone.has(i)));
  }

  private fail(invariant: string, detail: string, trace: string[]) {
    if (this.findings.length < this.maxFindings) this.findings.push({ invariant, detail, trace });
  }

  /** Checks one distinct replica set against a real log: reversed delivery, then every event twice. */
  private checkSet(set: number, trace: string[]) {
    if (this.checked.has(set)) return;
    this.checked.add(set);
    const events = this.eventsOf(set);
    const forward = new EventLog(this.world.capsule.id);
    forward.ingestMany(events);
    const scrambled = new EventLog(this.world.capsule.id);
    for (const e of [...events].reverse()) scrambled.ingest(e);
    for (const e of events) scrambled.ingest(e);
    const a = forward.all().map((e) => e.id).join();
    const b = scrambled.all().map((e) => e.id).join();
    if (a !== b) this.fail('order independence', 'EventLog order depends on delivery', trace);
    if (forward.size !== events.length) this.fail('log completeness', `log kept ${forward.size} of ${events.length}`, trace);
    const again = deriveTokens(this.world.capsule, [...scrambled.all(), ...scrambled.all()], this.world.custodians);
    const once = deriveTokens(this.world.capsule, events, this.world.custodians);
    if (JSON.stringify(again.tokens) !== JSON.stringify(once.tokens)) this.fail('idempotence', 'duplicates changed the ledger', trace);
    for (const e of events) if (!verifyEvent(e).ok) this.fail('integrity', `event ${e.id} failed verification`, trace);
  }

  /** Oracle built from raw signed events, independent of the ledger. */
  private checkUnion(set: number, trace: string[], honest: boolean) {
    if (this.unionChecked.has(set)) return;
    this.unionChecked.add(set);
    this.terminalUnions++;
    const events = this.eventsOf(set);
    const commits = new Map<TokenId, AnyEvent[]>();
    for (const e of events) {
      if (e.type !== 'right.committed') continue;
      for (const t of e.body.tokens) commits.set(t, [...(commits.get(t) ?? []), e]);
    }
    const slots = new Set<string>();
    let forked = false;
    for (const e of events) {
      const key = `${e.actor}#${e.seq}`;
      if (slots.has(key)) forked = true;
      slots.add(key);
    }
    if (forked) this.forkedUnions++;
    const promises = (list: AnyEvent[]) => new Set(list.map((e) => `${e.actor}|${(e.body as { taskId: string }).taskId}`)).size;
    const doubled = [...commits].filter(([, list]) => promises(list) > 1).map(([t]) => t);
    const state = reduce(events, this.world.roster);
    const ledgerViolations = state.conflicts.filter((c) => c.severity === 'violation');
    const classified = classify(events, state).filter((c) => c.severity === 'violation');
    const rows = conservation(state);

    if (rows.some((r) => !r.ok)) this.fail('conservation', JSON.stringify(rows), trace);
    if (honest) {
      if (doubled.length) this.fail('no double commit', `token ${doubled[0]} committed twice in an honest run`, trace);
      if (ledgerViolations.length) this.fail('no false alarm (ledger)', ledgerViolations[0]!.summary, trace);
      if (classified.length) this.fail('no false alarm (classifier)', classified[0]!.summary, trace);
    } else if (doubled.length) {
      this.doubleCommitUnions++;
      if (rows.every((r) => r.ok)) this.doubleCommitConservationOk++;
      for (const t of doubled) {
        if (!ledgerViolations.some((c) => c.tokenId === t)) this.fail('double commit surfaced (ledger)', `token ${t} committed twice with no violation`, trace);
        if (!classified.some((c) => c.tokenId === t)) this.fail('double commit surfaced (classifier)', `token ${t} committed twice with no violation`, trace);
      }
    }
    const asState = { tokens: state.tokens } as MissionState;
    for (const t of Object.values(state.tokens) as (MissionState['tokens'][string] & { to?: ActorId })[]) {
      if (t.state !== 'in-transit') continue;
      if (!pendingTransfers(asState, t.to!).some((p) => p.tokens.includes(t.id))) {
        this.fail('in-transit is answerable', `token ${t.id} in transit but its recipient has nothing to answer`, trace);
      }
    }
  }

  private checkNode(n: Node, trace: string[], honest: boolean) {
    const claimants = new Map<TokenId, Set<number>>();
    n.sets.forEach((set, actor) => {
      this.checkSet(set, trace);
      for (const t of this.view(set).held.get(actor) ?? []) {
        const who = claimants.get(t) ?? new Set<number>();
        who.add(actor);
        claimants.set(t, who);
      }
    });
    if (honest) {
      for (const [t, who] of claimants) {
        if (who.size > 1) this.fail('single actionable holder', `token ${t} is held by ${[...who].join(' and ')} at once`, trace);
      }
      n.sets.forEach((set, actor) => {
        const held = new Set(this.view(set).held.get(actor) ?? []);
        for (const e of this.eventsOf(set)) {
          if (e.type !== 'right.offered' || e.actor !== this.world.keys[actor]!.publicKey) continue;
          const answered = this.eventsOf(set).some(
            (x) => (x.type === 'right.declined' || x.type === 'right.accepted') && x.body.transfer === e.body.transfer,
          );
          for (const t of e.body.tokens) {
            if (!answered && held.has(t)) this.fail('no refund', `a${actor} regained ${t} with no answer to its offer`, trace);
          }
        }
      });
    }
    const union = new Set<number>();
    for (const set of n.sets) for (const i of this.sets[set]!) union.add(i);
    this.checkUnion(this.setId([...union]), trace, honest);
  }

  run(limit = 3_000_000): Report {
    const { actors, budget, rollbacks } = this.cfg;
    const genesisIdx = this.intern(this.world.genesis);
    const start = this.setId([genesisIdx]);
    const startNode: Node = { sets: Array.from({ length: actors }, () => start), spent: 0, group: 0, rollbacks: 0 };
    const seen = new Set<string>();
    const keyOf = (n: Node) => `${n.sets.join(',')}|${n.group}|${n.rollbacks}|${n.spent}`;
    const stack: { node: Node; parent: number; label: string }[] = [{ node: startNode, parent: -1, label: 'start' }];
    const parents: { parent: number; label: string }[] = [];
    const honest = rollbacks === 0;
    let states = 0;
    let transitions = 0;
    let truncated = false;

    const traceOf = (at: number): string[] => {
      const out: string[] = [];
      for (let i = at; i >= 0; i = parents[i]!.parent) out.unshift(parents[i]!.label);
      return out;
    };

    while (stack.length) {
      const { node, parent, label } = stack.pop()!;
      const key = keyOf(node);
      if (seen.has(key)) continue;
      seen.add(key);
      const id = parents.length;
      parents.push({ parent, label });
      states++;
      if (states > limit) {
        truncated = true;
        break;
      }
      this.checkNode(node, this.findings.length < this.maxFindings ? traceOf(id) : [], honest);

      const push = (next: Node, l: string) => {
        transitions++;
        stack.push({ node: next, parent: id, label: l });
      };

      for (let a = 0; a < actors; a++) {
        if (node.spent < budget) {
          for (const m of this.moves(a, node.sets[a]!)) {
            const sets = [...node.sets];
            sets[a] = this.setId([...this.sets[sets[a]!]!, m.event]);
            push({ ...node, sets, spent: node.spent + 1 }, m.label);
          }
        }
        for (let b = 0; b < actors; b++) {
          if (a === b) continue;
          if (this.groupOf[node.group]!.get(a) !== this.groupOf[node.group]!.get(b)) continue;
          const have = new Set(this.sets[node.sets[b]!]!);
          for (const i of this.sets[node.sets[a]!]!) {
            if (have.has(i) || !this.ready(i, have)) continue;
            const sets = [...node.sets];
            sets[b] = this.setId([...have, i]);
            push({ ...node, sets }, `deliver e${i} a${a}->a${b}`);
          }
        }
      }
      if (this.cfg.partitions) {
        for (let g = 0; g < this.groups.length; g++) {
          if (g !== node.group) push({ ...node, group: g }, `network ${JSON.stringify(this.groups[g])}`);
        }
      }
      if (node.rollbacks < rollbacks) {
        const lost = this.rolledBack(0, node.sets[0]!);
        if (lost !== null && lost !== node.sets[0]) {
          const sets = [...node.sets];
          sets[0] = lost;
          push({ ...node, sets, rollbacks: node.rollbacks + 1 }, 'a0 restored from a stale backup');
        }
      }
    }

    return {
      states,
      transitions,
      eventSets: this.sets.length,
      signedEvents: this.events.length,
      terminalUnions: this.terminalUnions,
      forkedUnions: this.forkedUnions,
      doubleCommitUnions: this.doubleCommitUnions,
      doubleCommitConservationOk: this.doubleCommitConservationOk,
      findings: this.findings,
      truncated,
    };
  }
}
