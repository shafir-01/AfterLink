import { useEffect, useState } from 'react';
import type { HqView } from './director';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

const share = (at: number, from: number, to: number) => (to > from ? ((at - from) / (to - from)) * 100 : 0);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function HqBadge({ hq }: { hq: HqView }) {
  const blind = hq.state === 'blind';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hq.blindFrom) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hq.blindFrom]);

  const done = `${plural(hq.done, 'task', 'tasks')} done`;
  const text = blind
    ? `Last confirmed at ${hq.lastConfirmedAt ? clock(hq.lastConfirmedAt) : 'unknown'}. ${done}.`
    : `Sees ${plural(hq.teams, 'team', 'teams')}. ${done}.`;
  const from = hq.firstAt ?? hq.blindFrom ?? now;
  const to = Math.max(now, hq.blindTo ?? now);

  return (
    <section className="st-hq" data-state={hq.state} aria-label="What HQ can see">
      <p className="st-hq-pill">
        <span className="st-hq-dot" aria-hidden="true" />
        <strong>HQ</strong>
        <span>{text}</span>
      </p>
      <div className="st-ribbon" aria-hidden="true" data-on={hq.blindFrom !== null}>
        {hq.blindFrom !== null && (
          <>
            <i className="st-ribbon-blind" style={{ left: `${share(hq.blindFrom, from, to)}%`, right: `${100 - share(hq.blindTo ?? to, from, to)}%` }} />
            {hq.ticks.map((t) => {
              const left = share(t.at, from, to);
              return <i key={t.id} className="st-tick" data-late={t.late} style={{ left: `${left}%`, animationDelay: t.late ? `${left * 7}ms` : undefined }} />;
            })}
          </>
        )}
      </div>
    </section>
  );
}
