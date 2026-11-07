import type { KeyPair } from './crypto.ts';
import { createEvent } from './envelope.ts';
import type { EventLog } from './log.ts';
import type { AnyEvent, EventBodies, EventEnvelope, EventType } from './types.ts';

/** Signs new events on top of everything the log holds. All state lives in the log, so a restart resumes the chain. */
export class Author {
  private readonly keys: KeyPair;
  private readonly log: EventLog;

  constructor(keys: KeyPair, log: EventLog) {
    this.keys = keys;
    this.log = log;
  }

  emit<T extends EventType>(type: T, body: EventBodies[T], wall: number = Date.now()): EventEnvelope<T> {
    const self = this.keys.publicKey;
    const head = this.log.head(self);
    const event = createEvent({
      keys: this.keys,
      mission: this.log.mission,
      seq: (head?.seq ?? 0) + 1,
      prev: head?.id ?? null,
      parents: this.log.heads().filter((id) => this.log.get(id)?.actor !== self),
      lamport: this.log.lamport() + 1,
      wall,
      type,
      body,
    });
    this.log.ingest(event as unknown as AnyEvent);
    return event;
  }
}
