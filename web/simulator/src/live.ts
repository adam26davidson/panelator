import type { Environment, Scene } from "./scene.ts";

/** The part of a 2D canvas context that `presentFrame` uses. */
export interface FrameContext {
  createImageData(width: number, height: number): { data: Uint8ClampedArray };
  putImageData(image: never, x: number, y: number): void;
}

/** One canvas pixel per LED: the frame's red, green and blue and alpha 255, no scaling, smoothing or conversion. */
export function presentFrame(context: FrameContext, frame: Uint8Array, width: number, height: number): void {
  const image = context.createImageData(width, height);
  const px = image.data;
  for (let i = 0, n = width * height; i < n; i++) {
    px[i * 4] = frame[i * 3] as number;
    px[i * 4 + 1] = frame[i * 3 + 1] as number;
    px[i * 4 + 2] = frame[i * 3 + 2] as number;
    px[i * 4 + 3] = 255;
  }
  context.putImageData(image as never, 0, 0);
}

/** The offset east of UTC, in seconds, from `Date.getTimezoneOffset()` (minutes west); never `-0`. */
export const eastOffsetSeconds = (minutesWest: number): number => 0 - minutesWest * 60;

/** The live environment: the wall clock read once per tick, the browser's offset, `crypto.getRandomValues`. */
export function liveEnvironment(now: () => number = Date.now): Environment {
  return {
    time: () => {
      const ms = now();
      return { unixMs: BigInt(Math.trunc(ms)), offsetS: eastOffsetSeconds(new Date(ms).getTimezoneOffset()) };
    },
    random: () => () => crypto.getRandomValues(new Uint32Array(1))[0] as number,
  };
}

export interface LiveOptions {
  context: FrameContext;
  /** Milliseconds, monotonic (`performance.now`). */
  clock: () => number;
  /** `requestAnimationFrame`. */
  requestFrame: (callback: () => void) => unknown;
  onTick?: (tick: number) => void;
  onError?: (error: unknown) => void;
}

export interface LiveRun {
  pause(): void;
  resume(): void;
  stop(): void;
}

/** More due ticks than this and the missed ones are skipped. */
export const MAX_CATCH_UP_TICKS = 30;

/** Drives a scene at 60 ticks a second of `clock`, whatever the display's refresh rate. */
export function runLive(scene: Scene, options: LiveOptions): LiveRun {
  const { context, clock, requestFrame } = options;
  let stopped = false;
  let paused = false;
  let pending = false;
  let origin: number | undefined;

  const request = (): void => {
    if (stopped || paused || pending) return;
    pending = true;
    requestFrame(frame);
  };

  const frame = (): void => {
    pending = false;
    if (stopped || paused) return;
    const now = clock();
    origin ??= now - (scene.tick < 0 ? 0 : scene.tick) * (1000 / 60);
    const newest = Math.floor(((now - origin) * 60) / 1000 + 1e-9);
    const due = newest - scene.tick;
    try {
      if (due > MAX_CATCH_UP_TICKS) scene.step(newest);
      else if (due > 0) for (let i = 0; i < due; i++) scene.step();
      else {
        request();
        return;
      }
      presentFrame(context, scene.frame, scene.panel.width, scene.panel.height);
    } catch (error) {
      stopped = true;
      options.onError?.(error);
      return;
    }
    options.onTick?.(scene.tick);
    request();
  };

  request();
  return {
    pause() {
      paused = true;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      origin = undefined; // time lost while paused is not caught up on
      request();
    },
    stop() {
      stopped = true;
    },
  };
}
