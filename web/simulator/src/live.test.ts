import { describe, expect, it } from "vitest";
import { liveEnvironment, runLive } from "./live.ts";
import { type FrameContext, presentFrame } from "./present.ts";
import type { Scene } from "./scene.ts";

/** A fake scene that counts the ticks it runs. */
function fakeScene(failAt = -1) {
  const ran: number[] = [];
  const scene = {
    panel: { width: 2, height: 1 },
    tick: -1,
    frame: new Uint8Array([1, 2, 3, 4, 5, 6]),
    placements: [],
    step(to?: number) {
      const t = to ?? scene.tick + 1;
      if (t === failAt) throw new Error("boom");
      scene.tick = t;
      ran.push(t);
    },
  };
  return { scene: scene as unknown as Scene & { tick: number }, ran };
}

function harness(frameMs: number) {
  let now = 0;
  let pending: (() => void) | undefined;
  let requests = 0;
  const presented: number[] = [];
  const context: FrameContext = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => presented.push(now),
  };
  return {
    context,
    presented,
    clock: () => now,
    requestFrame: (cb: () => void) => {
      requests++;
      pending = cb;
    },
    get requests() {
      return requests;
    },
    advance(ms = frameMs) {
      now += ms;
      const cb = pending;
      pending = undefined;
      cb?.();
    },
  };
}

describe("runLive (AC-10)", () => {
  it("runs one tick per frame at 60 Hz, two at 30 Hz, one per two frames at 120 Hz", () => {
    for (const [hz, perFrame] of [
      [60, 1],
      [30, 2],
      [120, 0.5],
    ] as const) {
      const h = harness(1000 / hz);
      const { scene, ran } = fakeScene();
      runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
      h.advance(0); // the first frame: tick 0
      expect(ran).toEqual([0]);
      for (let i = 0; i < 120; i++) h.advance();
      expect(ran.length, `${hz} Hz`).toBe(1 + 120 * perFrame);
      expect(ran).toEqual(ran.map((_, i) => i));
    }
  });
  it("presents once per frame that ran ticks", () => {
    const h = harness(1000 / 30);
    const { scene } = fakeScene();
    runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
    h.advance(0);
    h.advance();
    expect(h.presented).toHaveLength(2);
  });
  it("skips past 30 due ticks to the newest due tick", () => {
    const h = harness(1000 / 60);
    const { scene, ran } = fakeScene();
    runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
    h.advance(0);
    h.advance(1000); // 60 ticks due
    expect(ran).toEqual([0, 60]);
    h.advance();
    expect(ran).toEqual([0, 60, 61]);
  });
  it("does not skip at exactly 30 due", () => {
    const h = harness(1000 / 60);
    const { scene, ran } = fakeScene();
    runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
    h.advance(0);
    h.advance(30 * (1000 / 60));
    expect(ran.length).toBe(31);
  });
  it("pause steps nothing and resume does not catch up", () => {
    const h = harness(1000 / 60);
    const { scene, ran } = fakeScene();
    const live = runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
    h.advance(0);
    h.advance();
    live.pause();
    h.advance(5000);
    h.advance();
    expect(ran).toEqual([0, 1]);
    live.resume();
    h.advance(0);
    expect(ran).toEqual([0, 1, 2]);
    h.advance();
    expect(ran).toEqual([0, 1, 2, 3]);
  });
  it("stop requests no further frame", () => {
    const h = harness(1000 / 60);
    const { scene, ran } = fakeScene();
    const live = runLive(scene, { context: h.context, clock: h.clock, requestFrame: h.requestFrame });
    h.advance(0);
    const before = h.requests;
    live.stop();
    h.advance();
    h.advance();
    expect(h.requests).toBe(before);
    expect(ran).toEqual([0]);
  });
  it("an error from a step stops it and is reported", () => {
    const h = harness(1000 / 60);
    const { scene, ran } = fakeScene(2);
    const errors: unknown[] = [];
    runLive(scene, {
      context: h.context,
      clock: h.clock,
      requestFrame: h.requestFrame,
      onError: (e) => errors.push(e),
    });
    h.advance(0);
    h.advance();
    const before = h.requests;
    h.advance();
    h.advance();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(h.requests).toBe(before);
    expect(ran).toEqual([0, 1]);
  });
  it("the live environment reads the offset east of UTC and 32 random bits", () => {
    const e = liveEnvironment();
    const t = e.time(0);
    expect(t.offsetS + 0).toBe(-new Date().getTimezoneOffset() * 60 + 0);
    expect(typeof e.random(0)()).toBe("number");
  });
});

describe("presentFrame (AC-9)", () => {
  it("writes red, green, blue and alpha 255 for each LED", () => {
    let written: Uint8ClampedArray | undefined;
    const context: FrameContext = {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (image) => {
        written = (image as { data: Uint8ClampedArray }).data;
      },
    };
    presentFrame(context, new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1);
    expect([...(written ?? [])]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  });
});
