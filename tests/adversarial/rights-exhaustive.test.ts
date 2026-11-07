import { describe, expect, it } from 'vitest';
import { Explorer, type WorldConfig } from './explorer.ts';

const deep = process.env.AFTERLINK_EXPLORE === 'deep';

const HONEST: WorldConfig[] = [
  { actors: 2, tokens: 1, budget: deep ? 12 : 9, partitions: true },
  { actors: 2, tokens: 2, budget: deep ? 7 : 6, partitions: true },
  { actors: 3, tokens: 1, budget: deep ? 7 : 5, partitions: true },
  { actors: 3, tokens: 1, budget: deep ? 8 : 6 },
  { actors: 3, tokens: 2, budget: deep ? 5 : 4 },
  { actors: 4, tokens: 1, budget: deep ? 6 : 5 },
  { actors: 4, tokens: 2, budget: deep ? 4 : 3 },
];

const RESTORED: WorldConfig[] = [
  { actors: 2, tokens: 1, budget: deep ? 8 : 6, rollbacks: 1 },
  { actors: 2, tokens: 2, budget: deep ? 6 : 5, rollbacks: 1 },
  { actors: 3, tokens: 1, budget: deep ? 6 : 5, rollbacks: 1 },
];

const label = (c: WorldConfig) => `${c.actors} actors, ${c.tokens} tokens, ${c.budget} signed events${c.partitions ? ', explicit partitions' : ''}`;

describe('rights protocol, every interleaving inside the bound', () => {
  for (const cfg of HONEST) {
    it(`honest: ${label(cfg)}`, { timeout: 600_000 }, () => {
      const r = new Explorer(cfg).run();
      console.log(`[explore honest] ${label(cfg)}: ${r.states} states, ${r.transitions} transitions, ${r.eventSets} event sets, ${r.signedEvents} distinct events`);
      expect(r.truncated).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.states).toBeGreaterThan(10);
    });
  }
});

describe('a device restored from a stale backup, every interleaving inside the bound', () => {
  for (const cfg of RESTORED) {
    it(`every double commit is surfaced: ${label(cfg)}`, { timeout: 600_000 }, () => {
      const r = new Explorer(cfg).run();
      console.log(
        `[explore restored] ${label(cfg)}: ${r.states} states, forked histories ${r.forkedUnions}, double commits ${r.doubleCommitUnions}, of which conservation still reported ok ${r.doubleCommitConservationOk}`,
      );
      expect(r.truncated).toBe(false);
      expect(r.findings).toEqual([]);
    });
  }
});

describe('the oracles can fail', () => {
  it('catches a sender that takes its token back when an answer is late', { timeout: 60_000 }, () => {
    const r = new Explorer({ actors: 2, tokens: 1, budget: 4, mutant: 'refund-on-timeout' }).run();
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('catches an actor that spends what it does not hold', { timeout: 60_000 }, () => {
    const r = new Explorer({ actors: 2, tokens: 1, budget: 3, mutant: 'spend-without-checking' }).run();
    expect(r.findings.length).toBeGreaterThan(0);
  });
});
