import { Suspense, useEffect } from 'react';
import type { ActorNode } from '@afterlink/actor';
import { insideStage } from '../bridge/device';
import { guardedView, ViewBoundary } from '../ui/guarded';
import { useRoute } from '../ui/route';
import { Stack } from '../ui/Stack';
import { Text } from '../ui/Text';
import { startDevice, useDevice } from './runtime';

const Field = guardedView<{ actor: ActorNode; compact?: boolean }>(import.meta.glob('../field/{index,Field}.{ts,tsx}'), ['index', 'Field'], 'Field', 'Field device');

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="al-center">
      <Stack gap={2} align="center">
        <Text variant="heading" as="h1">
          {title}
        </Text>
        {detail ? <Text tone="muted">{detail}</Text> : null}
      </Stack>
    </main>
  );
}

export default function DeviceHost() {
  const route = useRoute();
  const device = useDevice();
  const framed = insideStage();
  const bundle = route.params.get('p') ?? undefined;
  const relay = route.params.get('relay') ?? undefined;

  useEffect(() => startDevice({ bundle, relay }), [bundle, relay]);

  if (device.phase === 'running' && device.node) {
    return (
      <ViewBoundary title="Field device">
        <Suspense fallback={null}>
          <Field actor={device.node} compact={framed} />
        </Suspense>
      </ViewBoundary>
    );
  }
  if (device.phase === 'failed') return <Notice title="This device could not start" detail={device.error ?? undefined} />;
  if (device.phase === 'booting') return <Notice title="Starting" />;
  return framed ? <Notice title="Waiting for a mission" /> : <Notice title="No mission on this device" detail="Open the link from your mission lead." />;
}
