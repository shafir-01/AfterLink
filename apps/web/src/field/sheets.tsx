import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActorNode, ActorView } from '@afterlink/actor';
import type { FerryFrame, FerryPacket } from '@afterlink/protocol';
import { Sheet } from './Sheet';
import { api } from './ferryApi';
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
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const f = await api.toFrames(node.buildFerry());
        if (live) setFrames(f);
      } catch {
        if (live) setError('This update could not be prepared.');
      }
    })();
    return () => { live = false; };
  }, [node]);

  useEffect(() => {
    if (!frames || frames.length < 2 || paused) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 650);
    return () => clearInterval(t);
  }, [frames, paused]);

  useEffect(() => {
    if (frames && canvas.current) api.renderFrame(canvas.current, frames[i % frames.length]).catch(() => setError('The code could not be drawn.'));
  }, [frames, i]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(frames!.map((f) => api.frameText(f)).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { setError('Copy is not available here.'); }
  };

  return (
    <Sheet title="Carry update" onClose={onClose}>
      {error ? (
        <p className="f-error" role="alert">{error}</p>
      ) : !frames ? (
        <p className="f-muted" role="status">Preparing the update...</p>
      ) : (
        <>
          <div className="f-qr">
            <canvas ref={canvas} aria-label={`Update code, part ${(i % frames.length) + 1} of ${frames.length}`} role="img" />
          </div>
          <p className="f-muted f-center" role="status">Part {(i % frames.length) + 1} of {frames.length}</p>
          <div className="f-row">
            <button className="f-btn f-btn-quiet" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
            <button className="f-btn f-btn-quiet" onClick={copy}>{copied ? 'Copied' : 'Copy update'}</button>
          </div>
        </>
      )}
    </Sheet>
  );
}

export function ScanSheet({ node, onClose }: Omit<P, 'view'>) {
  const video = useRef<HTMLVideoElement>(null);
  const asm = useRef<InstanceType<typeof api.FrameAssembler> | null>(null);
  const finished = useRef(false);
  const [progress, setProgress] = useState<{ have: number; total: number } | null>(null);
  const [result, setResult] = useState('');
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [paste, setPaste] = useState('');
  const [problem, setProblem] = useState('');

  const feed = useCallback(
    async (f: FerryFrame) => {
      if (finished.current) return;
      asm.current ??= new api.FrameAssembler();
      const p = asm.current.add(f);
      setProgress({ have: p.have, total: p.total });
      if (asm.current.done) {
        finished.current = true;
        try {
          const packet: FerryPacket = await asm.current.packet();
          const r = node.ingestFerry(packet);
          setResult(
            r.rejected > 0 && r.newEvents === 0
              ? 'This update was not accepted.'
              : r.newEvents > 0
                ? `Update received.`
                : 'Already up to date.',
          );
        } catch {
          setProblem('That update was damaged. Try again.');
          finished.current = false;
          asm.current = null;
          setProgress(null);
        }
      }
    },
    [node],
  );

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const c = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        setCamera('on');
        let last = 0;
        const loop = (t: number) => {
          if (stopped) return;
          if (t - last > 120 && v.videoWidth) {
            last = t;
            const w = Math.min(640, v.videoWidth);
            c.width = w;
            c.height = Math.round((v.videoHeight / v.videoWidth) * w);
            const ctx = c.getContext('2d', { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const f = api.readFrame(ctx.getImageData(0, 0, c.width, c.height));
            if (f) void feed(f);
          }
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      } catch {
        if (!stopped) setCamera('off');
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [feed]);

  const fromText = async (text: string) => {
    setProblem('');
    try {
      const list = text.split(/\s+/).filter(Boolean).map((l) => api.parseFrameText(l));
      if (!list.length || list.some((f) => !f)) throw new Error();
      for (const f of list) await feed(f!);
      setPaste('');
    } catch { setProblem('That is not a valid update.'); }
  };

  const fromFile = async (file: File) => {
    setProblem('');
    try {
      if (file.type.startsWith('image/')) {
        const bmp = await createImageBitmap(file);
        const s = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * s);
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const f = api.readFrame(ctx.getImageData(0, 0, c.width, c.height));
        if (!f) return setProblem('No update code found in that photo.');
        await feed(f);
      } else {
        await fromText(await file.text());
      }
    } catch { setProblem('That file could not be read.'); }
  };

  return (
    <Sheet title="Scan update" onClose={onClose}>
      {result ? (
        <p className="f-lead" role="status">{result}</p>
      ) : (
        <>
          <div className="f-cam" hidden={camera === 'off'}>
            <video ref={video} muted playsInline aria-label="Camera" />
            <div className="f-cam-frame" aria-hidden="true" />
          </div>
          {camera === 'starting' && <p className="f-muted" role="status">Starting camera...</p>}
          {camera === 'on' && !progress && <p className="f-lead f-center">Point at the code on the other phone.</p>}
          {camera === 'off' && <p className="f-lead">No camera. Choose a photo.</p>}
          {progress && (
            <p className="f-lead f-center" role="status">
              {progress.have}/{progress.total}
            </p>
          )}
          <details className="f-more" open={camera === 'off'}>
            <summary>Use a photo or paste instead</summary>
            <label className="f-btn f-btn-quiet f-file">
              Choose a photo or file
              <input type="file" accept="image/*,.json,.txt" onChange={(e) => e.target.files?.[0] && fromFile(e.target.files[0])} />
            </label>
            <label className="f-field">
              <span>Paste update</span>
              <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} />
            </label>
            <button className="f-btn f-btn-quiet" disabled={!paste.trim()} onClick={() => fromText(paste)}>Add update</button>
          </details>
          {problem && <p className="f-error" role="alert">{problem}</p>}
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
