import { useId, useState } from 'react';
import type { MissionCapsule } from '@afterlink/protocol';
import { compileMission, type CompileResult, type Meta, type Right } from './api';

export interface ComposeMissionProps {
  /** Called once the organiser approves the draft. */
  onApprove: (capsule: MissionCapsule) => void;
  /** Organiser public key placed on the draft. */
  issuer?: string;
}

type Phase =
  | { t: 'idle' }
  | { t: 'busy' }
  | { t: 'unavailable' }
  | { t: 'error'; message: string }
  | { t: 'questions'; questions: string[] }
  | { t: 'draft'; capsule: MissionCapsule; rights: Right[]; rejected: string[]; meta: Meta };

const field: React.CSSProperties = { font: 'inherit', padding: '0.75rem', borderRadius: 10, border: '1px solid currentColor', background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box' };
const primary: React.CSSProperties = { font: 'inherit', fontWeight: 600, padding: '0.75rem 1.25rem', borderRadius: 10, border: 0, background: 'CanvasText', color: 'Canvas', cursor: 'pointer' };

export function ComposeMission({ onApprove, issuer }: ComposeMissionProps) {
  const [objective, setObjective] = useState('');
  const [answers, setAnswers] = useState<string[]>([]);
  const [asked, setAsked] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>({ t: 'idle' });
  const [approved, setApproved] = useState(false);
  const labelId = useId();

  const apply = (r: CompileResult) => {
    if (r.kind === 'unavailable') return setPhase({ t: 'unavailable' });
    if (r.kind === 'error') return setPhase({ t: 'error', message: r.message });
    if (r.kind === 'questions') {
      setAsked(r.questions);
      setAnswers(r.questions.map(() => ''));
      return setPhase({ t: 'questions', questions: r.questions });
    }
    setApproved(false);
    setPhase({ t: 'draft', capsule: r.capsule, rights: r.rights, rejected: r.rejectedRights, meta: r.meta });
  };

  const run = async (withAnswers: boolean) => {
    setPhase({ t: 'busy' });
    const clar = withAnswers ? asked.map((question, i) => ({ question, answer: answers[i] ?? '' })).filter((c) => c.answer.trim()) : [];
    apply(await compileMission(objective, clar, issuer));
  };

  const busy = phase.t === 'busy';
  const draft = phase.t === 'draft' ? phase : null;
  const teamName = (id: string) => draft?.capsule.teams.find((t) => t.id === id)?.name ?? id;

  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '2rem 1rem', display: 'grid', gap: '1rem' }}>
      <label id={labelId} htmlFor={`${labelId}-in`} style={{ fontSize: '1.25rem', fontWeight: 600 }}>Describe the mission</label>
      <textarea id={`${labelId}-in`} rows={5} style={field} value={objective} onChange={(e) => setObjective(e.target.value)} disabled={busy} />
      {phase.t !== 'questions' && !draft && (
        <button style={{ ...primary, justifySelf: 'start', opacity: busy || !objective.trim() ? 0.5 : 1 }} disabled={busy || !objective.trim()} onClick={() => run(false)}>
          {busy ? 'Drafting' : 'Draft mission'}
        </button>
      )}

      <div role="status" aria-live="polite">
        {phase.t === 'unavailable' && <p>The drafting service is unavailable. The mission can still be built from the standard scenario.</p>}
        {phase.t === 'error' && <p>{phase.message}</p>}
      </div>

      {phase.t === 'questions' && (
        <form onSubmit={(e) => { e.preventDefault(); run(true); }} style={{ display: 'grid', gap: '0.75rem' }}>
          {phase.questions.map((q, i) => (
            <label key={q} style={{ display: 'grid', gap: '0.25rem' }}>
              {q}
              <input style={field} value={answers[i] ?? ''} onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))} />
            </label>
          ))}
          <button style={{ ...primary, justifySelf: 'start' }} type="submit">Continue</button>
        </form>
      )}

      {draft && (
        <section aria-label="Draft" style={{ display: 'grid', gap: '1rem' }}>
          <h2 style={{ margin: 0 }}>{draft.capsule.name}</h2>
          <div>
            <h3>Teams</h3>
            <ul>{draft.capsule.teams.map((t) => <li key={t.id}>{t.name}: {t.capabilities.join(', ')}</li>)}</ul>
          </div>
          <div>
            <h3>Tasks</h3>
            <ul>{draft.capsule.tasks.map((t) => <li key={t.id}>{t.title} (priority {t.priority}, {t.locationName})</li>)}</ul>
          </div>
          <div>
            <h3>Rights</h3>
            {draft.rights.length === 0 ? <p>None requested.</p> : (
              <ul>{draft.rights.map((r) => <li key={r.resource}>{r.tokens} {r.name}, held by {r.holders.map(teamName).join(', ')}. You wrote: &ldquo;{r.basis}&rdquo;</li>)}</ul>
            )}
            {draft.rejected.length > 0 && <p>Not included, because you did not describe them: {draft.rejected.join(', ')}.</p>}
          </div>
          {draft.rights.length > 0 && (
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
              I approve these rights
            </label>
          )}
          <button style={{ ...primary, justifySelf: 'start', opacity: draft.rights.length > 0 && !approved ? 0.5 : 1 }} disabled={draft.rights.length > 0 && !approved} onClick={() => onApprove(draft.capsule)}>
            Approve and start
          </button>
          <small>{draft.meta.model}, {draft.meta.latencyMs} ms, {draft.meta.usage.inputTokens} in, {draft.meta.usage.outputTokens} out</small>
        </section>
      )}
    </main>
  );
}

export default ComposeMission;
