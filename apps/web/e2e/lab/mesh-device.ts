import { Author, EventLog, type ActorId, type TaskSpec } from '@afterlink/protocol';
import { Mesh, attachSync, portSignalClient, webrtcConnector, type SyncHandle } from '@afterlink/mesh';

const MISSION = 'mesh-lab';

const spec = (id: string, pad: number): TaskSpec => ({
  id,
  kind: 'first-aid',
  title: `Request ${id}${'.'.repeat(pad)}`,
  brief: 'Send a first aid team.',
  objective: 'care',
  priority: 2,
  location: { x: 1, y: 2 },
  locationName: 'North lawn',
  requires: [],
  needs: [],
  dependsOn: [],
  reversible: true,
});

let mesh: Mesh;
let log: EventLog;
let author: Author;
let sync: SyncHandle;
let nextId = 0;

addEventListener('message', (e: MessageEvent) => {
  if (e.data?.t === 'boot') {
    const { keys, peers } = e.data as { keys: { publicKey: ActorId; secretKey: string }; peers: ActorId[] };
    log = new EventLog(MISSION);
    author = new Author(keys, log);
    mesh = new Mesh({ self: keys.publicKey, peers, connector: webrtcConnector(), room: 'lab' });
    sync = attachSync(mesh, log, () => undefined);
    mesh.start();
  } else if (e.data?.t === 'ports') {
    mesh.setSignal(portSignalClient(e.ports[0]!, { heartbeatMs: 300, timeoutMs: 1000 }));
  }
});

const lab = {
  emit(n = 1, pad = 0) {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      nextId += 1;
      ids.push(author.emit('task.created', { spec: spec(`${mesh.self.slice(0, 6)}-${nextId}`, pad), source: { kind: 'human' } }).id);
    }
    sync.nudge();
    return ids;
  },
  ids: () => log.all().map((e) => e.id),
  has: (id: string) => log.has(id),
  size: () => log.size,
  summary: () => log.summary(),
  links: () => mesh.links(),
  reachable: () => mesh.reachable(),
  signalUp: () => mesh.signalUp,
  block: (peers: ActorId[]) => mesh.setFaults({ blocked: peers }),
};

Object.assign(window, { lab });
