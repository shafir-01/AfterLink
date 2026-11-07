declare module 'qrcode' {
  interface Options {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    width?: number;
    scale?: number;
    color?: { dark?: string; light?: string };
  }
  interface QRCodeData {
    modules: { size: number; data: Uint8Array; get(row: number, col: number): number };
    version: number;
  }
  const QRCode: {
    create(text: string, options?: Options): QRCodeData;
    toCanvas(canvas: HTMLCanvasElement, text: string, options?: Options): Promise<void>;
  };
  export default QRCode;
}
