import { useEffect, useRef, useState } from 'react';
import type { ActorId, DecisionRecord, Outcome, TaskId } from '@afterlink/protocol';

interface Props {
  name: string;
  decisions: DecisionRecord[];
  names: Record<ActorId, string>;
  titles: Record<TaskId, string>;
  onClose: () => void;
}

const WORDS: Record<Outcome, string> = {
  ACCEPTED: 'Took it',
  COMPLETED: 'Completed',
  DEFERRED: 'Held back',
  REFUSED: 'Refused',
  CONFLICTED: 'In conflict',
  UNKNOWN: 'Unknown',
};

export function WhyDialog({ name, decisions, names, titles, onClose }: Props) {
  const [picked, setPicked] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const d = decisions[picked];

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const who = (a: ActorId) => names[a] ?? 'Unknown device';

  return (
    <div className="st-whybox" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-whycard" role="dialog" aria-modal="true" aria-label={`Why ${name} decided this`}>
        <h2>{d ? (titles[d.taskId] ?? d.taskId) : name}</h2>
        {decisions.length > 1 && (
          <div className="st-why-picks">
            {decisions.slice(0, 8).map((x, i) => (
              <button key={x.id} aria-pressed={i === picked} onClick={() => setPicked(i)}>
                {titles[x.taskId] ?? x.taskId}
              </button>
            ))}
          </div>
        )}
        {d ? (
          <>
            <p>{d.reason}</p>
            <dl>
              <dt>Decided</dt>
              <dd>
                {name}: {WORDS[d.outcome]}
              </dd>
              <dt>Rule</dt>
              <dd>{d.policy}</dd>
              <dt>Could reach</dt>
              <dd>{d.reachable.length ? d.reachable.map(who).join(', ') : 'Nobody'}</dd>
              <dt>Knew up to</dt>
              <dd>
                {Object.entries(d.horizon)
                  .filter(([a]) => names[a])
                  .map(([a, seq]) => `${who(a)} #${seq}`)
                  .join(', ')}
              </dd>
              {d.tokens?.length ? (
                <>
                  <dt>Rights used</dt>
                  <dd>{d.tokens.join(', ')}</dd>
                </>
              ) : null}
            </dl>
          </>
        ) : (
          <p>No decision yet.</p>
        )}
        <button ref={closeRef} className="al-button al-button--secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
