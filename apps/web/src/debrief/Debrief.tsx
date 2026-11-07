import { useMemo, useState } from 'react';
import type { AnyEvent, ConflictRecord, EventBodies, EventId, MissionRecord, PartitionEpisode } from '@afterlink/protocol';
import { clock, conservationWords, derive, headline, plural, whoKnewWhat, type Roster } from './derive';
import { measuredRuns, narrate, sendReport, type Remote } from './services';
import './debrief.css';

export interface DebriefProps {
  events: AnyEvent[];
  hqSeen: EventId[];
  episodes: PartitionEpisode[];
  /** Receives the conflict.resolved body. The host signs and appends it. */
  onResolve?: (body: EventBodies['conflict.resolved']) => void;
}

type Mode = 'hq' | 'real';

export function Debrief({ events, hqSeen, episodes, onResolve }: DebriefProps) {
  const d = useMemo(() => derive(events, hqSeen, episodes), [events, hqSeen, episodes]);
  if (!d.ok) {
    return (
      <main className="dbf">
        <h1 className="dbf-lead">Debrief unavailable</h1>
        <p className="dbf-muted">{d.reason}</p>
      </main>
    );
  }
  return <Body events={events} hqSeen={hqSeen} record={d.record} roster={d.roster} onResolve={onResolve} />;
}

function Body({ events, hqSeen, record, roster, onResolve }: { events: AnyEvent[]; hqSeen: EventId[]; record: MissionRecord; roster: Roster; onResolve?: DebriefProps['onResolve'] }) {
  const seen = useMemo(() => new Set(hqSeen), [hqSeen]);
  const [mode, setMode] = useState<Mode>('real');
  const walls = [...record.timeline.map((t) => t.at), ...record.episodes.map((e) => e.from)];
  const t0 = Math.min(...walls);
  const lastAt = Math.max(...record.timeline.map((t) => t.at), ...record.episodes.map((e) => e.to ?? e.from));
  const t1 = lastAt > t0 ? lastAt : t0 + 1;
  const [at, setAt] = useState(t1);
  const pos = (t: number) => `calc(12px + (100% - 24px) * ${(t - t0) / (t1 - t0)})`;
  const name = (t: string) => roster.teamName[t] ?? t;
  const teams = roster.teams.length ? roster.teams : [...new Set(record.timeline.map((e) => e.team))];
  const shown = record.timeline.filter((e) => e.at <= at && (mode === 'real' || seen.has(e.event)));
  const knowledge = useMemo(() => whoKnewWhat(events, roster, at), [events, roster, at]);
  const facts = [
    { n: record.doneWhileHqBlind, l: 'done while blind' },
    { n: record.refusedUnsafe, l: 'refused' },
    { n: record.duplicatesPrevented, l: 'duplicates prevented' },
    { n: record.conflicts.length, l: record.conflicts.length === 1 ? 'conflict' : 'conflicts' },
  ];
  const hiddenCount = record.timeline.filter((e) => !seen.has(e.event)).length;
  const latest = shown[shown.length - 1];

  return (
    <main className="dbf">
      <h1 className="dbf-lead">{headline(record)}</h1>

      <section aria-label="Timeline">
        <div className="dbf-bar">
          <div className="dbf-toggle" role="group" aria-label="View">
            <button aria-pressed={mode === 'hq'} onClick={() => setMode('hq')}>What HQ saw</button>
            <button aria-pressed={mode === 'real'} onClick={() => setMode('real')}>What really happened</button>
          </div>
          <span className="dbf-muted">
            {mode === 'hq' ? `${plural(hiddenCount, 'event', 'events')} hidden` : ''}
          </span>
        </div>
        <div className="dbf-lanes">
          {teams.map((team) => (
            <div className="dbf-lane" key={team}>
              <span className="dbf-lane-name">{name(team)}</span>
              <div className="dbf-track">
                {record.episodes.map((ep) => (
                  <i key={ep.id} className="dbf-blind" style={{ left: pos(ep.from), right: `calc(100% - ${pos(ep.to ?? t1)})` }} />
                ))}
                {shown.filter((e) => e.team === team).map((e) => (
                  <b key={e.event} className={`dbf-dot${seen.has(e.event) ? '' : ' hidden'}`} style={{ left: pos(e.at) }} title={`${clock(e.at)} ${e.label}`} />
                ))}
              </div>
            </div>
          ))}
          <div className="dbf-axis">
            <span>{clock(t0)}</span>
            <span className="dbf-legend"><i /> HQ blind</span>
            <span>{clock(t1)}</span>
          </div>
        </div>
        <label className="dbf-scrub">
          <span>Replay</span>
          <input type="range" min={t0} max={t1} step={Math.max(1, Math.round((t1 - t0) / 400))} value={at} onChange={(e) => setAt(Number(e.target.value))} aria-valuetext={clock(at)} />
          <output>{clock(at)}</output>
        </label>
        <ul className="dbf-know" aria-label={`Who knew what at ${clock(at)}`}>
          {knowledge.map((k) => (
            <li key={k.team}>
              <strong>{name(k.team)}</strong>
              <span>{k.known} known</span>
              <span className={k.missingFrom.length ? 'dbf-warn' : 'dbf-muted'}>
                {k.missingFrom.length ? (k.missingFrom.length >= teams.length - 1 ? 'nothing from others' : `nothing from ${k.missingFrom.map(name).join(', ')}`) : k.learned ? `${k.learned} from others` : 'only its own'}
              </span>
            </li>
          ))}
        </ul>
        {latest && at < t1 && <p className="dbf-last" aria-live="polite">{clock(latest.at)}  {latest.label}</p>}
      </section>

      <section className="dbf-facts" aria-label="Key facts">
        {facts.map((f) => (
          <div key={f.l}>
            <span className="dbf-num">{f.n}</span>
            <span>{f.l}</span>
          </div>
        ))}
      </section>

      <section>
        <h2>Resources</h2>
        <ul className="dbf-res">
          {record.conservation.map((c) => {
            const w = conservationWords(c, roster.resourceName[c.resource] ?? c.resource);
            return (
              <li key={c.resource} className={w.ok ? '' : 'bad'}>
                {w.text}
                {c.inTransit > 0 && <span className="dbf-muted">, {c.inTransit} in transit</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {record.conflicts.length > 0 && (
        <Conflict conflict={record.conflicts.find((c) => !c.resolved) ?? record.conflicts[0]} total={record.conflicts.length} record={record} roster={roster} onResolve={onResolve} />
      )}

      {record.unknowns.length > 0 && (
        <section>
          <h2>Still unknown</h2>
          <ul className="dbf-plain">{record.unknowns.map((u) => <li key={u}>{u}</li>)}</ul>
        </section>
      )}

      <Reports record={record} />
      <Measured />
    </main>
  );
}

function Conflict({ conflict, total, record, roster, onResolve }: { conflict: ConflictRecord; total: number; record: MissionRecord; roster: Roster; onResolve?: DebriefProps['onResolve'] }) {
  const [done, setDone] = useState<string | null>(null);
  const byId = new Map(record.timeline.map((t) => [t.event, t]));
  const sides = conflict.events.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const resolution = conflict.resolved ? conflict.resolution ?? 'Resolved' : done;
  const resolve = (keep: EventId, who: string) => {
    onResolve?.({ conflictId: conflict.id, resolution: `Keep ${who}`, keep: [keep] });
    setDone(`Kept ${who}`);
  };
  return (
    <section>
      <h2>{total > 1 ? `Conflict, 1 of ${total}` : 'Conflict'}</h2>
      <p className="dbf-conflict-sum">{conflict.summary}</p>
      <div className="dbf-sides">
        {sides.map((s) => {
          const who = roster.teamName[s.team] ?? s.team;
          return (
            <div key={s.event}>
              <strong>{who}</strong>
              <span>{s.label}</span>
              <span className="dbf-muted">{clock(s.at)}</span>
              {!resolution && <button className="dbf-btn" disabled={!onResolve} onClick={() => resolve(s.event, who)}>Keep {who}</button>}
            </div>
          );
        })}
      </div>
      {resolution ? <p className="dbf-ok">{resolution}</p> : !onResolve && <p className="dbf-muted">Resolving needs a signing device.</p>}
    </section>
  );
}

function Reports({ record }: { record: MissionRecord }) {
  const [story, setStory] = useState<Remote<string>>({ s: 'idle' });
  const [sent, setSent] = useState<Remote<string>>({ s: 'idle' });
  const text = story.s === 'live' ? story.value : null;
  return (
    <section>
      <div className="dbf-actions">
        <button className="dbf-btn" disabled={story.s === 'busy'} onClick={async () => { setStory({ s: 'busy' }); setStory(await narrate(record)); }}>
          {story.s === 'busy' ? 'Writing' : 'Write the report'}
        </button>
        <button className="dbf-btn" disabled={sent.s === 'busy'} onClick={async () => { setSent({ s: 'busy' }); setSent(await sendReport(record, text)); }}>
          {sent.s === 'busy' ? 'Sending' : 'Send report'}
        </button>
        <span className="dbf-status" role="status">
          {story.s === 'unavailable' && `Report unavailable: ${story.reason}. `}
          {sent.s === 'unavailable' && `Not sent: ${sent.reason}.`}
          {sent.s === 'live' && 'Report sent.'}
        </span>
      </div>
      {text && (
        <article className="dbf-story">
          <span className="dbf-tag">Written live by the relay</span>
          {text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
        </article>
      )}
    </section>
  );
}

function Measured() {
  const rows = useMemo(measuredRuns, []);
  if (!rows.length) return null;
  return (
    <section>
      <h2>Measured runs</h2>
      <dl className="dbf-meas">{rows.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
    </section>
  );
}
