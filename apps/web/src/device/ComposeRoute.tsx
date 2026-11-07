import { Suspense, useEffect, useState } from 'react';
import type { MissionCapsule } from '@afterlink/protocol';
import { clearLeadMission, organiserKeys, saveApprovedCapsule } from '../bridge/missionStore';
import { guardedView } from '../ui/guarded';
import { navigate } from '../ui/route';

const Compose = guardedView<{ onApprove: (capsule: MissionCapsule) => void; issuer?: string }>(
  import.meta.glob('../compose/{index,ComposeMission,Compose}.{ts,tsx}'),
  ['index', 'ComposeMission', 'Compose'],
  'ComposeMission',
  'Compose',
);

export default function ComposeRoute() {
  const [issuer, setIssuer] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void organiserKeys().then((keys) => live && setIssuer(keys.publicKey));
    return () => {
      live = false;
    };
  }, []);

  const approve = async (capsule: MissionCapsule) => {
    await saveApprovedCapsule(capsule);
    await clearLeadMission();
    navigate('/lead');
  };

  return (
    <>
      <header>
        <h1 className="al-visually-hidden">Compose a mission</h1>
      </header>
      {issuer ? (
        <Suspense fallback={null}>
          <Compose onApprove={(capsule) => void approve(capsule)} issuer={issuer} />
        </Suspense>
      ) : null}
    </>
  );
}
