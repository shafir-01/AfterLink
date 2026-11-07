import type { EventId } from '@afterlink/protocol';

/**
 * ready: may sign.
 * recovering: signs nothing until it has proof of how far its own chain reaches.
 * halted: its own key has signed two histories, so it never signs again.
 * duplicate: another runtime on this device holds the key, so this one only reads.
 */
export type ActorPhase = 'ready' | 'recovering' | 'halted' | 'duplicate';

export interface ChainPoint {
  seq: number;
  id: EventId | null;
}

const WAITING_FOR_CONTACT = 'Waiting for a peer to confirm what this device has already signed.';
const BEHIND = 'This device has lost part of its record. It will not act until a peer or a carried update returns it.';
const FORKED = 'This device has signed two different histories. It has stopped acting and needs the organiser.';
const TWIN = 'This identity is already open elsewhere on this device. This copy can only read.';

/**
 * Decides whether this device may sign. A key that signs from a rolled back log forks its own
 * chain, and a fork of a token holder is a double spend, so the safe answer when history is in
 * doubt is to stop and wait for evidence.
 */
export class SigningGate {
  phase: ActorPhase = 'ready';
  reason: string | null = null;
  /** How far this chain is known to reach. Null while nothing is known either way. */
  private target: ChainPoint | null = null;

  /**
   * Judges what survived on this device. An empty log with no mark may be a first run or a wiped
   * device, and those look identical from here, so both wait for one peer to say.
   */
  constructor(head: ChainPoint, mark: ChainPoint | null) {
    if (!mark) {
      if (head.seq === 0) this.wait(null, WAITING_FOR_CONTACT);
      return;
    }
    if (head.seq < mark.seq) this.wait(mark, BEHIND);
    else if (head.seq === mark.seq && head.id !== mark.id) this.halt();
  }

  private wait(target: ChainPoint | null, reason: string): void {
    this.phase = 'recovering';
    this.target = target;
    this.reason = reason;
  }

  private open(): void {
    this.phase = 'ready';
    this.target = null;
    this.reason = null;
  }

  halt(): void {
    this.phase = 'halted';
    this.target = null;
    this.reason = FORKED;
  }

  twin(): void {
    this.phase = 'duplicate';
    this.reason = TWIN;
  }

  /** What a peer summary or a carried packet shows about this actor's own chain. */
  evidence(head: ChainPoint, seen: ChainPoint | undefined, holds: (id: EventId) => boolean): void {
    if (this.phase === 'halted' || this.phase === 'duplicate') return;
    if (!seen) {
      if (this.phase === 'recovering' && !this.target) this.open();
      return;
    }
    if (seen.seq > head.seq) {
      if (this.phase === 'recovering' && this.target && this.target.seq >= seen.seq) return;
      this.wait(seen, BEHIND);
      return;
    }
    if (seen.id && !holds(seen.id)) {
      this.halt();
      return;
    }
    if (this.phase === 'recovering' && !this.target) this.open();
    else this.caughtUp(head, holds);
  }

  /** Called as the device takes its own events back in. */
  caughtUp(head: ChainPoint, holds: (id: EventId) => boolean): void {
    if (this.phase !== 'recovering' || !this.target || head.seq < this.target.seq) return;
    if (this.target.id && !holds(this.target.id)) this.halt();
    else this.open();
  }
}
