import type { ActorId, Link, LinkInfo, TransportKind } from '@afterlink/protocol';
import type { Clock } from './clock.ts';

export interface LinkRequest {
  self: ActorId;
  peer: ActorId;
  /** Deterministic on both ends: the lower actor id dials and is impolite, the other end listens and is polite. */
  role: 'dialer' | 'listener';
  polite: boolean;
  /** Sends one opaque negotiation payload to the peer over the current signalling path. */
  signal(data: unknown): void;
}

export interface NegotiatedLink extends Link {
  /** Feeds in one negotiation payload received from the peer. */
  signal(data: unknown): void;
}

/** A link able to name the transport keys it runs over, so a key proof cannot be relayed through a third party. */
export interface BoundLink extends Link {
  binding(): string;
}

export interface LinkConnector {
  readonly kind: TransportKind;
  /** Present on simulated networks, so Mesh and attachSync share virtual time. */
  readonly clock?: Clock;
  connect(req: LinkRequest): NegotiatedLink;
}

export interface LinkStats extends LinkInfo {
  /** Links formed with this peer since start. */
  opens: number;
  /** Connection attempts made towards this peer since start. */
  attempts: number;
  /** Messages discarded by the fault gate. */
  dropped: number;
  /** Extra copies injected by the fault gate. */
  duplicated: number;
  /** Messages held back by the fault gate and not yet on the link. */
  held: number;
  /** True when the hub currently lists this peer. */
  online: boolean;
  /** True when the fault plan blocks this peer. */
  blocked: boolean;
  /** True when the peer proved it holds the key behind its actor id on the current link. */
  authenticated: boolean;
  /** Links dropped because the peer failed to prove its key. */
  authFailures: number;
}
