const ports = new Map();

self.onmessage = (e) => {
  if (e.data?.t !== 'attach') return;
  const port = e.ports[0];
  port.onmessage = (ev) => {
    const m = ev.data;
    if (m.t === 'hello') {
      const peers = [...ports.keys()].filter((id) => id !== m.id);
      ports.set(m.id, port);
      port.postMessage({ t: 'peers', peers });
    } else if (m.t === 'signal') {
      ports.get(m.to)?.postMessage(m);
    } else if (m.t === 'ping') {
      port.postMessage({ t: 'pong', n: m.n });
    } else if (m.t === 'close-port') {
      port.close();
    }
  };
};
