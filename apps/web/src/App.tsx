import { Suspense, lazy, useEffect } from 'react';
import { guardedView, Loading, Notice, ViewBoundary } from './ui/guarded';
import { MotionConfig } from './ui/motion';
import { atAppRoot, useRoute, type RouteName } from './ui/route';
import { SkipLink } from './ui/SkipLink';

const stage = import.meta.glob('./stage/{index,Stage,StagePage}.{ts,tsx}');
const lead = import.meta.glob(['./lead/{index,Lead}.{ts,tsx}', './stage/{Lead,LeadPage}.{ts,tsx}', './device/Provision.tsx']);
const verify = import.meta.glob('./verify/{index,Verify}.{ts,tsx}');

const VIEWS = {
  stage: { title: 'AfterLink', View: guardedView(stage, ['index', 'Stage', 'StagePage'], 'Stage', 'AfterLink') },
  device: { title: 'Mission', View: lazy(() => import('./device/DeviceHost')) },
  lead: { title: 'Mission lead', View: guardedView(lead, ['index', 'Lead', 'LeadPage', 'Provision'], 'Lead', 'Mission lead') },
  debrief: { title: 'Debrief', View: lazy(() => import('./device/DebriefRoute')) },
  compose: { title: 'Compose', View: lazy(() => import('./device/ComposeRoute')) },
  verify: { title: 'Verify', View: guardedView(verify, ['index', 'Verify'], 'Verify', 'Verify') },
} satisfies Record<RouteName, { title: string; View: unknown }>;

const HOME_TITLE = document.title;

const hasWebRTC = () => typeof RTCPeerConnection === 'function' && 'createDataChannel' in RTCPeerConnection.prototype;

function NotFound() {
  const home = (
    <a className="al-button al-button--primary" href={import.meta.env.BASE_URL}>
      Go to AfterLink
    </a>
  );
  return <Notice title="Page not found" action={home} />;
}

export default function App() {
  const route = useRoute();
  return <MotionConfig reducedMotion="user">{route.name === 'unknown' || !atAppRoot() ? <NotFound /> : <Routed name={route.name} />}</MotionConfig>;
}

function Routed({ name }: { name: RouteName }) {
  const { title, View } = VIEWS[name];
  useEffect(() => {
    document.title = name === 'stage' ? HOME_TITLE : `${title} | AfterLink`;
  }, [name, title]);
  if ((name === 'stage' || name === 'device') && !hasWebRTC()) {
    return <Notice title="This browser can't run AfterLink" detail="It needs WebRTC. Try a current Chrome, Edge, Firefox or Safari." />;
  }
  return (
    <ViewBoundary key={name} title={title}>
      {name === 'stage' ? <SkipLink target=".st-primary">Skip to controls</SkipLink> : null}
      <Suspense fallback={<Loading />}>
        <View />
      </Suspense>
    </ViewBoundary>
  );
}
