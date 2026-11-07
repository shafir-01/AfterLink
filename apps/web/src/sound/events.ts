import type { SoundEngine } from './engine.ts';
import type { RadioPlayer } from './radio.ts';

/** The slice of the stage snapshot the mapper reads. The stage snapshot satisfies it structurally. */
export interface SoundState {
  pairs: { state: 'open' | 'forming' | 'cut' }[];
  groups: unknown[][];
  done: number;
  refused: number;
  hq: { state: 'live' | 'blind' };
  carry: { phase: 'preparing' | 'walking' | 'scanning' | 'done' | 'failed' } | null;
}

const count = (s: SoundState, state: 'open' | 'forming' | 'cut') => s.pairs.filter((p) => p.state === state).length;

/** Turns a change between two controller states into sounds and radio lines. */
export function mapEvents(prev: SoundState | null, next: SoundState, sound: SoundEngine, radio: RadioPlayer) {
  const total = next.pairs.length;
  const open = count(next, 'open');
  sound.setBed(total ? open / total : 1);
  if (!prev) return;

  if (prev.hq.state === 'live' && next.hq.state === 'blind') {
    sound.play('powerdown');
    radio.say('hq-down');
    radio.say('medics-network');
  }

  const cutBefore = count(prev, 'cut');
  const cutNow = count(next, 'cut');
  if (cutNow > cutBefore) {
    sound.play('snap');
    if (next.groups.length > 1) {
      radio.say('medics-split');
      radio.say('supply-split');
    }
  }

  if (count(prev, 'open') < open && cutNow < cutBefore) sound.play('chime');

  if (next.refused > prev.refused) {
    sound.play('thud');
    radio.say('access-holding');
    radio.say(next.refused > 1 ? 'facilities-refuse' : 'medics-refuse');
  }

  if (next.done > prev.done) {
    sound.play('chime');
    radio.say(next.done === 1 ? 'medics-done' : 'facilities-done');
  }

  const was = prev.carry?.phase;
  const now = next.carry?.phase;
  if (was !== now) {
    if (now === 'walking') {
      sound.startSteps();
      radio.say('supply-courier');
    } else sound.stopSteps();
    if (now === 'scanning') {
      sound.play('tick');
      radio.say('access-scan');
    }
    if (now === 'done') radio.say('supply-received');
  }

  const healed = prev.pairs.some((p) => p.state === 'cut') && total > 0 && open === total;
  if (healed) {
    sound.play('swell');
    radio.say('facilities-restore');
    radio.say('medics-restore');
    radio.say('all-back');
  }
}
