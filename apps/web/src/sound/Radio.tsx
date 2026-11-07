import { useSyncExternalStore } from 'react';
import { radio } from './radio.ts';
import { useSound } from './hooks.ts';
import './sound.css';

/** Caption strip for radio lines, with the mute toggle. Cached clips are labelled Recorded. */
export function Radio({ className = '' }: { className?: string }) {
  const now = useSyncExternalStore(radio.subscribe, radio.getNow, () => null);
  const { muted, toggle } = useSound();
  return (
    <div className={`radio ${className}`.trim()}>
      <div className="radio-line" role="status" aria-live="polite">
        {now ? (
          <>
            <span className="radio-dot" style={{ background: `var(--team-${now.team}, var(--accent, currentColor))` }} aria-hidden="true" />
            <span className="radio-text">{now.text}</span>
            <span className="radio-tag">{now.mode === 'recorded' ? 'Recorded' : 'Caption'}</span>
          </>
        ) : null}
      </div>
      <button type="button" className="radio-mute" onClick={toggle} aria-pressed={muted} aria-label={muted ? 'Unmute sound' : 'Mute sound'}>
        {muted ? 'Sound off' : 'Sound on'}
      </button>
    </div>
  );
}
