import type { CSSProperties, ReactNode } from 'react';
import { teamColor } from './team';

type BadgeProps = {
  /** Team id: the dot takes the team colour. */
  team: string;
  children: ReactNode;
  className?: string;
};

export function Badge({ team, children, className }: BadgeProps) {
  const style = { '--badge-color': teamColor(team) } as CSSProperties;
  return (
    <span className={className ? `al-badge ${className}` : 'al-badge'} style={style}>
      <span className="al-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
