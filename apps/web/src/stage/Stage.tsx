import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ActorId } from '@afterlink/protocol';
import { Courier } from './Courier';
import { Director, type Mark } from './director';
import { HqBadge } from './HqBadge';
import { Scene } from './scene';
import { labelFor } from './story';
import { Theatre } from './Theatre';
import { WhyDialog } from './WhyDialog';
import './stage.css';

const HEADLINE = 'The mission continues, even when the network doesn’t.';

function Tag({ mark, onWhy }: { mark: Mark; onWhy?: () => void }) {
  return (
    <p className="st-tag" data-tone={mark.tone}>
      {mark.text}
      {onWhy && (
        <button onClick={onWhy} aria-label={`Why: ${mark.text}`}>
          Why?
        </button>
      )}
    </p>
  );
}

export function Stage() {
  const director = useMemo(() => new Director(), []);
  const scene = useMemo(() => new Scene(), []);
  const snap = useSyncExternalStore(director.subscribe, director.snapshot);
  const [why, setWhy] = useState<ActorId | null>(null);

  useEffect(() => {
    director.pulses = { peer: (a, b) => scene.pulsePeer(a, b), hq: (a) => scene.pulseHq(a) };
    director.start();
    return () => director.stop();
  }, [director, scene]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || why) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select')) return;
      e.preventDefault();
      director.advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [director, why]);

  const bind = useCallback((id: ActorId, el: HTMLIFrameElement | null) => director.attach(id, el), [director]);
  const closeWhy = useCallback(() => setWhy(null), []);

  const devices = useMemo(() => snap.seats.map((s) => ({ id: s.id, name: s.name, src: s.src, signalUp: s.signalUp })), [snap.seats]);
  const names = useMemo(() => Object.fromEntries(snap.seats.map((s) => [s.id, s.name])), [snap.seats]);
  const whoFor = snap.seats.find((s) => s.id === why);
  const label = snap.error ? 'Restart' : snap.ready ? labelFor(snap.step, snap.resource) : 'Teams connecting';
  const line = snap.error ?? snap.line;

  const overlay = (id: ActorId) => {
    const mark = snap.marks[id];
    const seat = snap.seats.find((s) => s.id === id);
    const decided = (snap.decisions[id]?.length ?? 0) > 0;
    const verdict = mark?.tone === 'refused' || mark?.tone === 'granted';
    return (
      <>
        {mark && <Tag mark={mark} onWhy={decided && verdict ? () => setWhy(id) : undefined} />}
        {decided && !verdict && (
          <button className="st-why" onClick={() => setWhy(id)} aria-label={`Why did ${seat?.name} decide this?`}>
            Why?
          </button>
        )}
      </>
    );
  };

  return (
    <main className="st">
      <header className="st-head">
        <p className="st-mission">{snap.mission && `${snap.mission}: ${snap.objective}`}</p>
        <h1 className="st-title">{HEADLINE}</h1>
      </header>

      <HqBadge hq={snap.hq} />

      <Theatre devices={devices} pairs={snap.pairs} groups={snap.groups} scene={scene} bind={bind} overlay={overlay} marks={snap.marks}>
        {snap.carry && snap.carry.phase !== 'done' && snap.carry.phase !== 'failed' && <Courier director={director} scene={scene} carry={snap.carry} />}
      </Theatre>

      <footer className="st-foot">
        <p className="st-counters">
          <span>
            Done <b>{snap.done}</b>
          </span>
          <span>
            Refused <b>{snap.refused}</b>
          </span>
        </p>
        <div className="st-action">
          <button className="st-primary" onClick={snap.error ? () => director.start() : director.advance} disabled={!snap.error && (!snap.ready || snap.busy)}>
            {label}
          </button>
          <p className="st-line" role="status" aria-live="polite">
            {line}
          </p>
        </div>
        <nav className="st-aside" aria-label="More">
          <button onClick={() => director.start()}>Restart</button>
          <a href="#/lead">Use real phones</a>
        </nav>
      </footer>

      {whoFor && <WhyDialog name={whoFor.name} decisions={snap.decisions[whoFor.id] ?? []} names={names} titles={snap.titles} onClose={closeWhy} />}
    </main>
  );
}

export default Stage;
