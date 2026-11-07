import { useEffect, useRef, useSyncExternalStore } from 'react';
import { sound, type SoundName } from './engine.ts';
import { mapEvents, type SoundState } from './events.ts';
import { radio } from './radio.ts';

export interface SoundApi {
  muted: boolean;
  toggle: () => void;
  play: (name: SoundName) => void;
}

const play = (name: SoundName) => sound.play(name);

/** Arms audio on the first gesture and exposes the persisted mute toggle. */
export function useSound(): SoundApi {
  useEffect(() => sound.arm(), []);
  const muted = useSyncExternalStore(sound.subscribe, sound.getMuted, () => false);
  useEffect(() => {
    if (muted) radio.silence();
  }, [muted]);
  return { muted, toggle: sound.toggle, play };
}

/** Feeds controller snapshots to the sound mapper. Pass null before the mission is ready. */
export function useSoundEvents(state: SoundState | null, run = 0) {
  useSound();
  const prev = useRef<SoundState | null>(null);
  const lastRun = useRef(run);
  useEffect(() => {
    if (lastRun.current !== run) {
      lastRun.current = run;
      prev.current = null;
      radio.reset();
      sound.stopSteps();
    }
    if (!state) return;
    mapEvents(prev.current, state, sound, radio);
    prev.current = state;
  }, [state, run]);
  useEffect(() => () => sound.stopSteps(), []);
}
