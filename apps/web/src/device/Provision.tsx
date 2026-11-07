import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { festivalCapsule, provision } from '@afterlink/mission';
import { clearLeadMission, loadApprovedCapsule, loadLeadMission, organiserKeys, saveLeadMission, type LeadMission } from '../bridge/missionStore';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Stack } from '../ui/Stack';
import { Text } from '../ui/Text';
import { deviceLink } from './provisionLink';
import './provision.css';

async function issueMission(): Promise<LeadMission> {
  const organiser = await organiserKeys();
  const approved = await loadApprovedCapsule();
  const capsule = approved?.issuer === organiser.publicKey ? approved : festivalCapsule(organiser);
  const room = `lead-${Date.now().toString(36)}`;
  const mission = { room, name: capsule.name, bundles: provision(capsule, organiser, room).bundles };
  await saveLeadMission(mission);
  return mission;
}

/** Issues a mission and puts each team on a real phone, one code at a time. */
export default function Provision() {
  const [mission, setMission] = useState<LeadMission | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [link, setLink] = useState('');
  const [codeFits, setCodeFits] = useState(true);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    loadLeadMission()
      .then((saved) => saved ?? issueMission())
      .then((next) => live && setMission(next))
      .catch((error: unknown) => live && setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      live = false;
    };
  }, []);

  const teams = mission ? Object.keys(mission.bundles) : [];
  const team = teams[selected];
  const bundle = team ? mission?.bundles[team] : undefined;

  useEffect(() => {
    if (!bundle) return;
    let live = true;
    setCopied(false);
    void deviceLink(bundle, import.meta.env.VITE_RELAY_URL).then((next) => {
      if (!live) return;
      setLink(next);
      if (!canvas.current) return;
      QRCode.toCanvas(canvas.current, next, { errorCorrectionLevel: 'L', margin: 4, scale: 6 })
        .then(() => live && setCodeFits(true))
        .catch(() => live && setCodeFits(false));
    });
    return () => {
      live = false;
    };
  }, [bundle]);

  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  const startOver = async () => {
    setMission(null);
    setSelected(0);
    await clearLeadMission();
    setMission(await issueMission());
  };

  if (failure) {
    return (
      <main className="al-center">
        <Text variant="heading" as="h1">
          This mission could not be issued
        </Text>
        <Text tone="muted">{failure}</Text>
      </main>
    );
  }
  if (!mission || !bundle) return null;

  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  return (
    <main className="al-provision">
      <Stack gap={2}>
        <Text variant="title" as="h1">
          Put each team on a phone
        </Text>
        <Text tone="muted">{mission.name}</Text>
      </Stack>

      <div className="al-provision__teams" role="group" aria-label="Team">
        {teams.map((id, index) => (
          <button key={id} type="button" className="al-provision__team" aria-pressed={index === selected} onClick={() => setSelected(index)}>
            <Badge team={id}>{mission.bundles[id]!.name}</Badge>
          </button>
        ))}
      </div>

      <canvas ref={canvas} className="al-provision__code" hidden={!codeFits} role="img" aria-label={`Code that opens ${bundle.name} on a phone`} />
      {codeFits ? null : <Text tone="muted">This mission is too large for one code. Copy the link instead.</Text>}
      {local ? <Text tone="warn">Phones can't reach localhost. Open this page at your computer's network address.</Text> : null}

      <Stack gap={3}>
        <Button variant="primary" size="large" block onClick={() => void copy()} disabled={!link}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
        <Stack direction="row" gap={2} justify="space-between">
          <Button variant="quiet" disabled={selected === teams.length - 1} onClick={() => setSelected(selected + 1)}>
            Next team
          </Button>
          <Button variant="quiet" onClick={() => void startOver()}>
            New mission
          </Button>
        </Stack>
      </Stack>
      <span className="al-visually-hidden" role="status">
        {copied ? 'Link copied' : ''}
      </span>
    </main>
  );
}
