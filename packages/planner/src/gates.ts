import type { KnowledgeState, NextStep, RefusalCode, ResourceId, TaskRecord } from '@afterlink/protocol';
import * as say from './explain.ts';
import {
  contactInput,
  deadlineAt,
  factFor,
  isActive,
  resourceName,
  teamName,
  type Fact,
  type Input,
  type Member,
  type View,
} from './view.ts';

export interface Gate {
  refusal: RefusalCode;
  next: NextStep[];
  reason: string;
  policy: string;
  inputs: Input[];
}

/** Irreversible work needs every fact it relies on to stand today. */
const UNSAFE: ReadonlySet<KnowledgeState> = new Set(['stale', 'contradicted', 'pending', 'unreachable']);

/** Inside this window a deadline makes waiting a poor option. */
const URGENT_MS = 5 * 60_000;

export function factsFor(view: View, task: TaskRecord): Fact[] {
  return (task.spec.reliesOn ?? []).map((key) => factFor(view, key));
}

function plainInputs(facts: readonly Fact[]): Input[] {
  return facts.map(({ key, ageMs, state }) => ({ key, ageMs, state }));
}

/** Reports a reversible task is going ahead in spite of. A fact nobody has reported is not one. */
export function shakyFacts(facts: readonly Fact[]): string[] {
  return facts.filter((f) => UNSAFE.has(f.state) && f.ageMs >= 0).map((f) => f.subject);
}

export function capableMembers(view: View, task: TaskRecord): Member[] {
  const { requires } = task.spec;
  if (!requires.length) return view.group;
  return view.group.filter((m) => {
    const skills = view.skills.get(m.team.id)!;
    return requires.every((c) => skills.has(c));
  });
}

function capableAnywhere(view: View, task: TaskRecord): boolean {
  return view.everyone.some((e) => {
    const skills = view.skills.get(e.team.id)!;
    return task.spec.requires.every((c) => skills.has(c));
  });
}

function dependencyGate(view: View, task: TaskRecord, inputs: Input[]): Gate | null {
  const policy = 'task.dependsOn';
  for (const id of task.spec.dependsOn) {
    const dep = view.input.state.tasks[id];
    if (dep?.status === 'completed') continue;
    if (!dep) {
      return { refusal: 'DEPENDENCY_UNMET', next: ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'], reason: say.waitingOnUnknown(), policy, inputs };
    }
    if (dep.status === 'cancelled') {
      return { refusal: 'DEPENDENCY_UNMET', next: ['ESCALATE'], reason: say.dependencyCancelled(dep.spec.title), policy, inputs };
    }
    const cutOff = isActive(dep) && dep.owner && !view.members.has(dep.owner);
    return {
      refusal: 'DEPENDENCY_UNMET',
      next: cutOff ? ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'] : [],
      reason: say.waitingOn(dep.spec.title),
      policy,
      inputs: cutOff ? [...inputs, contactInput(view, dep.owner!)] : inputs,
    };
  }
  return null;
}

function knowledgeGate(facts: readonly Fact[], inputs: Input[]): Gate | null {
  const bad = facts.find((f) => UNSAFE.has(f.state));
  if (!bad) return null;
  const reason =
    bad.state === 'contradicted'
      ? say.disputedFact(bad.subject)
      : bad.state === 'pending'
        ? say.missingFact(bad.subject)
        : bad.state === 'unreachable'
          ? say.unreachableFact(bad.subject, bad.ageMs)
          : say.staleFact(bad.subject, bad.ageMs);
  const next: NextStep[] = bad.state === 'stale' || bad.state === 'contradicted' ? ['ESCALATE'] : ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'];
  return { refusal: 'STALE_KNOWLEDGE', next, reason, policy: 'task.reversible', inputs };
}

/** Conditions that stop a task for everyone here, whoever would have done it. */
export function taskGate(view: View, task: TaskRecord, capable: readonly Member[], willing: readonly Member[]): Gate | null {
  const { spec } = task;
  const facts = factsFor(view, task);
  const inputs = plainInputs(facts);

  const rule = view.blockedKinds.get(spec.kind);
  if (rule) {
    const trigger = factFor(view, rule.when.key);
    return {
      refusal: 'BLOCKED_BY_CONTINGENCY',
      next: ['SUBSTITUTE', 'ESCALATE'],
      reason: say.blocked(rule.then.note),
      policy: `contingency.${rule.id}`,
      inputs: [...inputs.filter((i) => i.key !== trigger.key), ...plainInputs([trigger])],
    };
  }

  const dependency = dependencyGate(view, task, inputs);
  if (dependency) return dependency;

  if (!willing.length) {
    const elsewhere = capable.length === 0 && capableAnywhere(view, task);
    return {
      refusal: 'NO_CAPABILITY',
      next: elsewhere ? ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'] : ['ESCALATE'],
      reason: capable.length ? say.everyoneDeclined() : say.noCapability(spec.requires),
      policy: 'task.requires',
      inputs,
    };
  }

  if (!spec.reversible) {
    const stale = knowledgeGate(facts, inputs);
    if (stale) return stale;
  }

  if (view.capsule.fallback.humanApprovalKinds.includes(spec.kind)) {
    return { refusal: 'HUMAN_APPROVAL_REQUIRED', next: ['ESCALATE'], reason: say.needsPerson(), policy: 'fallback.humanApprovalKinds', inputs };
  }
  return null;
}

function isUrgent(view: View, task: TaskRecord): boolean {
  if (task.spec.priority === 1) return true;
  const due = deadlineAt(task, view.capsule);
  return due !== undefined && due - view.input.now <= URGENT_MS;
}

/** Why the rights for a task cannot be had by anyone here. Reads the pool after reservations. */
export function rightsGate(view: View, task: TaskRecord, needs: ReadonlyMap<ResourceId, number>): Gate | null {
  const policy = 'authority.exclusive-token';
  const inputs = plainInputs(factsFor(view, task));
  for (const [resource, count] of needs) {
    if (view.pool.inContact(resource) >= count) continue;
    const name = resourceName(view, resource);
    if (view.pool.isMoving(resource)) {
      return { refusal: 'TOKEN_IN_TRANSIT', next: ['WAIT_FOR_CONTACT', 'CARRY_UPDATE'], reason: say.inTransit(name), policy, inputs };
    }
    const holder = view.pool.holderOutOfContact(resource);
    if (holder) {
      const next: NextStep[] = isUrgent(view, task)
        ? ['CARRY_UPDATE', 'SUBSTITUTE', 'WAIT_FOR_CONTACT']
        : ['CARRY_UPDATE', 'WAIT_FOR_CONTACT'];
      return {
        refusal: 'NO_RIGHT',
        next,
        reason: say.holderOutOfReach(teamName(view, holder), name),
        policy,
        inputs: [...inputs, contactInput(view, holder)],
      };
    }
    return { refusal: 'NO_RIGHT', next: ['SUBSTITUTE', 'ESCALATE'], reason: say.allCommitted(name), policy, inputs };
  }
  return null;
}
