import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PlayController } from './contract';
import type { DareId } from './dares';
import { PlayEngine, type PlaySnapshot } from './engine';

export interface Play extends PlaySnapshot {
  /** Starts a run on a new mission. Pass a seed to replay it. */
  begin(seed?: string): void;
  arm(id: DareId): void;
  finishNow(): void;
  dismiss(): void;
  setSeconds(seconds: number): void;
}

export function usePlay(controller: PlayController): Play {
  const engine = useMemo(() => new PlayEngine(controller), [controller]);
  useEffect(() => () => engine.dispose(), [engine]);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.snapshot);
  return useMemo(
    () => ({ ...snapshot, begin: engine.begin, arm: engine.arm, finishNow: engine.finishNow, dismiss: engine.dismiss, setSeconds: engine.setSeconds }),
    [snapshot, engine],
  );
}
