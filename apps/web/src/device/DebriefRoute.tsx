import { Suspense, useEffect, useState } from 'react';
import { loadDebriefInput, type DebriefInput } from '../bridge/missionStore';
import { guardedView } from '../ui/guarded';
import { Stack } from '../ui/Stack';
import { Text } from '../ui/Text';

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
  if (input === null) {
    return (
      <main className="al-center">
        <Stack gap={2} align="center">
          <Text variant="title" as="h1">
            No mission to review
          </Text>
          <Text tone="muted">Run a mission first.</Text>
        </Stack>
      </main>
    );
  }
  return (
    <Suspense fallback={null}>
      <Debrief {...input} />
    </Suspense>
  );
}
