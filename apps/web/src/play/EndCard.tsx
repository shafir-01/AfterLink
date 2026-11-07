import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { navigate } from '../ui/route';
import { shareRun, shareUrl, type Shared } from './score';
import type { Play } from './usePlay';
import './play.css';

function ShareButton({ seed, score }: { seed: string; score: number }) {
  const [state, setState] = useState<Shared | null>(null);
  if (state === 'failed') {
    return <input className="pl-link" readOnly value={shareUrl({ seed, score })} aria-label="Link to this run" onFocus={(e) => e.currentTarget.select()} autoFocus />;
  }
  return <Button onClick={() => void shareRun({ seed, score }).then(setState)}>{state === 'copied' ? 'Link copied' : 'Share'}</Button>;
}

export function EndCard({ play }: { play: Play }) {
  if (play.phase !== 'ended' || !play.end) return null;
  return <Card play={play} />;
}

function Card({ play }: { play: Play }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const end = play.end!;
  const { challenge, best, newBest, dismiss } = play;

  useLayoutEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      dismiss();
    };
    el.addEventListener('cancel', cancel);
    return () => el.removeEventListener('cancel', cancel);
  }, [dismiss]);

  const settled = play.dares.filter((d) => d.status === 'done');

  return (
    <dialog ref={dialog} className="pl-card" aria-labelledby={titleId}>
      <h2 id={titleId} className="pl-line">
        {end.line}
      </h2>
      {end.recorded && (
        <p className="pl-tally">
          Stopped <b>{end.stopped}</b> of {end.raised}
          {newBest ? <span>New best</span> : best && <span>Best {best.score}</span>}
          {challenge && <span>{end.stopped > challenge.score ? `You beat ${challenge.score}` : `${challenge.score} stands`}</span>}
        </p>
      )}
      {settled.length > 0 && (
        <ul className="pl-settled">
          {settled.map((dare) => (
            <li key={dare.id}>
              <b>{dare.outcome}</b> {dare.why}
            </li>
          ))}
        </ul>
      )}
      <div className="pl-actions">
        {end.recorded && (
          <Button variant="primary" onClick={() => navigate('/debrief')}>
            See what happened
          </Button>
        )}
        {end.recorded && <Button onClick={() => navigate('/verify')}>Verify it yourself</Button>}
        <Button onClick={() => play.begin()}>Play again</Button>
        {end.recorded && play.seed && <ShareButton seed={play.seed} score={end.stopped} />}
      </div>
    </dialog>
  );
}
