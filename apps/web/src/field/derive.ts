import type { ActorView } from '@afterlink/actor';
import type { DecisionRecord, KnowledgeState, TaskRecord, TokenRecord } from '@afterlink/protocol';

export type Connection = 'Connected' | 'Team only' | 'Alone';

export function connection(view: ActorView): Connection {
  const open = view.links.some((l) => l.state === 'open');
  if (!open) return 'Alone';
  return view.signalUp ? 'Connected' : 'Team only';
}

export function lastHeard(view: ActorView): number | null {
  const t = Object.values(view.lastHeard);
  return t.length ? Math.max(...t) : null;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const BLOCKED = new Set(['refused', 'deferred']);

export interface Focus {
  task: TaskRecord | null;
  refusal: DecisionRecord | null;
}

export function focus(view: ActorView): Focus {
  const next = view.nextAction;
  const refusal =
    [...view.refusals].reverse().find((d) => {
      const t = view.state.tasks[d.taskId];
      return t && BLOCKED.has(t.status) && (!next || next.spec.id === d.taskId);
    }) ?? null;
  const task = next ?? (refusal ? view.state.tasks[refusal.taskId] ?? null : null);
  return { task, refusal };
}

export function teamName(view: ActorView, teamId: string): string {
  return view.state.capsule?.teams.find((t) => t.id === teamId)?.name ?? teamId;
}

export function actorTeam(view: ActorView, actor: string | null): string {
  if (!actor) return 'Another team';
  const team = view.state.actors[actor]?.team;
  return team ? teamName(view, team) : 'Another team';
}

export function noun(view: ActorView, resource: string): string {
  const name = view.state.capsule?.resources.find((r) => r.id === resource)?.name ?? resource;
  const w = name.trim().split(/\s+/).pop()!;
  return w === w.toUpperCase() ? w : w.toLowerCase();
}

export interface Step {
  kind: 'ask' | 'carry' | 'none';
  label: string;
  hint?: string;
  resource?: string;
}

export function nextStep(view: ActorView, d: DecisionRecord, task: TaskRecord): Step {
  const steps = d.next ?? [];
  const need = task.spec.needs[0];
  if (steps.includes('REQUEST_TRANSFER') && need && view.reachable.length > 0) {
    const holder = Object.values(view.state.tokens).find(
      (t) => t.resource === need.resource && t.state === 'held' && t.holder !== view.self.id,
    );
    const who = holder ? actorTeam(view, holder.holder) : null;
    const what = noun(view, need.resource);
    return { kind: 'ask', resource: need.resource, label: who ? `Ask ${who} for the ${what}` : `Ask for the ${what}` };
  }
  if (steps.includes('CARRY_UPDATE')) return { kind: 'carry', label: 'Carry an update' };
  if (steps.includes('WAIT_FOR_CONTACT')) return { kind: 'none', label: '', hint: 'Wait for contact.' };
  if (steps.includes('ESCALATE')) return { kind: 'none', label: '', hint: 'Tell your team lead.' };
  if (steps.includes('SUBSTITUTE')) return { kind: 'none', label: '', hint: 'Another team may cover this.' };
  return { kind: 'none', label: '' };
}

export interface Right { resource: string; label: string; count: number; passing: boolean }

export function rights(view: ActorView): Right[] {
  const map = new Map<string, Right>();
  for (const t of view.tokens as TokenRecord[]) {
    const passing = t.state === 'in-transit';
    const key = t.resource + (passing ? ':p' : '');
    const r = map.get(key) ?? { resource: t.resource, label: noun(view, t.resource), count: 0, passing };
    r.count++;
    map.set(key, r);
  }
  return [...map.values()];
}

export const knowledgeWords: Record<KnowledgeState, string> = {
  confirmed: 'confirmed by others',
  local: 'seen only by you',
  stale: 'may be out of date',
  contradicted: 'disputed',
  pending: 'waiting for confirmation',
  unreachable: 'out of reach',
};

export function age(ms: number): string {
  if (ms < 45_000) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min old`;
  return `${Math.round(m / 60)} h old`;
}

export function announce(view: ActorView): string {
  const { task, refusal } = focus(view);
  const parts: string[] = [connection(view)];
  if (refusal && task) parts.push(`Cannot start ${task.spec.title}. ${refusal.reason}`);
  else if (task) parts.push(`${task.status === 'accepted' ? 'In progress' : 'New assignment'}: ${task.spec.title}`);
  else parts.push('No assignment');
  return parts.join('. ');
}
