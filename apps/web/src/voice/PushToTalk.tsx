import { useCallback, useEffect, useRef, useState } from 'react';
import { CONSEQUENTIAL, INTENT_LABEL, parseUtterance, type Intent } from './intents.ts';
import './voice.css';

export type HeardVia = 'voice' | 'tap';

export interface PushToTalkProps {
  online: boolean;
  /** Short name of what a commitment applies to, shown in the confirmation. */
  subject?: string;
  baseUrl?: string;
  /** Called for every intent. Consequential voice intents arrive only after the volunteer confirms. */
  onIntent(intent: Intent, via: HeardVia): void;
  /** Called with plain-language status for captions and speech. */
  onNotice?(text: string, kind: 'confirm' | 'cancelled' | 'not-heard'): void;
}

type Phase = 'idle' | 'listening' | 'transcribing' | 'confirming';
type Mode = 'cloud' | 'device' | 'tap';

interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Recognition) | null;
}

const CONFIRM_TEXT: Record<Intent, string> = {
  accept: 'Accept',
  complete: 'Mark complete',
  cannot: "Mark as can't do",
  next: '',
};

export function PushToTalk({ online, subject, baseUrl = '', onIntent, onNotice }: PushToTalkProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<Intent | null>(null);
  const pendingRef = useRef<Intent | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const recog = useRef<Recognition | null>(null);
  const heard = useRef('');
  const holding = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const hasMic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const Rec = typeof window === 'undefined' ? null : recognitionCtor();
  const mode: Mode = online && hasMic ? 'cloud' : Rec ? 'device' : 'tap';
  const modeNote: Record<Mode, string> = {
    cloud: 'Speech is sent to ElevenLabs for transcription.',
    device: 'Offline: using this device’s speech recognition.',
    tap: 'Voice input is not available offline on this device.',
  };

  const setPendingIntent = (i: Intent | null) => {
    pendingRef.current = i;
    setPending(i);
  };

  const clearPending = useCallback(() => {
    clearTimeout(timer.current);
    pendingRef.current = null;
    setPending(null);
    setPhase('idle');
  }, []);

  const handleText = useCallback(
    (text: string) => {
      const waiting = pendingRef.current;
      const parsed = parseUtterance(text, waiting !== null);
      if (parsed.kind === 'reply' && waiting) {
        clearPending();
        if (parsed.reply === 'yes') onIntent(waiting, 'voice');
        else {
          setMessage('Cancelled.');
          onNotice?.('Cancelled.', 'cancelled');
        }
        return;
      }
      if (parsed.kind === 'intent') {
        if (CONSEQUENTIAL.includes(parsed.intent)) {
          setPendingIntent(parsed.intent);
          setPhase('confirming');
          setMessage(`“${text.trim()}”`);
          onNotice?.(parsed.intent, 'confirm');
          clearTimeout(timer.current);
          timer.current = setTimeout(clearPending, 20000);
        } else {
          setPhase('idle');
          setMessage(`“${text.trim()}”`);
          onIntent(parsed.intent, 'voice');
        }
        return;
      }
      setPhase(waiting ? 'confirming' : 'idle');
      setMessage(text.trim() ? `“${text.trim()}”: no matching action.` : 'Nothing heard.');
      onNotice?.('not-heard', 'not-heard');
    },
    [clearPending, onIntent, onNotice],
  );

  const transcribe = useCallback(
    async (blob: Blob) => {
      setPhase('transcribing');
      try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/voice/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': blob.type || 'audio/webm' },
          body: blob,
        });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as { text?: string };
        handleText(json.text ?? '');
      } catch {
        setPhase(pendingRef.current ? 'confirming' : 'idle');
        setMessage('Transcription unavailable.');
      }
    },
    [baseUrl, handleText],
  );

  const begin = useCallback(async () => {
    if (holding.current || mode === 'tap') return;
    holding.current = true;
    setMessage('');
    if (mode === 'cloud') {
      try {
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        holding.current = false;
        setMessage('Microphone access was refused.');
        return;
      }
      if (!holding.current) {
        stream.current.getTracks().forEach((t) => t.stop());
        return;
      }
      chunks.current = [];
      const r = new MediaRecorder(stream.current);
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.current?.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        if (blob.size > 0) void transcribe(blob);
        else setPhase(pendingRef.current ? 'confirming' : 'idle');
      };
      recorder.current = r;
      r.start();
      setPhase('listening');
      return;
    }
    const rec = new Rec!();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    if ('processLocally' in rec) rec.processLocally = true;
    heard.current = '';
    rec.onresult = (e) => {
      heard.current = Array.from(e.results).map((r) => r[0]?.transcript ?? '').join(' ');
    };
    rec.onerror = (e) => {
      holding.current = false;
      setPhase(pendingRef.current ? 'confirming' : 'idle');
      setMessage(
        e.error === 'not-allowed'
          ? 'Microphone access was refused.'
          : 'On-device speech recognition did not work offline.',
      );
      rec.onend = null;
    };
    rec.onend = () => {
      holding.current = false;
      if (heard.current) handleText(heard.current);
      else {
        setPhase(pendingRef.current ? 'confirming' : 'idle');
        setMessage('Nothing heard.');
      }
    };
    recog.current = rec;
    try {
      rec.start();
      setPhase('listening');
    } catch {
      holding.current = false;
      setMessage('On-device speech recognition could not start.');
    }
  }, [mode, Rec, transcribe, handleText]);

  const end = useCallback(() => {
    if (!holding.current) return;
    holding.current = false;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    else if (recog.current) recog.current.stop();
    else stream.current?.getTracks().forEach((t) => t.stop());
  }, []);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      recog.current?.abort();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const label = phase === 'listening' ? 'Listening' : phase === 'transcribing' ? 'Working' : 'Hold to speak';

  return (
    <div className="vo-ptt">
      <button
        type="button"
        className="vo-hold"
        data-phase={phase}
        disabled={mode === 'tap' || phase === 'transcribing'}
        aria-pressed={phase === 'listening'}
        aria-describedby="vo-ptt-note"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          void begin();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            void begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') end();
        }}
        onBlur={end}
        onContextMenu={(e) => e.preventDefault()}
      >
        {label}
      </button>
      <p id="vo-ptt-note" className={mode === 'tap' ? 'vo-note' : 'vo-sr'}>
        {modeNote[mode]}
      </p>
      {phase === 'confirming' && pending && (
        <div className="vo-confirm" role="alertdialog" aria-label="Confirm">
          <p>
            {CONFIRM_TEXT[pending]}
            {subject ? ` “${subject}”` : ''}?
          </p>
          <div className="vo-row">
            <button
              type="button"
              className="vo-primary"
              autoFocus
              onClick={() => {
                const i = pending;
                clearPending();
                onIntent(i, 'voice');
              }}
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => {
                clearPending();
                setMessage('Cancelled.');
                onNotice?.('Cancelled.', 'cancelled');
              }}
            >
              No
            </button>
          </div>
        </div>
      )}
      <p className="vo-heard" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}

export const TAP_INTENTS: Intent[] = ['accept', 'complete', 'cannot', 'next'];
export { INTENT_LABEL };
