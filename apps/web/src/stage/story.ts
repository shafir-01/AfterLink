import type { MissionCapsule, TeamId } from '@afterlink/protocol';
import type { DemoBeat } from '@afterlink/mission';
import type { StepId } from './contract';

export const STEPS: StepId[] = ['break', 'split', 'contest', 'carry', 'restore', 'debrief'];

export function labelFor(step: StepId, resource: string): string {
  switch (step) {
    case 'break':
      return 'Break the network';
    case 'split':
      return 'Split the teams';
    case 'contest':
      return `Request the ${resource.toLowerCase()}`;
    case 'carry':
      return 'Carry the update';
    case 'restore':
      return 'Restore contact';
    case 'debrief':
      return 'See what happened';
  }
}

/** Who plays which part. Everything here is read from the mission and its scripted incidents. */
export interface Cast {
  /** Left to right. The two devices either side of the gap are the ones the update crosses. */
  order: TeamId[];
  left: TeamId[];
  right: TeamId[];
  resourceName: string;
  connected: DemoBeat;
  hqDown: DemoBeat;
  /** Raised just before the split, so an unfinished task crosses it. */
  held: DemoBeat | null;
  split: DemoBeat[];
  refused: DemoBeat;
  granted: DemoBeat;
  ferry: DemoBeat;
  sender: TeamId;
  receiver: TeamId;
}

export function castFor(capsule: MissionCapsule, beats: DemoBeat[], split: { a: TeamId[]; b: TeamId[] }): Cast {
  const at = (step: DemoBeat['step']) => beats.filter((b) => b.step === step);
  const contested = at('contested');
  const need = contested.find((b) => b.spec?.needs.length)?.spec?.needs[0];
  const resource = capsule.resources.find((r) => r.id === need?.resource);
  const holder = resource?.tokens[0]?.holderTeam;
  const inHolderGroup = (t: TeamId) => (split.a.includes(holder ?? '') ? split.a : split.b).includes(t);
  const ferry = at('ferry')[0]!;
  const senderGroup = split.a.includes(ferry.team) ? split.a : split.b;
  const receiverGroup = senderGroup === split.a ? split.b : split.a;
  const near = (group: TeamId[], team: TeamId) => [...group.filter((t) => t !== team), team];
  const left = near(senderGroup, ferry.team);
  const right = [...near(receiverGroup, receiverGroup[0]!)].reverse();
  return {
    order: [...left, ...right],
    left,
    right,
    resourceName: resource?.name ?? 'Resource',
    connected: at('connected')[0]!,
    hqDown: at('hq-down').find((b) => !b.splitOnClaim)!,
    held: at('hq-down').find((b) => b.splitOnClaim) ?? null,
    split: at('split'),
    refused: contested.find((b) => !inHolderGroup(b.team))!,
    granted: contested.find((b) => inHolderGroup(b.team))!,
    ferry,
    sender: ferry.team,
    receiver: right[0]!,
  };
}
