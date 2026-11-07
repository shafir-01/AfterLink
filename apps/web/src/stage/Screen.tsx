import { Suspense, useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import type { ActorId } from '@afterlink/protocol';
import { Radio, useSoundEvents } from '../sound';
import { ViewBoundary } from '../ui/guarded';
import type { WorldController } from '../world/contract';
import type { StageDevice, StageMark } from './contract';
import type { MissionController } from './controller';
import { Courier } from './Courier';
import { HqBadge } from './HqBadge';
import { Scene } from './scene';
import { Theatre } from './Theatre';
import { WhyDialog } from './WhyDialog';
import './stage.css';

const HEADLINE = 'The mission continues, even when the network doesn’t.';

export type WorldView = ComponentType<{ controller: WorldController }>;

interface ScreenProps {
  controller: MissionController;
  /** The map, when this build has one. Otherwise devices stand in a row. */
  World?: LazyExoticComponent<WorldView> | null;
  /** Replaces the iframes when devices are real phones elsewhere. */
  card?: (seat: StageDevice) => ReactNode;
  switchTo: { href: string; label: string };
  /** Shown on the big button until the mission is live. */
  waiting?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Tag({ name, mark, onWhy }: { name: string; mark: StageMark; onWhy?: () => void }) {
  return (
    <p className="st-tag" data-tone={mark.tone}>
      {mark.text}
      {onWhy && (
        <button onClick={onWhy} aria-label={`Why ${name} got this outcome`}>
          Why?
        </button>
      )}
    </p>
  );
}

export function Screen({ controller, World, card, switchTo, waiting: waitingLabel }: ScreenProps) {
  const scene = useMemo(() => new Scene(), []);
  const snap = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const primary = useRef<HTMLButtonElement>(null);
  useSoundEvents(snap, snap.run);

  useEffect(() => {
    const off = controller.onPulse((p) => (p.kind === 'peer' ? scene.pulsePeer(p.from, p.to) : scene.pulseHq(p.from)));
    controller.start();
    return () => {
      off();
      controller.stop();
    };
  }, [controller, scene]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || controller.snapshot().why) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('button, a, input, textarea, select')) return;
      e.preventDefault();
      controller.advance();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  const bind = useCallback((id: ActorId, el: HTMLIFrameElement | null) => controller.attach(id, el), [controller]);
  const closeWhy = useCallback(() => {
    controller.closeWhy();
    primary.current?.focus();
  }, [controller]);

  const devices = useMemo(() => snap.seats.map((s) => ({ id: s.id, name: s.name, src: s.src, signalUp: s.signalUp })), [snap.seats]);
  const names = useMemo(() => Object.fromEntries(snap.seats.map((s) => [s.id, s.name])), [snap.seats]);
  const titles = useMemo(() => Object.fromEntries(snap.truth.tasks.map((t) => [t.id, t.title])), [snap.truth.tasks]);

  const failed = snap.phase === 'failed';
  const label = failed ? 'Restart' : snap.ready ? snap.story.label : (waitingLabel ?? 'Teams connecting');
  const busy = !failed && (!snap.ready || snap.story.busy);
  const safe = snap.score.violations === 0 ? 'and never promised a right twice' : `and ${plural(snap.score.violations, 'violation', 'violations')} surfaced`;
  const ending = snap.story.finished ? `You cut ${plural(snap.score.linksCut, 'link', 'links')}. They finished ${plural(snap.score.tasksFinished, 'task', 'tasks')} ${safe}.` : null;
  const line = snap.error ?? ending ?? snap.story.line;
  const whoFor = snap.seats.find((s) => s.id === snap.why);
  const verdict = snap.seats.find((s) => snap.marks[s.id]?.tone === 'refused' && s.decisions.length > 0);

  const overlay = (id: ActorId) => {
    const seat = snap.seats.find((s) => s.id === id);
    const mark = snap.marks[id];
    const decided = (seat?.decisions.length ?? 0) > 0;
    const judged = mark?.tone === 'refused' || mark?.tone === 'granted';
    return (
      <>
        {mark && <Tag name={seat?.name ?? ''} mark={mark} onWhy={decided && judged ? () => controller.openWhy(id) : undefined} />}
        {decided && !judged && (
          <button className="st-why" onClick={() => controller.openWhy(id)} aria-label={`Why ${seat?.name} decided this`}>
            Why?
          </button>
        )}
      </>
    );
  };

  return (
    <main className="st" aria-label="Mission" data-world={World ? 'true' : undefined}>
      <header className="st-head">
        <p className="st-mission">{snap.capsule && `${snap.capsule.name}: ${snap.capsule.objective}`}</p>
        <h1 className="st-title">{HEADLINE}</h1>
      </header>

      <footer className="st-foot">
        <p className="st-counters">
          <span>
            Finished <b>{snap.score.tasksFinished}</b>
          </span>
          <span>
            Refused <b>{snap.score.unsafeRefused}</b>
          </span>
          <span>
            Cut <b>{snap.score.linksCut}</b>
          </span>
        </p>
        <div className="st-action">
          <button
            ref={primary}
            className="st-primary"
            aria-disabled={busy}
            onClick={() => {
              if (failed) controller.restart();
              else if (!busy) controller.advance();
            }}
          >
            {label}
          </button>
          <p className="st-line" role="status" aria-live="polite">
            {line}
            {verdict && World && (
              <button className="st-line-why" onClick={() => controller.openWhy(verdict.id)} aria-label={`Why ${verdict.name} refused`}>
                Why?
              </button>
            )}
          </p>
        </div>
        <nav className="st-aside" aria-label="More">
          <Radio />
          <button onClick={controller.restart}>Restart</button>
          <a href={switchTo.href}>{switchTo.label}</a>
        </nav>
      </footer>

      {World ? (
        <div className="st-world">
          <ViewBoundary title="Map">
            <Suspense fallback={null}>
              <World controller={controller} />
            </Suspense>
          </ViewBoundary>
        </div>
      ) : (
        <>
          <HqBadge hq={snap.hq} />
          <Theatre
            devices={devices}
            pairs={snap.pairs}
            groups={snap.groups}
            scene={scene}
            bind={bind}
            overlay={overlay}
            marks={snap.marks}
            card={card ? (id) => card(snap.seats.find((s) => s.id === id)!) : undefined}
          >
            {snap.carry && snap.carry.phase !== 'done' && snap.carry.phase !== 'failed' && <Courier controller={controller} scene={scene} carry={snap.carry} />}
          </Theatre>
        </>
      )}

      {whoFor && <WhyDialog name={whoFor.name} decisions={whoFor.decisions} names={names} titles={titles} onClose={closeWhy} />}
    </main>
  );
}
