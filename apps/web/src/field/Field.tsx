import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ActorNode, ActorView } from '@afterlink/actor';
import type { ProvisionBundle } from '@afterlink/protocol';
import './field.css';
import { VoiceBar } from '../voice';
import { loadStoredBundle } from '../device/provisionLink';
import { ReconnectSheet } from './reconnect';
import { CarrySheet, ReportSheet, ScanSheet, TransfersSheet, WhySheet } from './sheets';
import { announce, clock, connection, focus, lastHeard, nextStep, rights } from './derive';

type SheetName = 'why' | 'carry' | 'scan' | 'report' | 'transfers' | 'reconnect' | null;

function useView(node: ActorNode): ActorView {
  const cache = useRef<ActorView>(node.view());
  return useSyncExternalStore(
    (cb) =>
      node.subscribe((v) => {
        cache.current = v;
        cb();
      }),
    () => cache.current,
  );
}

const PinIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 14.5s4.5-4.2 4.5-7.7a4.5 4.5 0 10-9 0C3.5 10.3 8 14.5 8 14.5z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="8" cy="6.6" r="1.6" fill="currentColor" />
  </svg>
);

export function Field({ actor, compact = false, bundle }: { actor: ActorNode; compact?: boolean; bundle?: ProvisionBundle }) {
  const keys = useMemo(() => bundle ?? loadStoredBundle()?.bundle ?? null, [bundle]);
  const view = useView(actor);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [busy, setBusy] = useState(false);
  const conn = connection(view);
  const heard = lastHeard(view);
  const { task, refusal } = focus(view);
  const step = refusal && task ? nextStep(view, refusal, task) : null;
  const held = rights(view);
  const transfers = view.pendingTransfers.length;
  const live = announce(view);
  const taskKey = `${task?.spec.id ?? ''}:${task?.status ?? ''}`;

  useEffect(() => setBusy(false), [taskKey]);

  const accept = () => {
    if (!task) return;
    setBusy(true);
    actor.acceptTask(task.spec.id, 'tap');
  };
  const done = () => {
    if (!task) return;
    setBusy(true);
    actor.completeTask(task.spec.id, 'Marked done by volunteer', 'tap');
  };
  const decline = () => task && actor.declineTask(task.spec.id, 'Declined by volunteer');
  const ask = (resource: string) => {
    if (!task) return;
    actor.requestTransfer(resource, task.spec.id);
  };

  const status = task?.status;
  const primary =
    !refusal && task && status === 'accepted' ? 'Done' : !refusal && task && status === 'claimed' ? 'Accept' : null;

  return (
    <div className={`field${compact ? ' compact' : ''}`} data-conn={conn}>
      <div className="f-live" aria-live="polite" role="status">{live}</div>

      <header className="f-top">
        <h1 className="f-team">{view.self.name}</h1>
        <p className="f-conn" aria-label={`Connection: ${conn}`}>
          <span className="f-dot" aria-hidden="true" />
          {conn}
        </p>
      </header>
      {conn !== 'Connected' && heard && <p className="f-heard">Last heard {clock(heard)}</p>}

      <main className="f-main">
        {task ? (
          <>
            {(refusal || status === 'accepted') && <p className="f-eyebrow">{refusal ? 'Not started' : 'In progress'}</p>}
            <h2 className="f-title">{task.spec.title}</h2>
            <p className="f-where"><PinIcon /> {task.spec.locationName}</p>
            {refusal && (
              <div className="f-refusal" role="group" aria-label="Why this cannot start">
                <p>{refusal.reason}</p>
                {step?.hint && <p className="f-hint">{step.hint}</p>}
              </div>
            )}
          </>
        ) : (
          <>
            <h2 className="f-title f-idle">Nothing to do</h2>
          </>
        )}
      </main>

      {held.length > 0 && (
        <ul className="f-rights" aria-label="Rights you hold">
          {held.map((r) => (
            <li key={r.resource + r.passing} className={r.passing ? 'passing' : ''}>
              {r.label.charAt(0).toUpperCase() + r.label.slice(1)}{r.count > 1 ? ` ×${r.count}` : ''}{r.passing ? ' (passing on)' : ''}
            </li>
          ))}
        </ul>
      )}

      {task && <VoiceBar key={task.spec.id} task={task} actor={actor} />}

      <div className="f-actions">
        {primary && (
          <button className="f-btn f-btn-primary f-big" onClick={primary === 'Done' ? done : accept} disabled={busy}>
            {primary}
          </button>
        )}
        {primary === 'Accept' && (
          <button className="f-link" onClick={decline}>Can't do this</button>
        )}
        {step?.kind === 'ask' && step.resource && (
          <button className="f-btn f-btn-primary f-big" onClick={() => ask(step.resource!)}>{step.label}</button>
        )}
        {step?.kind === 'carry' && (
          <button className="f-btn f-btn-primary f-big" onClick={() => setSheet('carry')}>{step.label}</button>
        )}
      </div>

      <nav className="f-menu" aria-label="More">
        <button onClick={() => setSheet('why')} disabled={!task && !view.lastDecision}>Why this?</button>
        <button onClick={() => setSheet('carry')}>Carry update</button>
        <button onClick={() => setSheet('scan')}>Scan update</button>
        {keys && <button onClick={() => setSheet('reconnect')}>Reconnect by QR</button>}
        <button onClick={() => setSheet('report')}>Report a problem</button>
        <button onClick={() => setSheet('transfers')} className={transfers ? 'alert' : ''}>
          Transfers{transfers ? <span className="f-badge" aria-label={`${transfers} waiting`}>{transfers}</span> : null}
        </button>
      </nav>

      {sheet === 'why' && <WhySheet view={view} onClose={() => setSheet(null)} />}
      {sheet === 'carry' && <CarrySheet node={actor} onClose={() => setSheet(null)} />}
      {sheet === 'scan' && <ScanSheet node={actor} onClose={() => setSheet(null)} />}
      {sheet === 'reconnect' && keys && <ReconnectSheet node={actor} bundle={keys} onClose={() => setSheet(null)} />}
      {sheet === 'report' && <ReportSheet node={actor} onClose={() => setSheet(null)} />}
      {sheet === 'transfers' && <TransfersSheet node={actor} view={view} onClose={() => setSheet(null)} />}
    </div>
  );
}
