/**
 * HQ: signalling hub and read-only observer. Terminating this worker is the kill switch.
 * Devices keep their direct links, because signalling is not in the data path.
 */
import { createHub, servePort } from '@afterlink/mesh';
import type { HqCommand, HqNotice } from './protocol';

const STATE_MS = 100;

const scope = self as unknown as Worker;
const hub = createHub();
const served = new Map<string, () => void>();

function notify(notice: HqNotice) {
  scope.postMessage(notice);
}

let stateQueued = false;
function publishState() {
  if (stateQueued) return;
  stateQueued = true;
  setTimeout(() => {
    stateQueued = false;
    notify({ kind: 'state', state: hub.state(), at: Date.now() });
  }, STATE_MS);
}

scope.onmessage = (event: MessageEvent<HqCommand>) => {
  const command = event.data;
  if (command.kind === 'ingress') {
    hub.ingress(command.ref, command.spec);
    return;
  }
  const [port] = event.ports;
  if (!port) return;
  served.get(command.slot)?.();
  served.set(command.slot, servePort(hub, port));
};

hub.onChange(publishState);
notify({ kind: 'started' });
