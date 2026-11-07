import { useCallback, useEffect, useRef, useState } from 'react';
import type { FerryFrame } from '@afterlink/protocol';
import { api } from './ferryApi';

export function Cycler({ frames, label, onError }: { frames: FerryFrame[]; label: string; onError: (m: string) => void }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const at = i % frames.length;

  useEffect(() => {
    if (frames.length < 2 || paused) return;
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 650);
    return () => clearInterval(t);
  }, [frames, paused]);

  useEffect(() => {
    if (canvas.current) api.renderFrame(canvas.current, frames[at]!).catch(() => onError('The code could not be drawn.'));
  }, [frames, at, onError]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(frames.map((f) => api.frameText(f)).join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onError('Copy is not available here.');
    }
  };

  return (
    <>
      <div className="f-qr">
        <canvas ref={canvas} aria-label={`${label}, part ${at + 1} of ${frames.length}`} role="img" />
      </div>
      <p className="f-muted f-center" role="status">Part {at + 1} of {frames.length}</p>
      <div className="f-row">
        <button className="f-btn f-btn-quiet" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
        <button className="f-btn f-btn-quiet" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </>
  );
}

/** Camera, photo and paste input. Every frame found goes to onFrame. */
export function Scanner({ onFrame, hint, problem }: { onFrame: (f: FerryFrame) => void; hint: string; problem?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camera, setCamera] = useState<'starting' | 'on' | 'off'>('starting');
  const [paste, setPaste] = useState('');
  const [own, setOwn] = useState('');
  const sink = useRef(onFrame);
  sink.current = onFrame;

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
            if (f) sink.current(f);
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
  }, []);

  const fromText = useCallback((text: string) => {
    setOwn('');
    const list = text.split(/\s+/).filter(Boolean).map((l) => api.parseFrameText(l));
    if (!list.length || list.some((f) => !f)) return setOwn('That is not a valid code.');
    list.forEach((f) => sink.current(f!));
    setPaste('');
  }, []);

  const fromFile = async (file: File) => {
    setOwn('');
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
        if (!f) return setOwn('No code found in that photo.');
        sink.current(f);
      } else {
        fromText(await file.text());
      }
    } catch {
      setOwn('That file could not be read.');
    }
  };

  return (
    <>
      <div className="f-cam" hidden={camera === 'off'}>
        <video ref={video} muted playsInline aria-label="Camera" />
        <div className="f-cam-frame" aria-hidden="true" />
      </div>
      {camera === 'starting' && <p className="f-muted" role="status">Starting camera...</p>}
      {camera === 'on' && <p className="f-lead f-center">{hint}</p>}
      {camera === 'off' && <p className="f-lead">No camera. Choose a photo.</p>}
      <details className="f-more" open={camera === 'off'}>
        <summary>Use a photo or paste instead</summary>
        <label className="f-btn f-btn-quiet f-file">
          Choose a photo or file
          <input type="file" accept="image/*,.json,.txt" onChange={(e) => e.target.files?.[0] && fromFile(e.target.files[0])} />
        </label>
        <label className="f-field">
          <span>Paste code</span>
          <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} />
        </label>
        <button className="f-btn f-btn-quiet" disabled={!paste.trim()} onClick={() => fromText(paste)}>Add code</button>
      </details>
      {(own || problem) && <p className="f-error" role="alert">{own || problem}</p>}
    </>
  );
}
