import * as ferry from '@afterlink/ferry';
import type { FerryFrame, FerryPacket } from '@afterlink/protocol';

interface FerryApi {
  toFrames(p: FerryPacket): Promise<FerryFrame[]>;
  renderFrame(canvas: HTMLCanvasElement, f: FerryFrame): Promise<void>;
  readFrame(image: ImageData): FerryFrame | null;
  frameText(f: FerryFrame): string;
  parseFrameText(text: string): FerryFrame | null;
  FrameAssembler: new () => {
    add(f: FerryFrame): { have: number; total: number };
    done: boolean;
    packet(): Promise<FerryPacket>;
  };
}

export const api = ferry as unknown as FerryApi;
