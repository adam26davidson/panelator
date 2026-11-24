import { describe, expect, it } from "vitest";
import { readScene } from "./conformance.ts";
import { SimulatorError } from "./errors.ts";
import { loadScene } from "./files.ts";
import type { Environment } from "./scene.ts";
import { fixedEnv, sceneOf, WHITE } from "./scenehelp.ts";
import { call, callv, emit, i32c, NAMES } from "./testwasm.ts";

// pn_update(tick) sets pixel (tick, 0) white: the pixels of row 0 are the ticks that were called.
const DRAW_PIXEL = NAMES.indexOf("draw_pixel");
const markers = (hz: number) => ({ hz, update: [0x20, 0, 0xa7, ...i32c(0), ...i32c(WHITE), 0x10, DRAW_PIXEL] });

const calledTicks = async (hz: number, upTo: number, via?: number[]): Promise<number[]> => {
  const s = await sceneOf({ width: 120, height: 1 }, [{ width: 120, height: 1, spec: markers(hz) }]);
  for (const t of via ?? Array.from({ length: upTo }, (_, i) => i)) s.step(t);
  return Array.from({ length: 120 }, (_, x) => x).filter((x) => s.frame[x * 3] === 255);
};
const due = (hz: number) =>
  Array.from({ length: 120 }, (_, t) => t).filter(
    (t) => t === 0 || (hz > 0 && Math.trunc((t * hz) / 60) !== Math.trunc(((t - 1) * hz) / 60)),
  );

describe("the due rule (AC-7, AC-13)", () => {
  for (const [hz, count] of [
    [1, 2],
    [7, 14],
    [30, 60],
    [60, 120],
    [0, 1],
  ] as const) {
    it(`a module at ${hz} Hz is called ${count} times over ticks 0 to 119, at the ticks the rule gives`, async () => {
      const got = await calledTicks(hz, 120);
      expect(got).toHaveLength(count);
      expect(got).toEqual(due(hz));
    });
  }
  it("step(tick) runs that tick, not those between, and the rule applies at that tick as written", async () => {
    // 1 Hz: due at 0 and 60; stepping straight to 60 calls it once, at 60; 61 is not due
    const s = await sceneOf({ width: 120, height: 1 }, [{ width: 120, height: 1, spec: markers(1) }]);
    s.step(0);
    s.step(60);
    expect(s.tick).toBe(60);
    s.step(61);
    s.step(90);
    s.step(119);
    expect(Array.from({ length: 120 }, (_, x) => x).filter((x) => s.frame[x * 3] === 255)).toEqual([0, 60]);
    // a skip over a due tick does not call it
    const t = await calledTicks(1, 0, [0, 61, 62]);
    expect(t).toEqual([0]);
    // a tick lower than the next, or not an integer, is refused and changes nothing
    expect(() => s.step(119)).toThrow(SimulatorError);
    expect(() => s.step(1.5)).toThrow(SimulatorError);
    expect(s.tick).toBe(119);
  });
  it("reads the environment's time once per step, 0 for pn_init", async () => {
    const seen: number[] = [];
    const env: Environment = { time: (t) => (seen.push(t), { unixMs: 0n, offsetS: 0 }), random: fixedEnv().random };
    const s = await sceneOf(
      { width: 4, height: 1 },
      [{ width: 4, height: 1, spec: { init: emit(0, callv("time_utc_offset_s")) } }],
      { environment: env },
    );
    s.step();
    s.step(5);
    expect(seen).toEqual([0, 0, 5]);
  });
});

describe("a scene (AC-7)", () => {
  it("gives each placement a layer of the placement's size, not the declared size, and calls pn_init in the given order", async () => {
    const s = await sceneOf({ width: 8, height: 2 }, [
      {
        width: 3,
        height: 2,
        spec: { width: 50, height: 60, init: [...emit(0, callv("layer_width")), ...emit(1, callv("layer_height"))] },
      },
    ]);
    expect([s.frame[2], s.frame[5]]).toEqual([3, 2]);
    expect(s.placements[0]).toMatchObject({ abi: 1, width: 3, height: 2, declaredWidth: 50, declaredHeight: 60, updateHz: 60 });
    expect(s.tick).toBe(-1);
    // pn_init order: the second placement overwrites the pixel the first one drew, in a shared layer? No: layers are separate,
    // so order shows only through the random sequence
    let n = 0;
    const order: number[] = [];
    const env: Environment = { time: fixedEnv().time, random: (i) => () => (order.push(i), n++) };
    await sceneOf(
      { width: 2, height: 1 },
      [
        { width: 2, height: 1, spec: { init: call("random_u32") } },
        { width: 2, height: 1, spec: { init: call("random_u32") }, z: -5 },
      ],
      { environment: env },
    );
    expect(order).toEqual([0, 1]);
  });

  it("runs updates in ascending z, ties in the given order, with the tick as an i64", async () => {
    const order: number[] = [];
    const env: Environment = { time: fixedEnv().time, random: (i) => () => (order.push(i), 0) };
    const upd = { update: call("random_u32") };
    const s = await sceneOf(
      { width: 2, height: 1 },
      [
        { width: 1, height: 1, z: 5, spec: upd },
        { width: 1, height: 1, z: 1, spec: upd },
        { width: 1, height: 1, z: 1, spec: upd },
        { width: 1, height: 1, z: -2, spec: upd },
      ],
      { environment: env },
    );
    s.step();
    expect(order).toEqual([3, 1, 2, 0]);
    // the tick is an i64: a tick above 2^32 arrives whole (its low word is visible, wrapped)
    const big = 2 ** 32 + 7;
    const lowAndHigh = [
      0x20,
      0,
      0xa7,
      ...i32c(0),
      ...i32c(WHITE),
      0x10,
      DRAW_PIXEL, // pixel (low word of the tick, 0)
      0x20,
      0,
      0x42,
      32,
      0x88,
      0xa7,
      ...i32c(0),
      ...i32c(WHITE),
      0x10,
      DRAW_PIXEL, // pixel (high word, 0)
    ];
    const s2 = await sceneOf({ width: 8, height: 1 }, [{ width: 8, height: 1, spec: { hz: 60, update: lowAndHigh } }]);
    s2.step(big);
    expect([...s2.frame].filter((_, i) => i % 3 === 0).map((v) => v / 255)).toEqual([0, 1, 0, 0, 0, 0, 0, 1]);
    expect(s2.tick).toBe(big);
  });

  it("a trap ends the run naming the placement's index and module, the export and the tick; the scene steps no further", async () => {
    const s = await sceneOf({ width: 4, height: 1 }, [
      { width: 4, height: 1, name: "fine", spec: {} },
      { width: 4, height: 1, name: "bad", spec: { update: [0x20, 0, 0xa7, ...i32c(2), 0x46, 0x04, 0x40, 0x00, 0x0b] } },
    ]);
    s.step();
    s.step();
    const err = (() => {
      try {
        s.step();
      } catch (e) {
        return e;
      }
    })() as SimulatorError;
    expect(err).toBeInstanceOf(SimulatorError);
    expect(err).toMatchObject({ placement: 1, module: "bad", export: "pn_update", tick: 2 });
    expect(err.message).toContain("placement 1");
    expect(err.message).toContain("bad");
    expect(() => s.step()).toThrow(err);
    expect(s.tick).toBe(2);
  });

  it("a trap in pn_init fails createScene", async () => {
    const err = await sceneOf({ width: 1, height: 1 }, [
      { width: 1, height: 1, name: "boom", spec: { init: [0x00] } },
    ]).catch((e: unknown) => e);
    expect(err).toMatchObject({ placement: 0, module: "boom", export: "pn_init", tick: 0 });
  });

  it("refuses a panel or a layer that is not a positive integer", async () => {
    await expect(sceneOf({ width: 0, height: 1 }, [])).rejects.toBeInstanceOf(SimulatorError);
    await expect(sceneOf({ width: 1, height: 1.5 }, [])).rejects.toBeInstanceOf(SimulatorError);
    await expect(sceneOf({ width: 1, height: 1 }, [{ width: 0, height: 1, spec: {} }])).rejects.toBeInstanceOf(
      SimulatorError,
    );
  });
});

describe("composition (AC-7)", () => {
  const fill = (rgba: number) => ({ init: call("draw_fill", rgba) });
  const px = (s: { frame: Uint8Array }) => [...s.frame.subarray(0, 3)];
  const SRC = 0xc8643200 | 0; // (200, 100, 50), alpha in the low byte

  it("one layer over black at alpha and opacity 0, 1, 127, 128, 254 and 255, against values computed by hand", async () => {
    // a = (alpha * opacity + 127) / 255; channel = (s * a + 127) / 255, both integer divisions
    const byA: Record<number, number[]> = {
      0: [0, 0, 0],
      1: [1, 0, 0],
      127: [100, 50, 25],
      128: [100, 50, 25],
      254: [199, 100, 50],
      255: [200, 100, 50],
    };
    for (const [alpha, want] of Object.entries(byA)) {
      const s = await sceneOf({ width: 1, height: 1 }, [{ width: 1, height: 1, spec: fill(SRC | Number(alpha)) }]);
      expect(px(s), `alpha ${alpha}`).toEqual(want);
      const o = await sceneOf({ width: 1, height: 1 }, [
        { width: 1, height: 1, opacity: Number(alpha), spec: fill(SRC | 255) },
      ]);
      expect(px(o), `opacity ${alpha}`).toEqual(want);
    }
    // alpha 128 at opacity 128: a = (16384 + 127) / 255 = 64; (200 * 64 + 127) / 255 = 50
    const both = await sceneOf({ width: 1, height: 1 }, [{ width: 1, height: 1, opacity: 128, spec: fill(SRC | 128) }]);
    expect(px(both)).toEqual([50, 25, 13]);
  });

  it("two overlapping layers: the upper at alpha 128 over an opaque lower", async () => {
    const s = await sceneOf({ width: 1, height: 1 }, [
      { width: 1, height: 1, z: 0, spec: fill(0x0a141eff) },
      { width: 1, height: 1, z: 1, spec: fill(SRC | 128) },
    ]);
    // a = 128; (200 * 128 + 10 * 127 + 127) / 255 = 105; (12800 + 2540 + 127) / 255 = 60; (6400 + 3810 + 127) / 255 = 40
    expect(px(s)).toEqual([105, 60, 40]);
  });

  it("applies layers in ascending z, ties in the scene order", async () => {
    const red = fill(0xff0000ff | 0);
    const blue = fill(0x0000ffff | 0);
    const a = await sceneOf({ width: 1, height: 1 }, [
      { width: 1, height: 1, z: 1, spec: red },
      { width: 1, height: 1, z: 0, spec: blue },
    ]);
    expect(px(a)).toEqual([255, 0, 0]);
    const b = await sceneOf({ width: 1, height: 1 }, [
      { width: 1, height: 1, z: 1, spec: red },
      { width: 1, height: 1, z: 1, spec: blue },
    ]);
    expect(px(b)).toEqual([0, 0, 255]);
  });

  it("clips a layer partly and wholly off the panel", async () => {
    const white = fill(WHITE);
    const part = await sceneOf({ width: 4, height: 2 }, [{ width: 3, height: 3, x: 2, y: -1, spec: white }]);
    expect(Array.from(part.frame).map((v) => v / 255)).toEqual(
      [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        .slice(0, 0)
        .concat([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]),
    );
    const left = await sceneOf({ width: 4, height: 1 }, [{ width: 3, height: 1, x: -2, spec: white }]);
    expect([...left.frame]).toEqual([255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (const [x, y] of [
      [4, 0],
      [-3, 0],
      [0, 1],
      [0, -1],
      [2 ** 31 - 1, 0],
      [-(2 ** 31), 0],
    ] as const) {
      const off = await sceneOf({ width: 4, height: 1 }, [{ width: 3, height: 1, x, y, spec: white }]);
      expect(
        [...off.frame].every((v) => v === 0),
        `${x},${y}`,
      ).toBe(true);
    }
  });

  it("has the panel's size for panels of 1 by 1, 96 by 16, 128 by 64 and 200 by 3, the layers clipped to it", async () => {
    for (const [w, h] of [
      [1, 1],
      [96, 16],
      [128, 64],
      [200, 3],
    ] as const) {
      const s = await sceneOf({ width: w, height: h }, [{ width: 300, height: 70, spec: fill(0x0a0b0cff) }]);
      expect(s.frame.length).toBe(w * h * 3);
      expect(s.panel).toEqual({ width: w, height: h });
      expect(s.frame.every((v, i) => v === [10, 11, 12][i % 3])).toBe(true);
    }
  });

  it("keeps a layer's content between ticks (retained layers)", async () => {
    const s = await sceneOf({ width: 3, height: 1 }, [
      { width: 3, height: 1, spec: { hz: 0, init: call("draw_pixel", 1, 0, WHITE) } },
    ]);
    s.step();
    s.step();
    expect([...s.frame]).toEqual([0, 0, 0, 255, 255, 255, 0, 0, 0]);
  });
});

describe("readScene (AC-8)", () => {
  const good = () =>
    JSON.parse(
      JSON.stringify(
        JSON.parse(
          JSON.stringify(
            Object.assign(
              {},
              {
                abi: "0.1",
                panel: { width: 4, height: 2 },
                start_unix_ms: 1,
                utc_offset_s: 0,
                ticks: [0, 2],
                assets: [],
                placements: [{ module: "m", x: 0, y: 0, width: 1, height: 1, z: 0, opacity: 255, config: {}, seed: 1 }],
              },
            ),
          ),
        ),
      ),
    );
  it("reads a scene file of the suite", () => {
    expect(loadScene("spike").placements).toHaveLength(3);
    expect(readScene(JSON.stringify(good())).panel).toEqual({ width: 4, height: 2 });
  });
  it("rejects an unknown field, naming it", () => {
    const s = good();
    s.extra = 1;
    expect(() => readScene(s)).toThrow(/unknown field extra/);
    const p = good();
    p.placements[0].colour = 1;
    expect(() => readScene(p)).toThrow(/unknown field placements\[0\]\.colour/);
  });
  it("rejects a missing field, naming it", () => {
    const s = good();
    delete s.placements[0].seed;
    expect(() => readScene(s)).toThrow(/missing field placements\[0\]\.seed/);
    const t = good();
    delete t.start_unix_ms;
    expect(() => readScene(t)).toThrow(/missing field start_unix_ms/);
  });
  it("rejects a zero seed and descending ticks", () => {
    const s = good();
    s.placements[0].seed = 0;
    expect(() => readScene(s)).toThrow(/seed/);
    const t = good();
    t.ticks = [2, 1];
    expect(() => readScene(t)).toThrow(/ascending/);
  });
});
