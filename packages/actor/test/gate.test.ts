import { describe, expect, it } from 'vitest';
import { SigningGate } from '../src/gate.ts';

const at = (seq: number, id: string | null = `e${seq}`) => ({ seq, id });
const holdsUpTo = (n: number) => (id: string) => Number(id.slice(1)) <= n;

describe('what survived on the device decides the first phase', () => {
  it('opens when the log reaches the mark', () => {
    expect(new SigningGate(at(5), at(5)).phase).toBe('ready');
  });

  it('opens when the log is ahead of the mark, as a crash after the append leaves it', () => {
    expect(new SigningGate(at(6), at(5)).phase).toBe('ready');
  });

  it('opens on a log with no mark, as storage from before marks existed leaves it', () => {
    expect(new SigningGate(at(3), null).phase).toBe('ready');
  });

  it('shuts when the log is behind the mark', () => {
    expect(new SigningGate(at(3), at(5)).phase).toBe('recovering');
  });

  it('shuts on an empty log with a mark: the log was wiped', () => {
    expect(new SigningGate(at(0, null), at(5)).phase).toBe('recovering');
  });

  it('shuts on an empty log with no mark: first run and wiped look the same', () => {
    expect(new SigningGate(at(0, null), null).phase).toBe('recovering');
  });

  it('halts when the log and the mark disagree about the same position', () => {
    expect(new SigningGate(at(5, 'other'), at(5)).phase).toBe('halted');
  });
});

describe('evidence from a peer', () => {
  it('lets a first run start when a peer holds nothing from this key', () => {
    const g = new SigningGate(at(0, null), null);
    g.evidence(at(0, null), undefined, () => false);
    expect(g.phase).toBe('ready');
  });

  it('does not open a device that knows it published, however many peers know nothing', () => {
    const g = new SigningGate(at(0, null), at(5));
    g.evidence(at(0, null), undefined, () => false);
    expect(g.phase).toBe('recovering');
  });

  it('keeps a wiped device shut until it holds what the peer showed', () => {
    const g = new SigningGate(at(0, null), null);
    g.evidence(at(0, null), at(4), () => false);
    expect(g.phase).toBe('recovering');
    g.caughtUp(at(3), holdsUpTo(3));
    expect(g.phase).toBe('recovering');
    g.caughtUp(at(4), holdsUpTo(4));
    expect(g.phase).toBe('ready');
  });

  it('never lowers the target: a lagging peer cannot talk a device below its mark', () => {
    const g = new SigningGate(at(2), at(7));
    g.evidence(at(2), at(4), () => false);
    expect(g.phase).toBe('recovering');
    g.caughtUp(at(4), holdsUpTo(4));
    expect(g.phase).toBe('recovering');
    g.caughtUp(at(7), holdsUpTo(7));
    expect(g.phase).toBe('ready');
  });

  it('shuts a running device the moment a peer shows it is behind', () => {
    const g = new SigningGate(at(5), at(5));
    g.evidence(at(5), at(8), holdsUpTo(5));
    expect(g.phase).toBe('recovering');
  });

  it('ignores a peer that is simply behind', () => {
    const g = new SigningGate(at(5), at(5));
    g.evidence(at(5), at(3), holdsUpTo(5));
    expect(g.phase).toBe('ready');
  });

  it('halts when a peer holds an event of this key the device never signed', () => {
    const g = new SigningGate(at(5), at(5));
    g.evidence(at(5), at(5, 'e9'), holdsUpTo(5));
    expect(g.phase).toBe('halted');
  });

  it('halts when the chain it recovered does not contain its own mark', () => {
    const g = new SigningGate(at(2), at(5, 'e5'));
    g.caughtUp(at(5, 'x5'), (id) => id === 'x5');
    expect(g.phase).toBe('halted');
  });
});

describe('terminal phases', () => {
  it('stays halted whatever arrives next', () => {
    const g = new SigningGate(at(5), at(5));
    g.halt();
    g.evidence(at(5), undefined, () => true);
    g.caughtUp(at(9), () => true);
    expect(g.phase).toBe('halted');
    expect(g.reason).toBeTruthy();
  });

  it('a duplicate runtime stays read only', () => {
    const g = new SigningGate(at(5), at(5));
    g.twin();
    g.evidence(at(5), undefined, () => true);
    expect(g.phase).toBe('duplicate');
  });
});
