import { useCallback, useEffect, useRef, useState } from 'react';
import type { MissionCapsule, TaskRecord, TaskSpec } from '@afterlink/protocol';
import { getVoicePack, type PackProgress, type SpeakSource, type VoicePack } from './pack.ts';
import { taskBriefText } from './phrases.ts';

export type BriefStatus = 'idle' | 'loading' | 'done' | 'captioned';

export interface VoiceBrief {
  caption: string;
  status: BriefStatus;
  /** Where the last played audio came from. Null until something has played. */
  source: SpeakSource | null;
  /** Whether audio exists for this brief right now: cached on the device, or fetchable while online. */
  canPlay: boolean;
  play(): void;
  stop(): void;
}

export const specOf = (t: TaskSpec | TaskRecord): TaskSpec => ('spec' in t ? t.spec : t);

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useVoiceBrief(task: TaskSpec | TaskRecord | null, online: boolean, team = 'system', pack: VoicePack = getVoicePack()): VoiceBrief {
  const spec = task ? specOf(task) : null;
  const caption = spec ? taskBriefText(spec) : '';
  const [status, setStatus] = useState<BriefStatus>('idle');
  const [source, setSource] = useState<SpeakSource | null>(null);
  const [cached, setCached] = useState(false);
  const token = useRef(0);

  useEffect(() => {
    token.current++;
    setStatus('idle');
    setSource(null);
  }, [caption]);

  useEffect(() => {
    let live = true;
    if (!caption) return setCached(false), undefined;
    pack.has(caption, team).then((h) => live && setCached(h));
    return () => {
      live = false;
    };
  }, [pack, caption, team, status]);

  const play = useCallback(() => {
    if (!caption) return;
    const mine = ++token.current;
    setStatus('loading');
    pack.speak(caption, team, online).then((r) => {
      if (mine !== token.current) return;
      setSource(r.source);
      setStatus(r.source === 'captioned' ? 'captioned' : 'done');
    });
  }, [pack, caption, team, online]);

  const stop = useCallback(() => {
    token.current++;
    pack.stop();
    setStatus('idle');
  }, [pack]);

  return { caption, status, source, canPlay: cached || online, play, stop };
}

export function useVoicePack(capsule: MissionCapsule | null, team: string, online: boolean, pack: VoicePack = getVoicePack()) {
  const [progress, setProgress] = useState<PackProgress | null>(null);
  const ran = useRef('');
  useEffect(() => {
    if (!capsule || !online) return;
    const id = `${capsule.id}:${capsule.version}:${team}`;
    if (ran.current === id) return;
    ran.current = id;
    pack.prepare(capsule, team, true, setProgress).then((p) => {
      if (p.failed > 0) ran.current = '';
    });
  }, [capsule, team, online, pack]);
  return progress;
}
