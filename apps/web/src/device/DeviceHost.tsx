import { Suspense, useEffect } from 'react';
import type { ActorNode } from '@afterlink/actor';
import { insideStage } from '../bridge/device';
import { guardedView, Notice, ViewBoundary } from '../ui/guarded';
import { useRoute } from '../ui/route';
import { startDevice, useDevice } from './runtime';

const Field = guardedView<{ actor: ActorNode; compact?: boolean }>(import.meta.glob('../field/{index,Field}.{ts,tsx}'), ['index', 'Field'], 'Field', 'Mission');

export default function DeviceHost() {
  const route = useRoute();
  const device = useDevice();
  const framed = insideStage();
  const bundle = route.params.get('p') ?? undefined;
  const relay = route.params.get('relay') ?? undefined;

  useEffect(() => startDevice({ bundle, relay }), [bundle, relay]);

  if (device.phase === 'running' && device.node) {
    return (
      <ViewBoundary title="Mission">
        <Suspense fallback={null}>
          <Field actor={device.node} compact={framed} />
        </Suspense>
      </ViewBoundary>
    );
  }
  if (device.phase === 'failed') return <Notice title="Could not start" detail="Ask your mission lead for a new link." />;
  if (device.phase === 'booting') return <Notice title="Starting" />;
  return framed ? <Notice title="Waiting for a mission" /> : <Notice title="No mission" detail="Ask your mission lead for a code." />;
}
