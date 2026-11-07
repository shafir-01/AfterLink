import { Author, EventLog, generateKeys, type EventBodies, type FerryPacket, type TaskSpec } from '@afterlink/protocol';
import { FrameAssembler, buildPacket, ingestPacket, readFrame, renderFrame, toFrames, verifyPacket, type WireFrame } from '@afterlink/ferry';

const MISSION = 'ferry-lab';

const spec = (n: number): TaskSpec => ({
  id: `task-${n}`,
  kind: 'first-aid',
  title: `Assistance request ${n} near the north lawn`,
  brief: 'Send a first aid team and report when the person is stable.',
  objective: 'care',
  priority: 1,
  location: { x: n, y: 40 },
  locationName: 'North lawn',
  requires: ['first-aid'],
  needs: [],
  dependsOn: [],
  reversible: true,
});

async function pixelsOf(canvas: HTMLCanvasElement, frame: WireFrame) {
  await renderFrame(canvas, frame);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

async function carry(frames: WireFrame[], canvas: HTMLCanvasElement): Promise<FerryPacket> {
  const assembler = new FrameAssembler();
  for (const frame of [...frames].reverse()) {
    const decoded = readFrame(await pixelsOf(canvas, frame));
    if (!decoded) throw new Error(`frame ${frame.i} did not decode from canvas pixels`);
    assembler.add(decoded);
  }
  if (!assembler.done) throw new Error('assembler incomplete');
  return assembler.packet();
}

async function run(eventCount: number) {
  const keys = generateKeys();
  const sender = new EventLog(MISSION);
  const receiver = new EventLog(MISSION);
  const author = new Author(keys, sender);
  for (let n = 0; n < eventCount; n += 1) {
    author.emit('task.created', { spec: spec(n), source: { kind: 'human' } } satisfies EventBodies['task.created']);
  }

  const packet = buildPacket({ keys, log: sender, remote: receiver.summary() });
  const frames = await toFrames(packet);
  const canvas = document.querySelector<HTMLCanvasElement>('#sender')!;

  const started = performance.now();
  const carried = await carry(frames, canvas);
  const decodeMs = performance.now() - started;

  const first = ingestPacket(receiver, carried, { mission: MISSION });
  const headsAfterFirst = JSON.stringify(receiver.summary());
  const replay = ingestPacket(receiver, await carry(frames, canvas), { mission: MISSION });
  const headsAfterReplay = JSON.stringify(receiver.summary());

  const tampered: FerryPacket = JSON.parse(JSON.stringify(carried));
  (tampered.events[0]!.body as EventBodies['task.created']).spec.title = 'tampered';

  return {
    frames: frames.length,
    canvas: { width: canvas.width, height: canvas.height },
    decodeMs: Math.round(decodeMs),
    verified: verifyPacket(carried).ok,
    tamperedVerified: verifyPacket(tampered).ok,
    first,
    replay,
    replayChangedHeads: headsAfterFirst !== headsAfterReplay,
    receiverSize: receiver.size,
    senderSize: sender.size,
  };
}

Object.assign(window, { ferryLab: { run } });
