import type { KeyPair } from './crypto.ts';
import { createEvent, verifyEvent } from './envelope.ts';
import type { EventLog } from './log.ts';
import type { AnyEvent, EventBodies, EventEnvelope, EventType } from './types.ts';

/**
 * Signs new events on top of everything the log holds. All state lives in the log, so a restart
 * resumes the chain. Throws rather than losing an event the log refuses.
 */
export class Author {
  private readonly keys: KeyPair;
  private readonly log: EventLog;

  constructor(keys: KeyPair, log: EventLog) {
    this.keys = keys;
    this.log = log;
  }

  emit<T extends EventType>(type: T, body: EventBodies[T], wall: number = Date.now()): EventEnvelope<T> {
    const head = this.log.head(this.keys.publicKey);
    const event = createEvent({
      keys: this.keys,
      mission: this.log.mission,
      seq: (head?.seq ?? 0) + 1,
      prev: head?.id ?? null,
      parents: this.log.heads().filter((id) => id !== head?.id),
      lamport: this.log.lamport() + 1,
      wall,
      type,
      body,
    });
    const signed = event as unknown as AnyEvent;
    if (this.log.ingest(signed) === 'invalid') {
      const verdict = verifyEvent(signed);
      throw new TypeError(`Log refused ${type}: ${verdict.ok ? 'actor not admitted' : verdict.reason}`);
    }
    return event;
  }
}
