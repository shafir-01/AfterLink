import type { SignalClient, SignalMessage } from '@afterlink/protocol';
import { every, systemClock, type Clock } from './clock.ts';
import { HEARTBEAT, type Hub, type HubFrame } from './hub.ts';

class SignalListeners {
  connected = false;
  private messageFns = new Set<(m: SignalMessage) => void>();
  private stateFns = new Set<(up: boolean) => void>();

  onMessage(fn: (m: SignalMessage) => void): void {
    this.messageFns.add(fn);
  }

  onState(fn: (up: boolean) => void): void {
    this.stateFns.add(fn);
  }

  emit(m: SignalMessage): void {
    for (const fn of [...this.messageFns]) fn(m);
  }

  setUp(up: boolean): void {
    if (this.connected === up) return;
    this.connected = up;
    for (const fn of [...this.stateFns]) fn(up);
  }
}

export interface PortClientOptions {
  clock?: Clock;
  heartbeatMs?: number;
  timeoutMs?: number;
}

/**
 * Signalling over a MessagePort. A port gives no notice when the worker behind it is terminated,
 * so the hub's presence is proven by heartbeat answers: down means no answer inside the timeout.
 */
export function portSignalClient(port: MessagePort, o: PortClientOptions = {}): SignalClient {
  const clock = o.clock ?? systemClock;
  const timeoutMs = o.timeoutMs ?? 2500;
  const listeners = new SignalListeners();
  let lastHeardAt = -Infinity;

  port.onmessage = (e: MessageEvent<HubFrame>) => {
    lastHeardAt = clock.now();
    listeners.setUp(true);
    if (e.data?.t !== 'hb') listeners.emit(e.data);
  };

  const beat = () => {
    if (clock.now() - lastHeardAt > timeoutMs) listeners.setUp(false);
    port.postMessage(HEARTBEAT);
  };
  const stopBeat = every(clock, o.heartbeatMs ?? 800, beat);
  port.postMessage(HEARTBEAT);

  return {
    get connected() {
      return listeners.connected;
    },
    send(msg) {
      if (listeners.connected) port.postMessage(msg);
    },
    onMessage: (fn) => listeners.onMessage(fn),
    onState: (fn) => listeners.onState(fn),
    close() {
      stopBeat();
      port.onmessage = null;
      port.close();
      listeners.setUp(false);
    },
  };
}

/** Worker side of a port: connects one MessagePort to the hub. Returns a disconnect function. */
export function servePort(hub: Hub, port: MessagePort): () => void {
  const conn = hub.connect((m) => port.postMessage(m));
  port.onmessage = (e: MessageEvent<SignalMessage>) => conn.receive(e.data);
  return () => {
    conn.close();
    port.close();
  };
}

export interface WsClientOptions {
  clock?: Clock;
  WebSocket?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  heartbeatMs?: number;
  timeoutMs?: number;
}

/** Signalling over WebSocket. Keeps trying with backoff, so links can re-form whenever the server returns. */
export function wsSignalClient(url: string, o: WsClientOptions = {}): SignalClient {
  const clock = o.clock ?? systemClock;
  const Socket = o.WebSocket ?? globalThis.WebSocket;
  const minBackoffMs = o.minBackoffMs ?? 250;
  const maxBackoffMs = o.maxBackoffMs ?? 5000;
  const timeoutMs = o.timeoutMs ?? 12000;
  const listeners = new SignalListeners();
  let socket: WebSocket | null = null;
  let backoffMs = minBackoffMs;
  let retryTimer: unknown = null;
  let lastHeardAt = 0;
  let closed = false;

  const lost = (from: WebSocket) => {
    if (socket !== from) return;
    socket = null;
    from.onopen = from.onmessage = from.onclose = from.onerror = null;
    try {
      from.close();
    } catch {
      // Already closed.
    }
    listeners.setUp(false);
    schedule();
  };

  const schedule = () => {
    if (closed || retryTimer !== null) return;
    const wait = backoffMs * (0.75 + Math.random() * 0.5);
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      open();
    }, wait);
  };

  const open = () => {
    if (closed || socket) return;
    let ws: WebSocket;
    try {
      ws = new Socket(url);
    } catch {
      schedule();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      backoffMs = minBackoffMs;
      lastHeardAt = clock.now();
      listeners.setUp(true);
    };
    ws.onmessage = (e) => {
      lastHeardAt = clock.now();
      let frame: HubFrame;
      try {
        frame = JSON.parse(String(e.data)) as HubFrame;
      } catch {
        return;
      }
      if (frame?.t !== 'hb') listeners.emit(frame);
    };
    ws.onclose = () => lost(ws);
    ws.onerror = () => lost(ws);
  };

  const stopBeat = every(clock, o.heartbeatMs ?? 4000, () => {
    if (!socket || !listeners.connected) return;
    if (clock.now() - lastHeardAt > timeoutMs) lost(socket);
    else socket.send(JSON.stringify(HEARTBEAT));
  });

  open();

  return {
    get connected() {
      return listeners.connected;
    },
    send(msg) {
      if (listeners.connected) socket?.send(JSON.stringify(msg));
    },
    onMessage: (fn) => listeners.onMessage(fn),
    onState: (fn) => listeners.onState(fn),
    close() {
      closed = true;
      stopBeat();
      clock.clearTimeout(retryTimer);
      if (socket) lost(socket);
    },
  };
}
