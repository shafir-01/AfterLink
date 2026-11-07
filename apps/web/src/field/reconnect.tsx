import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActorNode } from '@afterlink/actor';
import type { FerryFrame, ProvisionBundle } from '@afterlink/protocol';
import {
  PayloadAssembler,
  acceptOffer,
  completeAnswer,
  createOfferPayload,
  isRendezvousFrame,
  type PendingOffer,
  type RendezvousDevice,
  type RendezvousResult,
  type Shown,
} from '@afterlink/rendezvous';
import type { WireFrame } from '@afterlink/ferry';
import { Sheet } from './Sheet';
import { Cycler, Scanner } from './parts';

type Step = 'choose' | 'show' | 'scan-reply' | 'scan-code' | 'answer' | 'done';

export function ReconnectSheet({ node, bundle, onClose }: { node: ActorNode; bundle: ProvisionBundle; onClose: () => void }) {
  const seen = useRef(new Set<string>());
  const device = useMemo<RendezvousDevice>(
    () => ({ keys: bundle.actor, mission: bundle.genesis.mission, roster: bundle.roster, seen: seen.current }),
    [bundle],
  );
  const [step, setStep] = useState<Step>('choose');
  const [shown, setShown] = useState<Shown | null>(null);
  const [problem, setProblem] = useState('');
  const [peerName, setPeerName] = useState('');
  const pending = useRef<PendingOffer | null>(null);
  const asm = useRef(new PayloadAssembler());
  const busy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (pending.current && step !== 'done') pending.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nameOf = (id: string) => bundle.roster.find((r) => r.actor === id)?.name ?? 'the other phone';

  const finish = useCallback(
    (r: RendezvousResult) => {
      if (!alive.current) return;
      if (r.ok) {
        node.adoptLink(r.link);
        setPeerName(nameOf(r.peer));
        setStep('done');
      } else {
        setProblem(r.message);
        setStep('choose');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node],
  );

  const start = async (mode: 'show' | 'scan-code') => {
    setProblem('');
    asm.current = new PayloadAssembler();
    if (mode === 'scan-code') return setStep('scan-code');
    setStep('show');
    setShown(null);
    const offer = await createOfferPayload(device);
    if (!alive.current) return 'expires' in offer ? offer.close() : undefined;
    if ('expires' in offer) {
      pending.current = offer;
      setShown(offer);
    } else {
      setProblem(offer.message);
      setStep('choose');
    }
  };

  const collect = useCallback(
    async (f: FerryFrame, then: (payload: Uint8Array) => Promise<void>) => {
      if (busy.current || !isRendezvousFrame(f)) return;
      asm.current.add(f as WireFrame);
      if (!asm.current.done) return;
      busy.current = true;
      try {
        await then(asm.current.payload());
      } finally {
        busy.current = false;
        asm.current = new PayloadAssembler();
      }
    },
    [],
  );

  const onReply = (f: FerryFrame) =>
    collect(f, async (payload) => {
      if (!pending.current) return;
      const r = await completeAnswer(device, pending.current, payload);
      if (!r.ok && alive.current) setProblem(r.message);
      if (r.ok || r.reason === 'replayed' || r.reason === 'closed' || r.reason === 'timeout' || r.reason === 'no-shared-network') finish(r);
    });

  const onCode = (f: FerryFrame) =>
    collect(f, async (payload) => {
      setProblem('');
      const r = await acceptOffer(device, payload);
      if (!alive.current) return;
      if (!r.ok) return setProblem(r.message);
      setShown(r);
      setStep('answer');
      r.connected.then(finish);
    });

  return (
    <Sheet title="Reconnect by QR" onClose={onClose}>
      {step === 'choose' && (
        <>
          <p className="f-lead">Both phones need the same Wi-Fi or hotspot. Without one, carry an update instead.</p>
          {problem && <p className="f-error" role="alert">{problem}</p>}
          <div className="f-choices">
            <button className="f-btn f-btn-primary" onClick={() => start('show')}>Show my code</button>
            <button className="f-btn f-btn-quiet" onClick={() => start('scan-code')}>Scan their code</button>
          </div>
        </>
      )}
      {step === 'show' &&
        (shown ? (
          <>
            <p className="f-lead">Let the other phone scan this. Then scan its reply.</p>
            <Cycler frames={shown.frames} label="Your code" onError={setProblem} />
            <button className="f-btn f-btn-primary" onClick={() => { asm.current = new PayloadAssembler(); setStep('scan-reply'); }}>Scan their reply</button>
            {problem && <p className="f-error" role="alert">{problem}</p>}
          </>
        ) : (
          <p className="f-muted" role="status">Preparing your code...</p>
        ))}
      {step === 'scan-reply' && <Scanner onFrame={onReply} hint="Point at the reply on the other phone." problem={problem} />}
      {step === 'scan-code' && <Scanner onFrame={onCode} hint="Point at the code on the other phone." problem={problem} />}
      {step === 'answer' && shown && (
        <>
          <p className="f-lead">Let the other phone scan this reply.</p>
          <Cycler frames={shown.frames} label="Your reply" onError={setProblem} />
          <p className="f-muted f-center" role="status">Waiting for the other phone...</p>
        </>
      )}
      {step === 'done' && (
        <>
          <p className="f-lead" role="status">Connected to {peerName}.</p>
          <button className="f-btn f-btn-quiet" onClick={onClose}>Close</button>
        </>
      )}
    </Sheet>
  );
}
