/** The part of a 2D canvas context the presenter uses; a real CanvasRenderingContext2D fits. */
export interface FrameContext {
  createImageData(width: number, height: number): { data: Uint8ClampedArray };
  putImageData(image: never, dx: number, dy: number): void;
}

/** Writes a frame to a 2D context: one canvas pixel per LED, alpha 255, no scaling, smoothing or colour conversion. */
export function presentFrame(context: FrameContext, frame: Uint8Array, width: number, height: number): void {
  const image = context.createImageData(width, height);
  const out = image.data;
  for (let i = 0, o = 0; i < width * height * 3; i += 3, o += 4) {
    out[o] = frame[i] as number;
    out[o + 1] = frame[i + 1] as number;
    out[o + 2] = frame[i + 2] as number;
    out[o + 3] = 255;
  }
  context.putImageData(image as never, 0, 0);
}
