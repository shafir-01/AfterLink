import { describe, expect, it } from 'vitest';
import { mapEvents, type SoundState } from './events.ts';

const st = (o: Partial<SoundState> = {}): SoundState => ({
  pairs: [{ state: 'open' }, { state: 'open' }],
  groups: [[1, 2]],
  done: 0,
  refused: 0,
  hq: { state: 'live' },
  carry: null,
  ...o,
});

function run(prev: SoundState, next: SoundState) {
  const played: string[] = [];
  const said: string[] = [];
  const sound = { play: (n: string) => played.push(n), setBed: () => undefined, startSteps: () => played.push('steps'), stopSteps: () => undefined };
  const radio = { say: (id: string) => said.push(id) };
  mapEvents(prev, next, sound as never, radio as never);
  return { played, said };
}

describe('mapEvents', () => {
  it('powers down when HQ goes blind', () => {
    const r = run(st(), st({ hq: { state: 'blind' } }));
    expect(r.played).toContain('powerdown');
    expect(r.said).toContain('medics-network');
  });
  it('snaps on a cut and thuds on a refusal', () => {
    expect(run(st(), st({ pairs: [{ state: 'cut' }, { state: 'open' }] })).played).toContain('snap');
    expect(run(st(), st({ refused: 1 })).played).toContain('thud');
  });
  it('swells when every link is back', () => {
    const r = run(st({ pairs: [{ state: 'cut' }, { state: 'open' }] }), st());
    expect(r.played).toContain('swell');
    expect(r.said).toContain('all-back');
  });
  it('walks while the courier carries', () => {
    expect(run(st(), st({ carry: { phase: 'walking' } })).played).toContain('steps');
  });
});
