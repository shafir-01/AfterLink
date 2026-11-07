import type { MissionCapsule, ResourceId } from '@afterlink/protocol';

/** "the evacuation chair" from "Evacuation chair"; acronyms such as "AED" keep their case. */
export function resourcePhrase(capsule: MissionCapsule | null, resource: ResourceId): string {
  const name = capsule?.resources.find((r) => r.id === resource)?.name ?? resource;
  return `the ${/^[A-Z][a-z]/.test(name) ? name[0]!.toLowerCase() + name.slice(1) : name}`;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
