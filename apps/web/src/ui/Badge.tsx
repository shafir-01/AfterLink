import type { CSSProperties, ReactNode } from 'react';
import { teamColor } from './team';

type BadgeProps = {
  tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'stop';
  /** Team id: the dot takes the team colour. */
  team?: string;
  children: ReactNode;
  className?: string;
};

const TONE_COLOR = { neutral: 'var(--line-strong)', accent: 'var(--accent)', ok: 'var(--ok)', warn: 'var(--warn)', stop: 'var(--stop)' };

export function Badge({ tone = 'neutral', team, children, className }: BadgeProps) {
  const style = { '--badge-color': team ? teamColor(team) : TONE_COLOR[tone] } as CSSProperties;
  return (
    <span className={className ? `al-badge ${className}` : 'al-badge'} style={style}>
      <span className="al-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
