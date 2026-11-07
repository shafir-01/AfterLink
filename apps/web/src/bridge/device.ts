import { unwrap, wrap, type DeviceCommand, type DeviceReport } from './protocol';

export function insideStage(): boolean {
  return window.parent !== window;
}

export function reportToStage(report: DeviceReport, transfer: Transferable[] = []) {
  if (insideStage()) window.parent.postMessage(wrap(report), window.location.origin, transfer);
}

/** Listens for stage commands, then tells the stage this device is ready for them. */
export function listenToStage(handler: (command: DeviceCommand, ports: readonly MessagePort[]) => void): () => void {
  const receive = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const command = unwrap<DeviceCommand>(event.data);
    if (command) handler(command, event.ports);
  };
  window.addEventListener('message', receive);
  reportToStage({ kind: 'ready' });
  return () => window.removeEventListener('message', receive);
}
