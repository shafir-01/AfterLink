import { Suspense, lazy } from 'react';
import { guardedView, Unavailable, ViewBoundary } from './ui/guarded';
import { MotionConfig } from './ui/motion';
import { useRoute, type RouteName } from './ui/route';

const stage = import.meta.glob('./stage/{index,Stage,StagePage}.{ts,tsx}');
const lead = import.meta.glob(['./lead/{index,Lead}.{ts,tsx}', './stage/{Lead,LeadPage}.{ts,tsx}', './device/Provision.tsx']);

const VIEWS = {
  stage: { title: 'AfterLink', View: guardedView(stage, ['index', 'Stage', 'StagePage'], 'Stage', 'AfterLink') },
  device: { title: 'Field device', View: lazy(() => import('./device/DeviceHost')) },
  lead: { title: 'Mission lead', View: guardedView(lead, ['index', 'Lead', 'LeadPage', 'Provision'], 'Lead', 'Mission lead') },
  debrief: { title: 'Debrief', View: lazy(() => import('./device/DebriefRoute')) },
  compose: { title: 'Compose', View: lazy(() => import('./device/ComposeRoute')) },
} satisfies Record<RouteName, { title: string; View: unknown }>;

export default function App() {
  const route = useRoute();
  return <MotionConfig reducedMotion="user">{route.name === 'unknown' ? <Unavailable title="Page not found" /> : <Routed name={route.name} />}</MotionConfig>;
}

function Routed({ name }: { name: RouteName }) {
  const { title, View } = VIEWS[name];
  return (
    <ViewBoundary key={name} title={title}>
      <Suspense fallback={null}>
        <View />
      </Suspense>
    </ViewBoundary>
  );
}
