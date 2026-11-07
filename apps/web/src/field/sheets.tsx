import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActorNode, ActorView } from '@afterlink/actor';
import type { FerryFrame, FerryPacket } from '@afterlink/protocol';
import { Sheet } from './Sheet';
import { api } from './ferryApi';
import { Cycler, Scanner } from './parts';
import { actorTeam, age, focus, knowledgeWords, noun, teamName } from './derive';

type P = { node: ActorNode; view: ActorView; onClose: () => void };

export function WhySheet({ view, onClose }: Omit<P, 'node'>) {
  const { task, refusal } = focus(view);
  const d = refusal ?? task?.decisions[task.decisions.length - 1] ?? view.lastDecision;
  return (
    <Sheet title="Why this?" onClose={onClose}>
      {!d ? (
        <p className="f-muted">No decision to explain yet.</p>
      ) : (
        <>
          <p className="f-lead">{d.reason}</p>
          <dl className="f-facts">
            <dt>Teams in contact</dt>
            <dd>
              {d.reachable.length === 0
                ? 'None, you were working alone'
                : d.reachable.map((a) => actorTeam(view, a)).join(', ')}
            </dd>
            {d.inputs.length > 0 && (
              <>
                <dt>What it relied on</dt>
                <dd>
                  <ul>
                    {d.inputs.map((i) => (
                      <li key={i.key}>
                        {i.key.replace(/[._]/g, ' ')}: {knowledgeWords[i.state]}, {age(i.ageMs)}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {d.candidates && d.candidates.length > 0 && (
              <>
                <dt>Who was considered</dt>
                <dd>
                  <ul>
                    {d.candidates.map((c) => (
                      <li key={c.actor}>
                        {teamName(view, c.team)}: {c.note}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </>
      )}
    </Sheet>
  );
}

export function CarrySheet({ node, onClose }: Omit<P, 'view'>) {
  const [frames, setFrames] = useState<FerryFrame[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.toFrames(node.buildFerry()).then(
      (f) => live && setFrames(f),
      () => live && setError('This update could not be prepared.'),
    );
    return () => { live = false; };
  }, [node]);

  return (
    <Sheet title="Carry update" onClose={onClose}>
      {error ? (
        <p className="f-error" role="alert">{error}</p>
      ) : !frames ? (
        <p className="f-muted" role="status">Preparing the update...</p>
      ) : (
        <Cycler frames={frames} label="Update code" onError={setError} />
      )}
    </Sheet>
  );
}

export function ScanSheet({ node, onClose }: Omit<P, 'view'>) {
  const asm = useRef<InstanceType<typeof api.FrameAssembler> | null>(null);
  const finished = useRef(false);
  const [progress, setProgress] = useState<{ have: number; total: number } | null>(null);
  const [result, setResult] = useState('');
  const [problem, setProblem] = useState('');

  const feed = useCallback(
    async (f: FerryFrame) => {
      if (finished.current) return;
      asm.current ??= new api.FrameAssembler();
      const p = asm.current.add(f);
      setProgress({ have: p.have, total: p.total });
      if (!asm.current.done) return;
      finished.current = true;
      try {
        const r = node.ingestFerry(await asm.current.packet());
        setResult(
          r.rejected > 0 && r.newEvents === 0
            ? 'This update was not accepted.'
            : r.newEvents > 0
              ? 'Update received.'
              : 'Already up to date.',
        );
      } catch {
        setProblem('That update was damaged. Try again.');
        finished.current = false;
        asm.current = null;
        setProgress(null);
      }
    },
    [node],
  );

  return (
    <Sheet title="Scan update" onClose={onClose}>
      {result ? (
        <p className="f-lead" role="status">{result}</p>
      ) : (
        <>
          <Scanner onFrame={feed} hint="Point at the code on the other phone." problem={problem} />
          {progress && <p className="f-lead f-center" role="status">{progress.have}/{progress.total}</p>}
        </>
      )}
    </Sheet>
  );
}

const KINDS = [
  { key: 'blocked', label: 'Path blocked' },
  { key: 'closed', label: 'Gate closed' },
  { key: 'help', label: 'Someone needs help' },
  { key: 'other', label: 'Something else' },
];

export function ReportSheet({ node, onClose }: Omit<P, 'view'>) {
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const send = () => {
    node.observe(`report.${kind}`, note.trim() || true);
    setSent(true);
  };
  return (
    <Sheet title="Report a problem" onClose={onClose}>
      {sent ? (
        <>
          <p className="f-lead" role="status">Recorded. Your team will see it as contact allows.</p>
          <button className="f-btn f-btn-quiet" onClick={onClose}>Close</button>
        </>
      ) : (
        <>
          <div className="f-choices" role="radiogroup" aria-label="What happened">
            {KINDS.map((k) => (
              <button key={k.key} role="radio" aria-checked={kind === k.key} className="f-choice" onClick={() => setKind(k.key)}>{k.label}</button>
            ))}
          </div>
          <label className="f-field">
            <span>Details (optional)</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="f-btn f-btn-primary" disabled={!kind} onClick={send}>Record</button>
        </>
      )}
    </Sheet>
  );
}

export function TransfersSheet({ node, view, onClose }: P) {
  const list = view.pendingTransfers;
  return (
    <Sheet title="Transfers" onClose={onClose}>
      {list.length === 0 ? (
        <p className="f-muted" role="status">Nothing is being passed to you.</p>
      ) : (
        <ul className="f-transfers">
          {list.map((t) => {
            const what = t.tokens.map((id) => noun(view, view.state.tokens[id]?.resource ?? id)).join(', ');
            return (
              <li key={String(t.transfer)}>
                <p className="f-lead">{actorTeam(view, t.from)} wants to pass you the {what}.</p>
                <div className="f-row">
                  <button className="f-btn f-btn-quiet" onClick={() => node.answerTransfer(t.transfer, false)}>Decline</button>
                  <button className="f-btn f-btn-primary" onClick={() => node.answerTransfer(t.transfer, true)}>Accept</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
