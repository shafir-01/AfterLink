import type { ActorNode } from '@afterlink/actor';
import { FrameAssembler, readFrame, renderFrame, toFrames } from '@afterlink/ferry';
import type { SyncSummary } from '@afterlink/protocol';
import { reportToStage } from '../bridge/device';
import type { FramePixels } from '../bridge/protocol';

const FRAME_MS = 110;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds a signed packet and shows it frame by frame. The pixels are what leaves this device. */
export async function sendFerry(node: ActorNode, ferryId: string, remote?: SyncSummary, frameMs = FRAME_MS) {
  const packet = node.buildFerry(remote);
  const frames = await toFrames(packet);
  const canvas = document.createElement('canvas');
  for (const [index, frame] of frames.entries()) {
    await renderFrame(canvas, frame);
    const image = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
    const pixels: FramePixels = { width: image.width, height: image.height, data: image.data };
    reportToStage({ kind: 'ferryFrame', ferryId, packetId: packet.id, index, total: frames.length, pixels }, [image.data.buffer]);
    await wait(frameMs);
  }
  reportToStage({ kind: 'ferrySent', ferryId, packetId: packet.id, frames: frames.length, events: packet.events.length });
}

/** Decodes received pixels with the same path a camera uses, and ingests the finished packet once. */
export class FerryReceiver {
  private ferryId: string | null = null;
  private assembler = new FrameAssembler();
  private finished = false;

  async take(node: ActorNode, ferryId: string, pixels: FramePixels) {
    if (ferryId !== this.ferryId) {
      this.ferryId = ferryId;
      this.assembler = new FrameAssembler();
      this.finished = false;
    }
    if (this.finished) return;
    const frame = readFrame(pixels as ImageData);
    if (!frame) return;
    const { have, total } = this.assembler.add(frame);
    reportToStage({ kind: 'ferryProgress', ferryId, have, total });
    if (!this.assembler.done) return;
    this.finished = true;
    const packet = await this.assembler.packet();
    const { newEvents, duplicates, rejected, reason } = node.ingestFerry(packet);
    if (reason) reportToStage({ kind: 'ferryRejected', ferryId, reason });
    else reportToStage({ kind: 'ferryResult', ferryId, packetId: packet.id, from: packet.from, newEvents, duplicates, rejected });
  }
}
