import { canonicalize, signBytes, verifyBytes } from '@afterlink/protocol';
import type { ActorId, SignalClient } from '@afterlink/protocol';
import { helloProofBytes, wsSignalClient } from '@afterlink/mesh';
import type { DeviceCommand, DeviceReport } from '../bridge';

/** A command from the lead. HQ on or off is the one thing a phone's shell does itself. */
export type LeadCommand = DeviceCommand | { kind: 'hq'; up: boolean };

export interface SignedCommand {
  n: number;
  body: LeadCommand;
  sig: string;
}

export interface PhoneMessage {
  report: DeviceReport;
  /** Large event lists arrive in parts. */
  part?: number;
  parts?: number;
}

interface Keys {
  publicKey: ActorId;
  secretKey: string;
}

const commandBytes = (n: number, body: LeadCommand) => new TextEncoder().encode(canonicalize({ domain: 'afterlink/control/1', n, body }));

export const signCommand = (secretKey: string, n: number, body: LeadCommand): SignedCommand => ({ n, body, sig: signBytes(secretKey, commandBytes(n, body)) });

export const verifyCommand = (issuer: ActorId, c: SignedCommand): boolean => verifyBytes(issuer, commandBytes(c.n, c.body), c.sig);

/**
 * A lead and its phones talking through the relay, in a room of their own. It carries drill commands
 * and status for the lead's screen, never mission data, so it stays up while a phone's HQ link is down.
 */
export class ControlChannel {
  private readonly client: SignalClient;
  private readonly here = new Set<ActorId>();

  constructor(
    url: string,
    private readonly room: string,
    private readonly keys: Keys,
    private readonly handlers: {
      message: (from: ActorId, data: unknown) => void;
      presence?: (here: ReadonlySet<ActorId>) => void;
      state?: (up: boolean) => void;
    },
  ) {
    this.client = wsSignalClient(url);
    this.client.onState((up) => {
      if (up) this.client.send({ t: 'hello', room, actor: keys.publicKey });
      handlers.state?.(up);
    });
    this.client.onMessage((m) => {
      const frame = m as typeof m | { t: 'challenge'; nonce: string };
      switch (frame.t) {
        case 'challenge':
          this.prove(frame.nonce);
          break;
        case 'peers':
          this.here.clear();
          frame.peers.forEach((p) => this.here.add(p));
          handlers.presence?.(this.here);
          break;
        case 'joined':
          this.here.add(frame.actor);
          handlers.presence?.(this.here);
          break;
        case 'left':
          this.here.delete(frame.actor);
          handlers.presence?.(this.here);
          break;
        case 'signal':
          if (frame.to === keys.publicKey) handlers.message(frame.from, frame.data);
          break;
      }
    });
  }

  get connected(): boolean {
    return this.client.connected;
  }

  send(to: ActorId, data: unknown) {
    this.client.send({ t: 'signal', from: this.keys.publicKey, to, data });
  }

  close() {
    this.client.close();
  }

  private prove(nonce: string) {
    const { publicKey: actor, secretKey } = this.keys;
    const sig = signBytes(secretKey, helloProofBytes(this.room, actor, nonce));
    this.client.send({ t: 'hello', room: this.room, actor, nonce, sig } as Parameters<SignalClient['send']>[0]);
  }
}

export const controlRoom = (room: string) => `${room}.control`;
