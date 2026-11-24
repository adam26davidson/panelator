import { type FrameContext, presentFrame } from "./present.ts";
import type { Environment, Scene } from "./scene.ts";

/** The live environment: the wall clock read once per tick, the browser's offset (east of UTC) and crypto randomness. */
export function liveEnvironment(): Environment {
  return {
    time: () => {
      const date = new Date();
      return { unixMs: date.getTime(), offsetS: -date.getTimezoneOffset() * 60 };
    },
    random: () => () => crypto.getRandomValues(new Uint32Array(1))[0] as number,
  };
}

export interface LiveOptions {
  context: FrameContext;
  /** Milliseconds, monotonic (performance.now). */
  clock: () => number;
  /** requestAnimationFrame. */
  requestFrame: (callback: () => void) => unknown;
  onTick?: (tick: number) => void;
  onError?: (error: unknown) => void;
}

export interface Live {
  pause(): void;
  resume(): void;
  stop(): void;
}

const TICK_MS = 1000 / 60;
const SKIP_OVER = 30;

/**
 * Drives a scene at 60 ticks a second of `clock`, whatever the refresh rate: each animation frame runs the ticks that
 * became due, then presents once. More than 30 due ticks are skipped to the newest. Paused, it steps nothing, and the time
 * lost is not caught up on resume.
 */
export function runLive(scene: Scene, options: LiveOptions): Live {
  const { context, clock, requestFrame, onTick, onError } = options;
  let base = clock() - (scene.tick + 1) * TICK_MS;
  let paused = false;
  let stopped = false;

  const frame = (): void => {
    if (stopped) return;
    if (!paused) {
      try {
        const next = scene.tick + 1;
        const dueTotal = Math.floor(((clock() - base) * 60) / 1000 + 1e-6) + 1;
        const due = dueTotal - next;
        if (due > SKIP_OVER) {
          scene.step(dueTotal - 1);
          onTick?.(scene.tick);
        } else if (due > 0) {
          for (let i = 0; i < due; i++) {
            scene.step();
            onTick?.(scene.tick);
          }
        }
        if (due > 0) presentFrame(context, scene.frame, scene.panel.width, scene.panel.height);
      } catch (e) {
        stopped = true;
        onError?.(e);
        return;
      }
    }
    requestFrame(frame);
  };
  requestFrame(frame);
  return {
    pause() {
      paused = true;
    },
    resume() {
      if (!paused) return;
      paused = false;
      base = clock() - (scene.tick + 1) * TICK_MS;
    },
    stop() {
      stopped = true;
    },
  };
}
