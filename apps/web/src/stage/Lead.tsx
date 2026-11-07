import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { useRoute } from '../ui/route';
import type { StageDevice } from './contract';
import { MissionController } from './controller';
import { Join } from './Join';
import { RelayHost } from './relayHost';
import { Screen } from './Screen';

function JoinCode({ link, name }: { link: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvas.current) void QRCode.toCanvas(canvas.current, link, { errorCorrectionLevel: 'L', margin: 2, width: 560 });
  }, [link]);

  return (
    <a className="st-join-code" href={link} target="_blank" rel="noreferrer" aria-label={`Open ${name} on a phone`}>
      <canvas ref={canvas} aria-hidden="true" />
    </a>
  );
}

const CONNECTION = (seat: StageDevice) => {
  const open = seat.links.some((l) => l.state === 'open');
  return !open ? 'Alone' : seat.signalUp ? 'Connected' : 'Team only';
};

/** One real phone, as far as the lead can see it. */
function PhoneCard({ seat, link, joined }: { seat: StageDevice; link?: string; joined: boolean }) {
  const held = seat.view?.held ?? [];
  return (
    <div className="st-card">
      <header>
        <h2>{seat.name}</h2>
        <span>{joined ? CONNECTION(seat) : 'Scan to join'}</span>
      </header>
      {!joined && link ? (
        <JoinCode link={link} name={seat.name} />
      ) : (
        <>
          <p className="st-card-task">{seat.task?.title ?? 'Standing by'}</p>
          {seat.task && <p className="st-card-where">{seat.task.locationName}</p>}
          {held.length > 0 && <p className="st-card-held">{held.join(', ')}</p>}
        </>
      )}
    </div>
  );
}

function LeadRoom() {
  const host = useMemo(() => new RelayHost(), []);
  const controller = useMemo(() => new MissionController(host), [host]);
  const room = useSyncExternalStore(host.subscribe, host.roomState);

  return (
    <Screen
      controller={controller}
      card={(seat) => <PhoneCard seat={seat} link={room.links[seat.id]} joined={room.joined.includes(seat.id)} />}
      switchTo={{ href: '#/', label: 'Solo demo' }}
      waiting={`${room.joined.length} of 4 phones`}
    />
  );
}

export function Lead() {
  const route = useRoute();
  const join = route.params.get('join');
  return join ? <Join encoded={join} relay={route.params.get('relay') ?? undefined} /> : <LeadRoom />;
}

export default Lead;
