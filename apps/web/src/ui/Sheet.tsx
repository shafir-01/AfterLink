import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from './Button';
import { AnimatePresence, fade, motion, settle } from './motion';
import { Text } from './Text';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

/** Modal panel: a bottom sheet on phones, a side panel on wide screens. */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  return (
    <AnimatePresence>
      {open ? (
        <Panel onClose={onClose} title={title}>
          {children}
        </Panel>
      ) : null}
    </AnimatePresence>
  );
}

function Panel({ onClose, title, children }: Omit<SheetProps, 'open'>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', cancel);
    return () => el.removeEventListener('cancel', cancel);
  }, [onClose]);

  return (
    <dialog ref={dialog} className="al-sheet" aria-labelledby={titleId}>
      <motion.div className="al-sheet__scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} />
      <motion.div className="al-sheet__panel" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }} transition={settle}>
        <div className="al-sheet__head">
          <Text as="h2" variant="heading" id={titleId}>
            {title}
          </Text>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
        </div>
        {children}
      </motion.div>
    </dialog>
  );
}
