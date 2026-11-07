import type { HubState } from '@afterlink/mesh';
import type { TaskSpec } from '@afterlink/protocol';

/** Stage to HQ worker. */
export type HqCommand =
  /** ports[0] is the device's signalling port. A later connect for the same slot replaces it. */
  | { kind: 'connect'; slot: string }
  | { kind: 'ingress'; ref: string; spec: TaskSpec };

/** HQ worker to stage. */
export type HqNotice = { kind: 'started' } | { kind: 'state'; state: HubState; at: number };
