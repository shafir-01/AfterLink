import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { festivalCapsule, provision } from '@afterlink/mission';
import { clearLeadMission, loadApprovedCapsule, loadLeadMission, organiserKeys, saveLeadMission, type LeadMission } from '../bridge/missionStore';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Notice } from '../ui/guarded';
import { Stack } from '../ui/Stack';
import { Text } from '../ui/Text';
import { deviceLink } from './provisionLink';
import './provision.css';

const QUIET_ZONE = 4;
const COPY_FEEDBACK_MS = 2000;
const COPY_LABEL = { idle: 'Copy link', copied: 'Copied', failed: 'Could not copy' };

async function issueMission(): Promise<LeadMission> {
  const organiser = await organiserKeys();
  const approved = await loadApprovedCapsule();
  const capsule = approved?.issuer === organiser.publicKey ? approved : festivalCapsule(organiser);
  const room = `lead-${Date.now().toString(36)}`;
  const mission = { room, name: capsule.name, bundles: provision(capsule, organiser, room).bundles };
  await saveLeadMission(mission);
  return mission;
}

/** The clipboard API exists only on secure origins, and a phone-reachable address is usually plain http. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const focused = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    area.value = text;
    area.readOnly = true;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    focused?.focus();
    return copied;
  }
}

/** Draws a whole number of device pixels per module: a dense code stops scanning if modules are resampled unevenly. */
function Code({ text, label, onTooLarge }: { text: string; label: string; onTooLarge: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const box = host.current;
    const target = canvas.current;
    if (!box || !target || !text) return;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      try {
        const modules = QRCode.create(text, { errorCorrectionLevel: 'L' }).modules.size + QUIET_ZONE * 2;
        const scale = Math.max(1, Math.floor((box.clientWidth * ratio) / modules));
        void QRCode.toCanvas(target, text, { errorCorrectionLevel: 'L', margin: QUIET_ZONE, scale }).then(() => {
          target.style.width = target.style.height = `${target.width / ratio}px`;
        });
      } catch {
        onTooLarge();
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text, onTooLarge]);

  return (
    <div ref={host} className="al-provision__code">
      <canvas ref={canvas} role="img" aria-label={label} />
    </div>
  );
}

/** Issues a mission and puts each team on a real phone, one code at a time. */
export default function Provision() {
  const [mission, setMission] = useState<LeadMission | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [link, setLink] = useState('');
  const [codeFits, setCodeFits] = useState(true);
  const [copyState, setCopyState] = useState<keyof typeof COPY_LABEL>('idle');
  const [replacing, setReplacing] = useState(false);
  const tooLarge = useCallback(() => setCodeFits(false), []);

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
    setCopyState('idle');
    setCodeFits(true);
    void deviceLink(bundle, import.meta.env.VITE_RELAY_URL).then((next) => live && setLink(next));
    return () => {
      live = false;
    };
  }, [bundle]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copyState]);

  const copy = async () => setCopyState((await copyText(link)) ? 'copied' : 'failed');

  /** Phones already set up stay on the old mission, so replacing it takes a second press. */
  const replace = async () => {
    if (!replacing) {
      setReplacing(true);
      return;
    }
    setReplacing(false);
    setMission(null);
    setSelected(0);
    try {
      await clearLeadMission();
      setMission(await issueMission());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };

  if (failure) return <Notice title="Could not issue mission" detail={failure} />;
  if (!mission || !bundle) return null;

  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  return (
    <main className="al-provision">
      <Stack gap={6} className="al-provision__side">
        <Stack gap={2}>
          <Text variant="title" as="h1">
            Set up phones
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

        {local ? <Text tone="warn">Phones can't reach localhost. Use your network address.</Text> : null}

        <Stack direction="row" gap={2} wrap align="center">
          <Button variant={codeFits ? 'secondary' : 'primary'} size={codeFits ? 'medium' : 'large'} onClick={() => void copy()} disabled={!link}>
            {COPY_LABEL[copyState]}
          </Button>
          <Button variant="quiet" onClick={() => void replace()} onBlur={() => setReplacing(false)}>
            {replacing ? 'Replace mission?' : 'New mission'}
          </Button>
        </Stack>
      </Stack>

      {codeFits ? <Code text={link} label={`Code that opens ${bundle.name} on a phone`} onTooLarge={tooLarge} /> : <Text tone="muted">Link too long for a code.</Text>}
      <span className="al-visually-hidden" role="status">
        {copyState === 'copied' ? 'Link copied' : copyState === 'failed' ? 'Could not copy the link' : ''}
      </span>
    </main>
  );
}
