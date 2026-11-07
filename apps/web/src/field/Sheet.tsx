import { useEffect, useId, useRef, type ReactNode } from 'react';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('keydown', esc);
      prev?.focus?.();
    };
  }, []);

  return (
    <div className="f-scrim" onClick={onClose}>
      <div
        ref={ref}
        className="f-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Tab' || !ref.current) return;
          const els = [...ref.current.querySelectorAll<HTMLElement>('button, input, textarea, summary, [href]')].filter(
            (el) => !el.hasAttribute('disabled'),
          );
          if (!els.length) return;
          const first = els[0]!;
          const last = els[els.length - 1]!;
          if (e.shiftKey && document.activeElement === ref.current) { e.preventDefault(); last.focus(); }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}
      >
        <div className="f-grip" aria-hidden="true" />
        <header className="f-sheet-head">
          <h2 id={id}>{title}</h2>
          <button className="f-close" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </header>
        <div className="f-sheet-body">{children}</div>
      </div>
    </div>
  );
}
