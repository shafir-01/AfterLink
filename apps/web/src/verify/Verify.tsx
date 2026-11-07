import { useEffect, useRef, useState, type DragEvent } from 'react';
import { exportMission, FILE_EXTENSION, rosterFrom, tamperByte, verifySteps, type Check, type CheckId, type CheckStatus, type Tamper, type Verdict } from '@afterlink/proof';
import { loadDebriefInput, type DebriefInput } from '../bridge/missionStore';
import { Button } from '../ui/Button';
import { useReducedMotion } from '../ui/motion';
import { parseRoute } from '../ui/route';
import { Text } from '../ui/Text';
import './verify.css';

export interface VerifyProps {
  /** A file to check at once, such as the run the debrief is showing. */
  file?: Uint8Array | string | null;
  name?: string;
}

/** `recorded`: a measurement rather than a test, so it can never earn a tick. */
type RowStatus = CheckStatus | 'running' | 'recorded';

interface Row {
  id: CheckId;
  label: string;
  status: RowStatus;
  detail: string;
}

interface Loaded {
  bytes: Uint8Array;
  name: string;
  /** Exported here rather than dropped in, so there is no copy of it on disk yet. */
  fresh: boolean;
}

const PACE_MS = 110;
const GLYPH: Record<RowStatus, string> = { running: '', pass: '✓', fail: '✕', skip: '–', none: '–', recorded: '•' };
const SPOKEN: Record<RowStatus, string> = { running: 'Checking', pass: 'Passed', fail: 'Failed', skip: 'Not checked', none: 'No record', recorded: 'Recorded' };

const encode = (file: Uint8Array | string) => (typeof file === 'string' ? new TextEncoder().encode(file) : file);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The verdict below names the failing event and reason, so its row only counts any others. */
function rowOf({ id, status, detail, findings }: Check): Pick<Row, 'status' | 'detail'> {
  if (status === 'fail') return { status, detail: findings.length > 1 ? `${findings.length} found` : '' };
  if (status === 'skip') return { status, detail: '' };
  return { status: id === 'visibility' && status === 'pass' ? 'recorded' : status, detail };
}

function runFile(input: DebriefInput): Loaded {
  const text = exportMission(input.events, rosterFrom(input.events), { hqSeen: input.hqSeen });
  return { bytes: encode(text), name: `${input.events[0]?.mission ?? 'mission'}${FILE_EXTENSION}`, fresh: true };
}

/** Runs the real checks one at a time, publishing each line as it finishes. */
function useVerification(bytes: Uint8Array | null) {
  const [rows, setRows] = useState<Row[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    setRows([]);
    setVerdict(null);
    if (!bytes) return;
    let live = true;
    (async () => {
      const steps = verifySteps(bytes);
      let next = steps.next();
      while (!next.done) {
        if (!live) return;
        const step = next.value;
        if (step.kind === 'start') {
          setRows((r) => [...r, { id: step.id, label: step.label, status: 'running', detail: '' }]);
          await pause(0);
        } else if (step.kind === 'progress') {
          setRows((r) => r.map((row) => (row.id === step.id ? { ...row, detail: `${step.done} of ${step.total}` } : row)));
          await pause(0);
        } else {
          const { check } = step;
          setRows((r) => r.map((row) => (row.id === check.id ? { ...row, ...rowOf(check) } : row)));
          await pause(reduced || check.status === 'skip' ? 0 : PACE_MS);
        }
        if (!live) return;
        next = steps.next();
      }
      setVerdict(next.value);
    })();
    return () => {
      live = false;
    };
  }, [bytes, reduced]);

  return { rows, verdict };
}

export function Verify({ file, name }: VerifyProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(file ? { bytes: encode(file), name: name ?? `mission${FILE_EXTENSION}`, fresh: true } : null);
  const [flip, setFlip] = useState<Tamper | null>(null);
  const [saved, setSaved] = useState<DebriefInput | null>(null);
  const [problem, setProblem] = useState('');
  const [dragging, setDragging] = useState(false);
  const { rows, verdict } = useVerification(flip?.bytes ?? loaded?.bytes ?? null);
  const end = useRef<HTMLDivElement>(null);

  const load = (next: Loaded | null) => {
    setFlip(null);
    setProblem('');
    setLoaded(next);
  };

  const startRun = (input: DebriefInput) => {
    try {
      load(runFile(input));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'This run cannot be exported.');
    }
  };

  useEffect(() => {
    let live = true;
    const wanted = parseRoute(window.location.hash).params.has('run');
    loadDebriefInput()
      .catch(() => undefined)
      .then((input) => {
        if (!live || !input?.events.length) return;
        setSaved(input);
        if (wanted && !file) startRun(input);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (verdict) end.current?.scrollIntoView({ block: 'nearest' });
  }, [verdict]);

  const open = async (f: File | undefined) => {
    if (f) load({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name, fresh: false });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void open(e.dataTransfer.files[0]);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };

  const save = () => {
    if (!loaded) return;
    const url = URL.createObjectURL(new Blob([loaded.bytes as BlobPart], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = loaded.name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="vf" data-dragging={dragging || undefined} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}>
      <Text variant="title" as="h1">
        Verify a mission
      </Text>

      {!loaded && (
        <div className="vf-start">
          <label className="vf-drop">
            <input className="al-visually-hidden" type="file" accept={`${FILE_EXTENSION},application/json`} onChange={(e) => void open(e.target.files?.[0])} />
            <Text variant="heading" as="span">
              Drop a {FILE_EXTENSION} file
            </Text>
            <Text tone="muted" as="span">
              or choose one
            </Text>
          </label>
          {saved && (
            <Button variant="primary" size="large" onClick={() => startRun(saved)}>
              Verify this run
            </Button>
          )}
          {problem && <Text tone="stop">{problem}</Text>}
        </div>
      )}

      {loaded && (
        <>
          <ol className="vf-rows" aria-label="Checks">
            {rows.map((row) => (
              <li className="vf-row" data-status={row.status} key={row.id}>
                <span className="vf-glyph" aria-hidden="true">
                  {GLYPH[row.status]}
                </span>
                <span className="al-visually-hidden">{SPOKEN[row.status]}: </span>
                <span className="vf-label">{row.label}</span>
                <span className="vf-detail">{row.detail}</span>
              </li>
            ))}
          </ol>

          <div role="status" ref={end}>
            {verdict && <Outcome verdict={verdict} flip={flip} />}
          </div>

          {verdict && (
            <div className="vf-actions">
              {(verdict.ok || flip) && (
                <Button variant="primary" onClick={() => setFlip(tamperByte(loaded.bytes))}>
                  Tamper with one byte
                </Button>
              )}
              {flip && <Button onClick={() => setFlip(null)}>Restore</Button>}
              {!flip && loaded.fresh && <Button onClick={save}>Save file</Button>}
              <Button variant="quiet" onClick={() => load(null)}>
                Another file
              </Button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function Outcome({ verdict, flip }: { verdict: Verdict; flip: Tamper | null }) {
  const { ok, plain, words, root, issuer, visibility, continuity, notes, failure } = verdict;
  const said = plain.replace(/^(Not valid|Valid)\.\s*/, '');
  const blind = visibility?.blind ?? [];
  const unknowns = continuity?.unknowns ?? [];
  return (
    <section className="vf-outcome">
      <Text variant="display" as="h2" tone={ok ? 'ok' : 'stop'}>
        {ok ? 'Valid' : 'Not valid'}
      </Text>
      {!ok && said && <Text>{said}</Text>}
      {flip && (
        <Text tone="muted">
          Byte {flip.offset.toLocaleString('en-GB')} changed from {String.fromCharCode(flip.before)} to {String.fromCharCode(flip.after)}.
        </Text>
      )}
      {failure?.event && (
        <Text variant="mono" as="p" tone="muted" className="vf-hash">
          {failure.event}
        </Text>
      )}
      {ok && words && (
        <div className="vf-phrase">
          <p className="vf-words">
            {words.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </p>
          <Text tone="muted">Same words, same history.</Text>
        </div>
      )}
      {ok && (
        <details className="vf-more">
          <summary>Details</summary>
          {blind.length > 0 && (
            <>
              <Text variant="label" as="h3">
                Outside HQ visibility
              </Text>
              <ul>
                {blind.map((b) => (
                  <li key={b.taskId}>
                    {b.who}: {b.title}
                  </li>
                ))}
              </ul>
            </>
          )}
          {notes.length > 0 && (
            <>
              <Text variant="label" as="h3">
                Conflicts
              </Text>
              <ul>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {unknowns.length > 0 && (
            <>
              <Text variant="label" as="h3">
                Still unknown
              </Text>
              <ul>
                {unknowns.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </>
          )}
          <Text variant="label" as="h3">
            Fingerprint
          </Text>
          <Text variant="mono" as="p" className="vf-hash">
            {root}
          </Text>
          <Text variant="label" as="h3">
            Issuer key
          </Text>
          <Text variant="mono" as="p" className="vf-hash">
            {issuer}
          </Text>
        </details>
      )}
    </section>
  );
}
