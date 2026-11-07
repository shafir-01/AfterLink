import type { ReactNode } from 'react';

/** First stop for keyboard users: jumps past embedded content to the element matching `target`. */
export function SkipLink({ target, children }: { target: string; children: ReactNode }) {
  return (
    <nav aria-label="Skip">
      <button type="button" className="al-skip" onClick={() => document.querySelector<HTMLElement>(target)?.focus()}>
        {children}
      </button>
    </nav>
  );
}
