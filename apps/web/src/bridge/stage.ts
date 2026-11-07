import { unwrap, wrap, type DeviceCommand, type DeviceReport } from './protocol';

/**
 * URL for one device iframe. The query keeps the frame's URL distinct from the stage's,
 * so browsers never treat it as a recursive embed.
 */
export function deviceSrc(slot: string): string {
  const name = encodeURIComponent(slot);
  return `${window.location.pathname}?device=${name}#/device?slot=${name}`;
}

/**
 * The stage's only handle on a device: send commands, hear reports.
 * Commands sent before the iframe has loaded wait in order until it says it is ready.
 */
export class DeviceHandle {
  private readonly listeners = new Set<(report: DeviceReport) => void>();
  private queue: { command: DeviceCommand; transfer: Transferable[] }[] = [];
  private frame: HTMLIFrameElement | null = null;
  private ready = false;

  constructor(readonly slot: string) {
    window.addEventListener('message', this.receive);
  }

  /** Binds the iframe element. Safe as a ref callback: React's null between renders changes nothing. */
  attach(frame: HTMLIFrameElement | null) {
    if (!frame || frame === this.frame) return;
    this.frame = frame;
    this.ready = false;
  }

  send(command: DeviceCommand, transfer: Transferable[] = []) {
    if (this.ready && this.frame?.contentWindow) this.post(command, transfer);
    else this.queue.push({ command, transfer });
  }

  on(listener: (report: DeviceReport) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    window.removeEventListener('message', this.receive);
    this.listeners.clear();
    this.queue = [];
    this.frame = null;
  }

  private post(command: DeviceCommand, transfer: Transferable[]) {
    this.frame!.contentWindow!.postMessage(wrap(command), window.location.origin, transfer);
  }

  private readonly receive = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if (!this.frame || event.source !== this.frame.contentWindow) return;
    const report = unwrap<DeviceReport>(event.data);
    if (!report) return;
    if (report.kind === 'ready') {
      this.ready = true;
      const pending = this.queue;
      this.queue = [];
      for (const { command, transfer } of pending) this.post(command, transfer);
    }
    this.listeners.forEach((listener) => listener(report));
  };
}
