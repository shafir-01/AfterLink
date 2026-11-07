import { Suspense, useEffect, useState } from 'react';
import { loadDebriefInput, type DebriefInput } from '../bridge/missionStore';
import { guardedView, Notice } from '../ui/guarded';

const Debrief = guardedView<DebriefInput>(import.meta.glob('../debrief/{index,Debrief}.{ts,tsx}'), ['index', 'Debrief'], 'Debrief', 'Debrief');

export default function DebriefRoute() {
  const [input, setInput] = useState<DebriefInput | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    loadDebriefInput()
      .catch(() => undefined)
      .then((saved) => live && setInput(saved ?? null));
    return () => {
      live = false;
    };
  }, []);

  if (input === undefined) return null;
  if (input === null) return <Notice title="No mission to review" />;
  return (
    <Suspense fallback={null}>
      <Debrief {...input} />
    </Suspense>
  );
}
