import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assemble, declarations, imp, op, type Spec } from "./assemble.ts";
import { SimulatorError } from "./errors.ts";
import { decodeUtf8, parseFont } from "./font.ts";
import { loadModule } from "./module.ts";
import { type Asset, createScene, type Environment, type PlacementSpec } from "./scene.ts";

const conf = join(import.meta.dirname, "..", "..", "..", "sdk", "conformance");
const bdf5 = readFileSync(join(conf, "fonts", "spleen-5x8.bdf"), "utf8");
const bdf8 = readFileSync(join(conf, "fonts", "spleen-8x16.bdf"), "utf8");
const fonts = [parseFont(bdf5), parseFont(bdf8)] as [ReturnType<typeof parseFont>, ReturnType<typeof parseFont>];

const NAMES = [
  ["layer_width", 0, "i32"],
  ["layer_height", 0, "i32"],
  ["draw_fill", 1],
  ["draw_pixel", 3],
  ["draw_line", 5],
  ["draw_rect", 6],
  ["draw_circle", 5],
  ["draw_text", 6, "i32"],
  ["text_width", 3, "i32"],
  ["font_height", 1, "i32"],
  ["draw_image", 5, "i32"],
  ["config_len", 0, "i32"],
  ["config_read", 2, "i32"],
  ["time_unix_ms", 0, "i64"],
  ["time_utc_offset_s", 0, "i32"],
  ["random_u32", 0, "i32"],
] as const;
const idx = (n: string): number => NAMES.findIndex((x) => x[0] === n);
const imports = NAMES.map(([n, p, r]) => imp(n, p, r));
const c = op.i32const;
const call = (n: string, ...args: number[]): number[] => [...args.flatMap((a) => c(a)), ...op.call(idx(n))];
const WHITE = 0xffffffff | 0;
/** After a call that left an i32 on the stack: draw a pixel at x = result + 3 in row 0 (so -2 is x 1). */
const mark = (): number[] => [...c(3), 0x6a, ...c(0), ...c(WHITE), ...op.call(idx("draw_pixel"))];
const drop = op.drop;

const mod = (
  init: number[],
  opts: Partial<Spec> & { hz?: number; w?: number; h?: number; update?: number[] } = {},
): Uint8Array =>
  assemble({
    imports,
    funcs: declarations({ hz: opts.hz, w: opts.w, h: opts.h, init, update: opts.update }),
    memory: opts.memory === undefined ? { min: 1, max: 4 } : opts.memory,
    data: opts.data,
  });

const env: Environment = {
  time: () => ({ unixMs: 1798757998000, offsetS: 3600 }),
  random: () => () => 7,
};

interface P {
  bytes: Uint8Array;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  z?: number;
  opacity?: number;
  config?: Record<string, unknown>;
  name?: string;
}
async function scene(ps: P[], panel = { width: 64, height: 16 }, assets: Asset[] = [], environment = env) {
  const placements: PlacementSpec[] = [];
  for (const p of ps) {
    placements.push({
      module: await loadModule(p.bytes, p.name ?? "m"),
      x: p.x ?? 0,
      y: p.y ?? 0,
      width: p.w ?? panel.width,
      height: p.h ?? panel.height,
      z: p.z ?? 0,
      opacity: p.opacity ?? 255,
      config: p.config ?? {},
    });
  }
  return createScene({ panel, fonts, assets, placements, environment });
}
const px = (s: { frame: Uint8Array; panel: { width: number } }, x: number, y: number): number[] => {
  const i = (y * s.panel.width + x) * 3;
  return [...s.frame.slice(i, i + 3)];
};
const lit = (s: { frame: Uint8Array; panel: { width: number; height: number } }, row: number): number[] =>
  Array.from({ length: s.panel.width }, (_, x) => x).filter((x) => px(s, x, row)[0] !== 0);

/** Reference glyph set for a character of a BDF, read independently of parseFont. */
function refGlyph(bdf: string, cp: number): { pixels: [number, number][]; dwidth: number } | undefined {
  const m = new RegExp(`ENCODING ${cp}\\n([\\s\\S]*?)ENDCHAR`).exec(bdf);
  if (!m) return undefined;
  const body = m[1] as string;
  const [w, h, ox, oy] = (/BBX (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(body) as RegExpExecArray).slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const dwidth = Number((/DWIDTH (\d+)/.exec(body) as RegExpExecArray)[1]);
  const ascent = Number((/FONT_ASCENT (\d+)/.exec(bdf) as RegExpExecArray)[1]);
  const rows = (/BITMAP\n([\s\S]*)/.exec(body) as RegExpExecArray)[1]?.trim().split("\n") ?? [];
  const pixels: [number, number][] = [];
  rows.forEach((hex, row) => {
    const bits = Number.parseInt(hex, 16)
      .toString(2)
      .padStart(hex.length * 4, "0");
    for (let col = 0; col < w; col++) if (bits[col] === "1") pixels.push([ox + col, ascent - oy - h + row]);
  });
  return { pixels, dwidth };
}

const drawText = (font: number, x: number, y: number, bytes: number[]) =>
  mod([...call("draw_text", font, x, y, 16, bytes.length, WHITE), ...mark()], { data: [{ offset: 16, bytes }] });

describe("text (AC-5)", () => {
  it("draws every printable ASCII character of both fonts as the BDF bitmaps say, with its advance", async () => {
    for (const [font, bdf] of [
      [1, bdf5],
      [2, bdf8],
    ] as const) {
      for (let cp = 0x20; cp < 0x7f; cp++) {
        const s = await scene([{ bytes: drawText(font, 4, 3, [cp]) }], { width: 40, height: 24 });
        s.step();
        const ref = refGlyph(bdf, cp) as NonNullable<ReturnType<typeof refGlyph>>;
        const want = new Set(ref.pixels.map(([x, y]) => `${4 + x},${3 + y}`));
        const got = new Set<string>();
        for (let y = 1; y < 24; y++) for (let x = 0; x < 40; x++) if (px(s, x, y)[0]) got.add(`${x},${y}`);
        expect([...got].sort(), `font ${font} U+${cp.toString(16)}`).toEqual([...want].sort());
        expect(px(s, ref.dwidth + 3, 0)[0], `advance of ${cp}`).toBe(255);
      }
    }
  });
  it("clips at each edge", async () => {
    for (const [x, y] of [
      [-3, 2],
      [38, 2],
      [4, -5],
      [4, 20],
    ] as const) {
      const s = await scene([{ bytes: drawText(2, x, y, [0x57]) }], { width: 40, height: 24 });
      s.step();
      const ref = refGlyph(bdf8, 0x57) as NonNullable<ReturnType<typeof refGlyph>>;
      const want = ref.pixels
        .map(([gx, gy]) => [x + gx, y + gy])
        .filter(([gx, gy]) => (gx as number) >= 0 && (gx as number) < 40 && (gy as number) >= 1 && (gy as number) < 24);
      let n = 0;
      for (let yy = 1; yy < 24; yy++) for (let xx = 0; xx < 40; xx++) if (px(s, xx, yy)[0]) n++;
      expect(n).toBe(want.length);
    }
  });
  it("a missing glyph and a malformed byte draw nothing and advance by the box width; an unknown font is -1", async () => {
    const adv = async (font: number, bytes: number[]): Promise<number> => {
      const s = await scene([{ bytes: drawText(font, 0, 4, bytes) }], { width: 80, height: 24 });
      s.step();
      const row = lit(s, 0)[0] as number;
      return row - 3;
    };
    expect(await adv(1, [0xe4, 0xb8, 0xad])).toBe(5); // U+4E2D has no glyph: one box width
    expect(await adv(2, [0xe4, 0xb8, 0xad])).toBe(8);
    expect(await adv(1, [0x80])).toBe(5); // a lone continuation byte
    expect(await adv(1, [0xe2, 0x82])).toBe(10); // truncated: each byte alone
    expect(await adv(1, [0xc0, 0xaf])).toBe(10); // overlong: both bytes alone
    expect(await adv(1, [0xed, 0xa0, 0x80])).toBe(15); // a surrogate: three bytes alone
    expect(await adv(1, [0xf4, 0x90, 0x80, 0x80])).toBe(20); // above U+10FFFF
    expect(await adv(1, [0x41, 0xff, 0x41])).toBe(15);
    expect(await adv(3, [0x41])).toBe(-1);
    const fh = await scene([
      {
        bytes: mod([
          ...call("font_height", 1),
          ...mark(),
          ...call("font_height", 2),
          ...mark(),
          ...call("font_height", 9),
          ...mark(),
        ]),
      },
    ]);
    fh.step();
    expect(lit(fh, 0)).toEqual([2, 11, 19]);
  });
  it("decodes UTF-8 as RFC 3629 does, each byte of a bad sequence alone", () => {
    expect(decodeUtf8(new Uint8Array([0x41, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]))).toEqual([
      0x41, 0xe9, 0x20ac, 0x1f600,
    ]);
    expect(decodeUtf8(new Uint8Array([0xf0, 0x9f, 0x98]))).toEqual([-1, -1, -1]);
    expect(decodeUtf8(new Uint8Array([0xe0, 0x80, 0x80]))).toEqual([-1, -1, -1]);
    expect(decodeUtf8(new Uint8Array([0xc2]))).toEqual([-1]);
  });
  it("text_width is the advance without drawing", async () => {
    const bytes = [0x48, 0x69];
    const s = await scene([
      { bytes: mod([...call("text_width", 2, 16, 2), ...mark()], { data: [{ offset: 16, bytes }] }) },
    ]);
    s.step();
    expect(lit(s, 0)).toEqual([8 * 2 + 3]);
  });
  it("a bad pointer traps the run", async () => {
    await expect(scene([{ bytes: mod(call("draw_text", 1, 0, 0, 65530, 10, WHITE).concat(drop)) }])).rejects.toThrow(
      /memory access|draw_text/,
    );
  });
});

describe("images (AC-6)", () => {
  const name = [...new TextEncoder().encode("pic")];
  const asset: Asset = {
    name: "pic",
    width: 3,
    height: 2,
    frames: 2,
    bytes: Uint8Array.from([
      ...Array.from({ length: 18 }, (_, i) => 10 + i),
      ...Array.from({ length: 18 }, (_, i) => 100 + i),
    ]),
  };
  const draw = (frame: number, x: number, y: number, n = name): Uint8Array =>
    mod([...call("draw_image", 16, n.length, frame, x, y), ...mark()], { data: [{ offset: 16, bytes: n }] });
  it("draws a frame inside, across each edge and wholly outside, with alpha 255", async () => {
    const run = async (frame: number, x: number, y: number) => {
      const s = await scene([{ bytes: draw(frame, x, y) }], { width: 8, height: 6 }, [asset]);
      s.step();
      return s;
    };
    let s = await run(0, 2, 2);
    expect(px(s, 2, 2)).toEqual([10, 11, 12]);
    expect(px(s, 4, 3)).toEqual([25, 26, 27]);
    s = await run(1, 2, 2);
    expect(px(s, 2, 2)).toEqual([100, 101, 102]);
    s = await run(0, -1, -1);
    expect(px(s, 0, 0)).toEqual([22, 23, 24]);
    expect(px(s, 1, 0)).toEqual([25, 26, 27]);
    s = await run(0, 7, 5);
    expect(px(s, 7, 5)).toEqual([10, 11, 12]);
    s = await run(0, 100, 100);
    expect(lit(s, 5)).toEqual([]);
    s = await run(0, -100, -100);
    expect(lit(s, 3)).toEqual([]);
  });
  it("returns -1 for no such asset and -2 for a frame that does not exist, drawing nothing", async () => {
    for (const [bytes, x] of [
      [draw(0, 0, 1, [...new TextEncoder().encode("nope")]), 2],
      [draw(2, 0, 1), 1],
      [draw(-1, 0, 1), 1],
    ] as const) {
      const s = await scene([{ bytes }], { width: 8, height: 6 }, [asset]);
      s.step();
      expect(lit(s, 0)).toEqual([x]);
      expect(lit(s, 1)).toEqual([]);
    }
  });
  it("traps on a bad name pointer and rejects an asset of the wrong length", async () => {
    await expect(
      scene([{ bytes: mod(call("draw_image", 65535, 5, 0, 0, 0).concat(drop)) }], undefined, [asset]),
    ).rejects.toThrow(/draw_image/);
    await expect(scene([], undefined, [{ ...asset, bytes: new Uint8Array(5) }])).rejects.toThrow(/asset pic/);
  });
});

describe("config, time, random (AC-6)", () => {
  it("serves the JSON bytes, honours cap and the whole-buffer rule", async () => {
    const json = '{"text":"hi"}';
    const run = async (body: number[], config: Record<string, unknown> = { text: "hi" }) => {
      const s = await scene([{ bytes: mod(body, { w: 130, h: 2 }), w: 130, h: 2, config }], { width: 130, height: 2 });
      s.step();
      return lit(s, 0);
    };
    expect(await run([...call("config_len"), ...mark()])).toEqual([json.length + 3]);
    expect(await run([...call("config_len"), ...mark()], {})).toEqual([2 + 3]);
    expect(await run([...call("config_read", 200, 100), ...mark()])).toEqual([json.length + 3]);
    expect(await run([...call("config_read", 200, 4), ...mark()])).toEqual([4 + 3]);
    expect(await run([...call("config_read", 200, -5), ...mark()])).toEqual([3]);
    // the bytes arrive: the first byte, `{`, is 123
    expect(
      await run(
        [
          ...call("config_read", 200, 100),
          drop[0] as number,
          ...c(200),
          0x2d,
          0,
          0,
          ...c(0),
          ...c(WHITE),
          ...op.call(idx("draw_pixel")),
        ].slice(0),
      ),
    ).toEqual([123]);
    await expect(run([...call("config_read", 65530, 100), ...drop])).rejects.toThrow(/config_read/);
    expect(await run([...call("config_read", 65530, -1), ...mark()])).toEqual([3]);
  });
  it("gives time as an i64, the offset, and the placement's random source", async () => {
    const body = [
      ...op.call(idx("time_unix_ms")),
      0xa7,
      ...c(0x7fffffff),
      0x71,
      ...c(0),
      ...c(WHITE),
      ...op.call(idx("draw_pixel")), // (time as i32) & 0x7fffffff at x
      ...call("time_utc_offset_s"),
      ...mark(),
      ...call("random_u32"),
      ...mark(),
    ];
    const s = await scene([{ bytes: mod(body, { w: 64, h: 2 }) }], { width: 64, height: 2 }, [], {
      time: () => ({ unixMs: 5, offsetS: 7 }),
      random: () => () => 20,
    });
    s.step();
    expect(lit(s, 0)).toEqual([5, 10, 23]);
  });
});

describe("stepping (AC-7)", () => {
  const pixelAtTick = (hz: number): Uint8Array =>
    mod([], { hz, w: 120, h: 1, update: [0x20, 0, 0xa7, ...c(0), ...c(WHITE), ...op.call(idx("draw_pixel"))] });
  const rule = (hz: number, t: number): boolean =>
    t === 0 || (hz > 0 && Math.floor((t * hz) / 60) !== Math.floor(((t - 1) * hz) / 60));
  it("updates at the ticks the rule gives: 2, 14, 60 and 120 calls at rates 1, 7, 30 and 60, one at rate 0", async () => {
    for (const [hz, count] of [
      [1, 2],
      [7, 14],
      [30, 60],
      [60, 120],
      [0, 1],
    ] as const) {
      const s = await scene([{ bytes: pixelAtTick(hz) }], { width: 120, height: 1 });
      for (let t = 0; t < 120; t++) s.step();
      const got = lit(s, 0);
      expect(got.length, `rate ${hz}`).toBe(count);
      expect(got).toEqual(Array.from({ length: 120 }, (_, t) => t).filter((t) => rule(hz, t)));
    }
  });
  it("step(tick) skips ahead and applies the rule at that tick as written", async () => {
    const s = await scene([{ bytes: pixelAtTick(1) }], { width: 120, height: 1 });
    s.step();
    s.step(60);
    expect(s.tick).toBe(60);
    expect(lit(s, 0)).toEqual([0, 60]);
    expect(() => s.step(60)).toThrow(RangeError);
    s.step();
    expect(s.tick).toBe(61);
    const t = await scene([{ bytes: pixelAtTick(7) }], { width: 120, height: 1 });
    t.step(9); // rate 7: due at 9 since floor(63/60) != floor(56/60); tick 0 was never run
    expect(lit(t, 0)).toEqual([9]);
  });
  it("runs due placements in ascending z, ties in the given order", async () => {
    // z-order observed through the frame: the last drawn is on top
    const fill = (colour: number): Uint8Array => mod(call("draw_fill", colour));
    const s = await scene([
      { bytes: fill(0x00ff00ff | 0), z: 5 },
      { bytes: fill(0xff0000ff | 0), z: 1 },
      { bytes: fill(0x0000ffff | 0), z: 5 },
    ]);
    s.step();
    expect(px(s, 0, 0)).toEqual([0, 0, 255]); // z 5 ties: the later one is on top
  });
  it("gives a frame of the panel's size for panels of 1x1, 96x16, 128x64 and 200x3, layers clipped to it", async () => {
    for (const [w, h] of [
      [1, 1],
      [96, 16],
      [128, 64],
      [200, 3],
    ] as const) {
      const s = await scene([{ bytes: mod(call("draw_fill", WHITE), { w: 8, h: 8 }), w: 8, h: 8, x: -2, y: 1 }], {
        width: w,
        height: h,
      });
      s.step();
      expect(s.frame.length).toBe(w * h * 3);
      let n = 0;
      for (let i = 0; i < s.frame.length; i += 3) if (s.frame[i]) n++;
      expect(n).toBe(Math.max(0, Math.min(8 - 2, w)) * Math.max(0, Math.min(9, h) - 1));
    }
  });
  it("a layer wholly off the panel changes nothing", async () => {
    const s = await scene([{ bytes: mod(call("draw_fill", WHITE), { w: 8, h: 8 }), w: 8, h: 8, x: 100, y: -100 }], {
      width: 10,
      height: 10,
    });
    s.step();
    expect(s.frame.every((b) => b === 0)).toBe(true);
  });
});

describe("composition (AC-7)", () => {
  const colour = (r: number, g: number, b: number, a: number): number => (r << 24) | (g << 16) | (b << 8) | a | 0;
  // a = (alpha * opacity + 127) / 255, then channel 200 over black = (200 * a + 127) / 255; computed by hand:
  // a: 0 -> 0, 1 -> 1, 127 -> 100, 128 -> 100, 254 -> 199, 255 -> 200
  const byHand: Record<number, number> = { 0: 0, 1: 1, 127: 100, 128: 100, 254: 199, 255: 200 };
  it("alpha and opacity 0, 1, 127, 128, 254 and 255 over black", async () => {
    for (const v of [0, 1, 127, 128, 254, 255]) {
      let s = await scene([{ bytes: mod(call("draw_fill", colour(200, 200, 200, v))), opacity: 255 }], {
        width: 2,
        height: 2,
      });
      s.step();
      expect(px(s, 1, 1), `alpha ${v}`).toEqual([byHand[v], byHand[v], byHand[v]]);
      s = await scene([{ bytes: mod(call("draw_fill", colour(200, 200, 200, 255))), opacity: v }], {
        width: 2,
        height: 2,
      });
      s.step();
      expect(px(s, 1, 1), `opacity ${v}`).toEqual([byHand[v], byHand[v], byHand[v]]);
    }
  });
  it("two overlapping layers: green at alpha 128 over opaque red is (127, 128, 0)", async () => {
    const s = await scene(
      [
        { bytes: mod(call("draw_fill", colour(255, 0, 0, 255))), z: 0 },
        { bytes: mod(call("draw_fill", colour(0, 255, 0, 128))), z: 1 },
      ],
      { width: 2, height: 2 },
    );
    s.step();
    expect(px(s, 0, 0)).toEqual([127, 128, 0]);
  });
});

describe("traps (AC-7)", () => {
  it("a trap in pn_update reports index, module, export and tick; a trap in pn_init fails createScene", async () => {
    const ok = mod([]);
    const bad = mod([], { update: op.unreachable });
    const s = await scene([
      { bytes: ok, name: "fine" },
      { bytes: bad, name: "boom" },
    ]);
    let err: unknown;
    try {
      s.step();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SimulatorError);
    const e = err as SimulatorError;
    expect([e.placement, e.module, e.export, e.tick]).toEqual([1, "boom", "pn_update", 0]);
    expect(() => s.step()).toThrow(/steps no further/);
    await expect(scene([{ bytes: mod(op.unreachable), name: "initboom" }])).rejects.toMatchObject({
      export: "pn_init",
      module: "initboom",
      placement: 0,
      tick: 0,
    });
  });
  it("a JavaScript exception in an import ends the run the same way", async () => {
    const angry: Environment = {
      time: env.time,
      random: () => () => {
        throw new Error("rng broke");
      },
    };
    const s = await scene([{ bytes: mod(call("random_u32").concat(drop)), name: "rnd" }], undefined, [], angry).catch(
      (x: unknown) => x,
    );
    expect(s).toBeInstanceOf(SimulatorError);
    expect(s).toMatchObject({ module: "rnd", export: "pn_init", tick: 0 });
  });
});

describe("memory growth (AC-3)", () => {
  it("a declared maximum of 4 pages makes the browser answer -1", async () => {
    const s = await scene([{ bytes: mod([...c(4), ...op.memoryGrow, ...mark()]) }]);
    s.step();
    expect(lit(s, 0)).toEqual([2]);
  });
  it("a module with no declared maximum that grows past 4 pages ends the run, naming the limit", async () => {
    const growing = mod([...c(4), ...op.memoryGrow, ...drop], { memory: { min: 1 } });
    await expect(scene([{ bytes: growing, name: "grower" }])).rejects.toThrow(/memory limit.*limit is 4/);
    const fine = mod([...c(3), ...op.memoryGrow, ...drop], { memory: { min: 1 } });
    await expect(scene([{ bytes: fine }])).resolves.toBeDefined();
  });
});
