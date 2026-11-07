import { generateKeys } from '@afterlink/protocol';

const names = ['A', 'B', 'C', 'D'];
const keys = Object.fromEntries(names.map((n) => [n, generateKeys()]));
const frames: Record<string, HTMLIFrameElement> = {};
let worker: Worker | null = null;

const spawn = () => new Worker(new URL('../../src/hq/hq.worker.ts', import.meta.url), { type: 'module', name: 'lab-hq' });

function hand(name: string) {
  const signal = new MessageChannel();
  worker!.postMessage({ kind: 'connect', slot: name }, [signal.port1]);
  frames[name]!.contentWindow!.postMessage({ t: 'ports' }, '*', [signal.port2]);
}

const stage = {
  ids: () => Object.fromEntries(names.map((n) => [n, keys[n]!.publicKey])),
  async load() {
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const f = document.createElement('iframe');
            f.name = name;
            f.src = `mesh-device.html?id=${name}`;
            f.onload = () => resolve();
            frames[name] = f;
            document.getElementById('frames')!.append(f);
          }),
      ),
    );
    for (const name of names) {
      const peers = names.filter((n) => n !== name).map((n) => keys[n]!.publicKey);
      frames[name]!.contentWindow!.postMessage({ t: 'boot', keys: keys[name], peers }, '*');
    }
  },
  startHq() {
    worker = spawn();
    names.forEach(hand);
  },
  killHq() {
    worker!.terminate();
    worker = null;
  },
};

Object.assign(window, { stage });
