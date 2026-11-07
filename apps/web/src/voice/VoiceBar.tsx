import { useCallback, useEffect, useRef, useState } from 'react';
import type { DecisionRecord, MissionCapsule, MissionState, TaskRecord, TaskSpec } from '@afterlink/protocol';
import { specOf, useOnline, useVoiceBrief, useVoicePack } from './hooks.ts';
import { INTENT_LABEL, type Intent } from './intents.ts';
import { getVoicePack, type SpeakSource } from './pack.ts';
import { PHRASES, refusalSegments, taskBriefText } from './phrases.ts';
import { PushToTalk, TAP_INTENTS, type HeardVia } from './PushToTalk.tsx';
import './voice.css';

interface VoiceView {
  state: MissionState;
  nextAction: TaskRecord | null;
  lastDecision: DecisionRecord | null;
}

/** The slice of ActorNode the voice bar drives. */
export interface VoiceActor {
  team: string;
  acceptTask(id: string, via?: 'tap' | 'voice' | 'auto'): void;
  declineTask(id: string, reason: string): void;
  completeTask(id: string, evidence: string, via?: 'tap' | 'voice' | 'auto'): void;
  view(): VoiceView;
  subscribe(fn: (v: VoiceView) => void): () => void;
}

export interface VoiceBarProps {
  task: TaskSpec | TaskRecord;
  actor: VoiceActor;
  /** Defaults to the browser's connection state. */
  online?: boolean;
  /** Pre-synthesise the whole mission pack while online. Defaults to the capsule in the actor's state. */
  capsule?: MissionCapsule | null;
  baseUrl?: string;
}

const SOURCE_LABEL: Record<SpeakSource, string> = {
  cached: 'Cached audio',
  live: 'Live audio',
  captioned: 'Captions only',
};

export function VoiceBar({ task, actor, online: onlineProp, capsule, baseUrl }: VoiceBarProps) {
  const detected = useOnline();
  const online = onlineProp ?? detected;
  const spec = specOf(task);
  const team = actor.team;
  const pack = getVoicePack();
  const cap = capsule === undefined ? actor.view().state.capsule : capsule;
  const progress = useVoicePack(cap, team, online, pack);
  const brief = useVoiceBrief(task, online, team, pack);
  const [spoken, setSpoken] = useState<{ text: string; source: SpeakSource } | null>(null);

  const say = useCallback(
    async (parts: string | string[]) => {
      const list = Array.isArray(parts) ? parts : [parts];
      const r = await pack.speakSequence(list, team, online);
      setSpoken({ text: r.caption, source: r.source });
    },
    [pack, team, online],
  );

  const act = useCallback(
    (intent: Intent, via: HeardVia) => {
      const mode = via === 'voice' ? 'voice' : 'tap';
      if (intent === 'accept') {
        actor.acceptTask(spec.id, mode);
        void say(PHRASES.accepted);
      } else if (intent === 'complete') {
        actor.completeTask(spec.id, mode === 'voice' ? 'Reported complete by voice' : 'Reported complete', mode);
        void say(PHRASES.completed);
      } else if (intent === 'cannot') {
        actor.declineTask(spec.id, 'Volunteer cannot do this task');
        void say(PHRASES.declined);
      } else {
        const next = actor.view().nextAction;
        void say(next ? taskBriefText(next.spec) : PHRASES.nothingNext);
      }
    },
    [actor, spec.id, say],
  );

  const notice = useCallback(
    (text: string, kind: 'confirm' | 'cancelled' | 'not-heard') => {
      if (kind === 'confirm') {
        void say(text === 'accept' ? PHRASES.confirmAccept : text === 'complete' ? PHRASES.confirmComplete : PHRASES.confirmDecline);
      } else void say(kind === 'cancelled' ? PHRASES.cancelled : PHRASES.notHeard);
    },
    [say],
  );

  const wasOnline = useRef(online);
  useEffect(() => {
    if (wasOnline.current !== online) void say(online ? PHRASES.networkBack : PHRASES.networkLost);
    wasOnline.current = online;
  }, [online, say]);

  const lastRefusal = useRef<string | null>(null);
  useEffect(() => {
    return actor.subscribe((v) => {
      const d = v.lastDecision;
      if (!d || d.outcome !== 'REFUSED' || d.taskId !== spec.id || !d.refusal || lastRefusal.current === d.id) return;
      lastRefusal.current = d.id;
      let teamName: string | undefined;
      let resource: string | undefined;
      if (d.refusal === 'NO_RIGHT') {
        resource = spec.needs[0]?.resource;
        const holder = Object.values(v.state.tokens).find((t) => t.resource === resource && t.holderTeam !== team)?.holderTeam;
        teamName = v.state.capsule?.teams.find((t) => t.id === holder)?.name ?? holder;
      }
      void say(refusalSegments(d.refusal, { resource, team: teamName }));
    });
  }, [actor, spec.id, spec.needs, team, say]);

  const caption = spoken?.text ?? brief.caption;
  const source = spoken?.source ?? brief.source;
  const audioLabel = source
    ? SOURCE_LABEL[source]
    : brief.canPlay
      ? ''
      : 'No audio offline. Read the caption.';

  return (
    <section className="vo-bar" aria-label="Voice">
      <p className="vo-caption" aria-live="polite">
        {caption}
      </p>
      {audioLabel && (
        <p className="vo-source" data-source={source ?? 'none'}>
          {audioLabel}
        </p>
      )}
      <div className="vo-row">
        <button
          type="button"
          className="vo-primary"
          disabled={!brief.canPlay && brief.status !== 'loading'}
          onClick={() => {
            if (brief.status === 'loading') return brief.stop();
            setSpoken(null);
            brief.play();
          }}
        >
          {brief.status === 'loading' ? 'Stop' : 'Hear brief'}
        </button>
      </div>
      <PushToTalk online={online} subject={spec.title} baseUrl={baseUrl} onIntent={act} onNotice={notice} />
      <div className="vo-row" role="group" aria-label="Respond without voice">
        {TAP_INTENTS.map((i) => (
          <button key={i} type="button" onClick={() => act(i, 'tap')}>
            {INTENT_LABEL[i]}
          </button>
        ))}
      </div>
    </section>
  );
}
