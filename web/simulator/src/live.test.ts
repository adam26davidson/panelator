import { describe, expect, it } from "vitest";
import { SimulatorError } from "./errors.ts";
import { eastOffsetSeconds, type FrameContext, liveEnvironment, presentFrame, runLive } from "./live.ts";
import type { Environment, Scene } from "./scene.ts";
import { fixedEnv, sceneOf } from "./scenehelp.ts";

class Fixture {
  now = 0;
  queue: (() => void)[] = [];
  requests = 0;
  presents = 0;
  timeReads = 0;
  context: FrameContext = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {
      this.presents++;
    },
  };
  env: Environment = { time: () => (this.timeReads++, { unixMs: 0n, offsetS: 0 }), random: fixedEnv().random };
  ticks: number[] = [];
  errors: unknown[] = [];
  scene!: Scene;

  async start(update: number[] = []) {
    this.scene = await sceneOf({ width: 2, height: 1 }, [{ width: 2, height: 1, spec: { update } }], {
      environment: this.env,
    });
    this.timeReads = 0;
    return runLive(this.scene, {
      context: this.context,
      clock: () => this.now,
      requestFrame: (cb) => {
        this.requests++;
        this.queue.push(cb);
      },
      onTick: (t) => this.ticks.push(t),
      onError: (e) => this.errors.push(e),
    });
  }
  /** One animation frame at `ms`. */
  frame(ms: number) {
    this.now = ms;
    const q = this.queue;
    this.queue = [];
    for (const cb of q) cb();
  }
}

const SIXTIETH = 1000 / 60;

describe("runLive (AC-10)", () => {
  it("runs one tick per frame at 60 Hz, two at 30 Hz, one per two frames at 120 Hz", async () => {
    const a = new Fixture();
    await a.start();
    for (let k = 0; k < 10; k++) a.frame(k * SIXTIETH);
    expect(a.scene.tick).toBe(9);
    expect(a.ticks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const b = new Fixture();
    await b.start();
    for (let k = 0; k < 5; k++) b.frame(k * 2 * SIXTIETH);
    expect(b.ticks).toEqual([0, 2, 4, 6, 8]);
    expect(b.timeReads).toBe(9); // one read per tick

    const c = new Fixture();
    await c.start();
    for (let k = 0; k < 10; k++) c.frame((k * SIXTIETH) / 2);
    expect(c.ticks).toEqual([0, 1, 2, 3, 4]); // a frame that ran no tick reports none
  });

  it("presents once per frame that ran ticks", async () => {
    const f = new Fixture();
    await f.start();
    f.frame(0);
    f.frame(2 * SIXTIETH + 1);
    expect(f.presents).toBe(2);
    f.frame(2 * SIXTIETH + 2);
    expect(f.presents).toBe(2);
  });

  it("skips past more than 30 due ticks to the newest due tick, running one step", async () => {
    const f = new Fixture();
    await f.start();
    f.frame(0);
    f.timeReads = 0;
    f.frame(31.5 * SIXTIETH);
    expect(f.scene.tick).toBe(31);
    expect(f.timeReads).toBe(1);
    f.frame(31.5 * SIXTIETH + 3 * SIXTIETH);
    expect(f.scene.tick).toBe(34);
  });

  it("does not skip at exactly 30 due", async () => {
    const f = new Fixture();
    await f.start();
    f.frame(0);
    f.timeReads = 0;
    f.frame(30 * SIXTIETH);
    expect(f.scene.tick).toBe(30);
    expect(f.timeReads).toBe(30);
  });

  it("pauses (steps nothing), resumes without catching up, and stops (requests no more frames)", async () => {
    const f = new Fixture();
    const run = await f.start();
    f.frame(0);
    f.frame(SIXTIETH);
    run.pause();
    f.frame(100 * SIXTIETH);
    expect(f.scene.tick).toBe(1);
    expect(f.queue).toHaveLength(0);
    run.resume();
    f.frame(200 * SIXTIETH);
    expect(f.scene.tick).toBe(1);
    f.frame(201 * SIXTIETH);
    expect(f.scene.tick).toBe(2);
    run.stop();
    const before = f.requests;
    f.frame(300 * SIXTIETH);
    expect(f.requests).toBe(before);
    expect(f.scene.tick).toBe(2);
  });

  it("an error from a step stops it and is reported", async () => {
    const f = new Fixture();
    await f.start([0x00]); // unreachable on every update
    f.frame(0);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]).toBeInstanceOf(SimulatorError);
    expect(f.queue).toHaveLength(0);
  });
});

describe("the live environment (AC-10)", () => {
  it("reads the offset east of UTC, never -0, and 32 random bits", () => {
    expect(Object.is(eastOffsetSeconds(0), 0)).toBe(true);
    expect(eastOffsetSeconds(-60)).toBe(3600);
    expect(eastOffsetSeconds(300)).toBe(-18000);
    const ms = 1_800_000_000_000;
    const e = liveEnvironment(() => ms);
    const t = e.time(0);
    expect(t.unixMs).toBe(BigInt(ms));
    expect(t.offsetS).toBe(eastOffsetSeconds(new Date(ms).getTimezoneOffset()));
    expect(Object.is(t.offsetS, -0)).toBe(false);
    const r = e.random(0)();
    expect(Number.isInteger(r) && r >= 0 && r <= 0xffffffff).toBe(true);
  });
});

describe("presentFrame (AC-9)", () => {
  it("writes red, green and blue and alpha 255 for each LED", () => {
    let put: Uint8ClampedArray | undefined;
    const ctx: FrameContext = {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image) => {
        put = (image as { data: Uint8ClampedArray }).data;
      },
    };
    presentFrame(ctx, Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, 1);
    expect([...(put as Uint8ClampedArray)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });
});
