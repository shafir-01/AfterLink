import { Button } from '../ui/Button';
import { RUN_LENGTHS } from './engine';
import type { Play } from './usePlay';
import './play.css';

const clock = (ms: number) => {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function Entry({ play }: { play: Play }) {
  const next = RUN_LENGTHS[(RUN_LENGTHS.indexOf(play.seconds) + 1) % RUN_LENGTHS.length]!;
  return (
    <div className="pl-entry">
      {play.failure && <p role="alert">{play.failure}</p>}
      <div className="pl-entry-row">
        <Button variant="secondary" onClick={() => play.begin()}>
          {play.challenge ? `Beat ${play.challenge.score}` : 'Try to stop them'}
        </Button>
        <button className="pl-length" onClick={() => play.setSeconds(next)} aria-label={`Run length ${play.seconds} seconds. Change to ${next}.`}>
          {play.seconds}s
        </button>
      </div>
    </div>
  );
}

export function PlayHud({ play }: { play: Play }) {
  if (play.phase === 'idle') return <Entry play={play} />;
  if (play.phase === 'ended') return null;
  const { finished, refused, cuts } = play.counters;
  const running = play.phase === 'running';
  return (
    <section className="pl-hud" aria-label="Free play">
      <div className="pl-bar">
        <h2 className="pl-title">You are the outage</h2>
        <p className="pl-clock" role="timer" aria-label={`${Math.ceil(play.leftMs / 1000)} seconds left`}>
          {clock(play.leftMs)}
        </p>
        <dl className="pl-counts">
          <div>
            <dd>{finished}</dd>
            <dt>Tasks finished</dt>
          </div>
          <div>
            <dd>{refused}</dd>
            <dt>Unsafe promises refused</dt>
          </div>
          <div>
            <dd>{cuts}</dd>
            <dt>Links cut</dt>
          </div>
        </dl>
      </div>
      {running && (
        <ul className="pl-dares" aria-label="Dares">
          {play.dares.map((dare) => (
            <li key={dare.id}>
              <button className="pl-dare" data-status={dare.status} onClick={() => play.arm(dare.id)} disabled={dare.status !== 'open'}>
                {dare.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="pl-note" role="status" aria-live="polite">
        {play.phase === 'starting' ? 'Teams connecting' : play.phase === 'collecting' ? 'Time. Reading every device’s log.' : play.note}
      </p>
      {running && (
        <button className="pl-end-now" onClick={play.finishNow}>
          End run
        </button>
      )}
    </section>
  );
}
