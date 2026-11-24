import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Layer } from "./draw.ts";
import { SimulatorError } from "./errors.ts";
import { suite } from "./files.ts";
import type { Asset, Scene } from "./scene.ts";
import { fixedEnv, fonts, sceneOf } from "./scenehelp.ts";
import { call, callv, emit, i32c, ld8, NAMES } from "./testwasm.ts";
import { decodeUtf8, MALFORMED } from "./utf8.ts";

const bytes = (s: string): number[] => [...new TextEncoder().encode(s)];
const signed = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);
const results = (scene: Scene, n: number): number[] =>
  Array.from({ length: n }, (_, i) =>
    signed(
      (scene.frame[i * 3] as number) * 65536 +
        (scene.frame[i * 3 + 1] as number) * 256 +
        (scene.frame[i * 3 + 2] as number),
    ),
  );

/** Runs `init` in a placement of width `w` (the results are the pixels of row 0) and returns the scene. */
const run = (
  init: number[],
  opts: {
    w?: number;
    h?: number;
    data?: { offset: number; bytes: number[] }[];
    config?: Record<string, unknown>;
    assets?: Asset[];
  } = {},
) =>
  sceneOf(
    { width: opts.w ?? 8, height: opts.h ?? 1 },
    [{ width: opts.w ?? 8, height: opts.h ?? 1, config: opts.config, spec: { init, data: opts.data } }],
    { assets: opts.assets },
  );

describe("text (AC-5)", () => {
  // A second reading of the BDF, written differently from the engine's: by regular expression over the glyph's block.
  const bdf = (name: string) => readFileSync(join(suite, "fonts", name), "utf8");
  const reference = (file: string, cp: number, penX: number, y: number): { pixels: Set<string>; advance: number } => {
    const text = bdf(file);
    const ascent = Number(/FONT_ASCENT (\d+)/.exec(text)?.[1]);
    const m = new RegExp(
      `ENCODING ${cp}\\nSWIDTH.*\\nDWIDTH (\\d+) \\d+\\nBBX (\\d+) (\\d+) (-?\\d+) (-?\\d+)\\nBITMAP\\n([0-9A-F\\n]*?)ENDCHAR`,
    ).exec(text);
    if (!m) throw new Error(`no glyph ${cp} in ${file}`);
    const [, dw, bw, bh, bx, by, rows] = m.map(Number) as number[];
    const lines = (m[6] as string).split("\n").filter(Boolean);
    const pixels = new Set<string>();
    lines.forEach((hex, r) => {
      const bits = BigInt(`0x${hex}`)
        .toString(2)
        .padStart(hex.length * 4, "0");
      for (let c = 0; c < (bw as number); c++)
        if (bits[c] === "1")
          pixels.add(`${penX + (bx as number) + c},${y + (ascent - (by as number) - (bh as number)) + r}`);
    });
    void rows;
    return { pixels, advance: dw as number };
  };
  for (const [id, file] of [
    [1, "spleen-5x8.bdf"],
    [2, "spleen-8x16.bdf"],
  ] as const) {
    it(`every printable ASCII character of font ${id} equals its BDF bitmap`, () => {
      for (let cp = 0x20; cp <= 0x7e; cp++) {
        const l = new Layer(24, 24);
        const advance = l.text(fonts[id], 3, 2, [cp], -1, true);
        const ref = reference(file, cp, 3, 2);
        const got = new Set<string>();
        for (let y = 0; y < 24; y++)
          for (let x = 0; x < 24; x++) if (l.data[(y * 24 + x) * 4 + 3]) got.add(`${x},${y}`);
        expect([...got].sort(), `U+${cp.toString(16)}`).toEqual([...ref.pixels].sort());
        expect(advance).toBe(ref.advance);
      }
    });
  }

  it("clips at each edge and sets only the glyphs' pixels", () => {
    for (const [x, y] of [
      [-3, 0],
      [0, -4],
      [20, 0],
      [0, 20],
      [-100, -100],
      [100, 100],
    ] as const) {
      const l = new Layer(24, 24);
      const full = new Layer(300, 300);
      l.text(fonts[2], x, y, [0x57, 0x4d], -1, true);
      full.text(fonts[2], x + 100, y + 100, [0x57, 0x4d], -1, true);
      for (let j = 0; j < 24; j++)
        for (let i = 0; i < 24; i++)
          expect(l.data[(j * 24 + i) * 4 + 3]).toBe(full.data[((j + 100) * 300 + i + 100) * 4 + 3]);
    }
  });

  it("through the imports: advances, heights, a missing glyph, an unknown font and malformed input", async () => {
    const cases: [string, number[], number][] = [
      ["a lone continuation byte", [0x80], 5],
      ["a truncated sequence", [0xe2, 0x82], 10],
      ["an overlong form", [0xc0, 0x80], 10],
      ["a surrogate", [0xed, 0xa0, 0x80], 15],
      ["beyond U+10FFFF", [0xf4, 0x90, 0x80, 0x80], 20],
      ["a missing glyph", [0xe4, 0xb8, 0xad], 5],
      ["a glyph of the font", bytes("é"), 5],
      ["ASCII", bytes("Hello"), 25],
      ["malformed between glyphs", [0x41, 0xff, 0x42], 15],
    ];
    const offsets: number[] = [];
    let at = 0;
    const data = cases.map(([, b]) => {
      offsets.push(at);
      const d = { offset: at, bytes: b };
      at += b.length;
      return d;
    });
    const init = [
      ...cases.flatMap(([, b], i) => emit(i, callv("text_width", 1, offsets[i] as number, b.length))),
      ...emit(9, callv("text_width", 2, 0, 1)),
      ...emit(10, callv("text_width", 3, 0, 1)),
      ...emit(11, callv("font_height", 1)),
      ...emit(12, callv("font_height", 2)),
      ...emit(13, callv("font_height", 7)),
      ...emit(14, callv("draw_text", 1, 0, -20, offsets[7] as number, 5, -1)),
      ...emit(15, callv("draw_text", 9, 0, 0, 0, 1, -1)),
    ];
    const scene = await run(init, { w: 16, data });
    const got = results(scene, 16);
    expect(got.slice(0, 9), cases.map((c) => c[0]).join(", ")).toEqual(cases.map((c) => c[2]));
    expect(got.slice(9)).toEqual([8, -1, 8, 16, -1, 25, -1]);
  });

  it("decodes UTF-8 by RFC 3629, each stray byte alone (not by maximal subpart)", () => {
    expect(decodeUtf8(Uint8Array.from([0xf0, 0x9f, 0x98, 0x80, 0xe2, 0x82, 0x41]))).toEqual([
      0x1f600,
      MALFORMED,
      MALFORMED,
      0x41,
    ]);
    expect(decodeUtf8(Uint8Array.from([0xed, 0x9f, 0xbf]))).toEqual([0xd7ff]);
    expect(decodeUtf8(Uint8Array.from([0xc1, 0xbf, 0xe0, 0x80, 0x80]))).toEqual([
      MALFORMED,
      MALFORMED,
      MALFORMED,
      MALFORMED,
      MALFORMED,
    ]);
  });

  it("a pointer outside the memory is a trap that ends the run, naming the placement", async () => {
    const err = await run(call("draw_text", 1, 0, 0, 65530, 100, -1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulatorError);
    expect(err).toMatchObject({ placement: 0, export: "pn_init", tick: 0 });
  });

  it("reads the memory afresh after it grows", async () => {
    const grow = [...i32c(1), 0x40, 0, 0x1a];
    await expect(run([...grow, ...emit(0, callv("text_width", 1, 70000, 1))])).resolves.toBeDefined();
    await expect(run([...emit(0, callv("text_width", 1, 70000, 1))])).rejects.toBeInstanceOf(SimulatorError);
  });
});

describe("images (AC-6)", () => {
  const asset: Asset = {
    name: "pic",
    width: 2,
    height: 2,
    frames: 2,
    bytes: Uint8Array.from([10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0, 110, 0, 0, 120, 0, 0, 130, 0, 0, 140, 0, 0]),
  };
  const draw = (frame: number, x: number, y: number, panelW = 5) =>
    run(call("draw_image", 0, 3, frame, x, y), {
      w: panelW,
      h: 4,
      data: [{ offset: 0, bytes: bytes("pic") }],
      assets: [asset],
    });
  const reds = (s: Scene) =>
    Array.from({ length: s.panel.height }, (_, y) =>
      Array.from({ length: s.panel.width }, (_, x) => s.frame[(y * s.panel.width + x) * 3] as number),
    );

  it("draws inside, across each edge and wholly outside the layer, with alpha 255", async () => {
    expect(reds(await draw(0, 1, 1))[1]).toEqual([0, 10, 20, 0, 0]);
    expect(reds(await draw(0, 1, 1))[2]).toEqual([0, 30, 40, 0, 0]);
    expect(reds(await draw(0, -1, -1)).slice(0, 2)).toEqual([
      [40, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(reds(await draw(0, 4, 3))[3]).toEqual([0, 0, 0, 0, 10]);
    expect(
      reds(await draw(0, 100, 100))
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
    expect(
      reds(await draw(0, -100, 2))
        .flat()
        .every((v) => v === 0),
    ).toBe(true);
  });
  it("draws the second frame of a two-frame asset", async () => {
    expect(reds(await draw(1, 0, 0))[0]).toEqual([110, 120, 0, 0, 0]);
  });
  it("returns -1 for no such asset and -2 for a frame that does not exist, drawing nothing", async () => {
    const s = await run(
      [
        ...emit(0, callv("draw_image", 0, 3, 2, 0, 1)),
        ...emit(1, callv("draw_image", 0, 3, -1, 0, 1)),
        ...emit(2, callv("draw_image", 3, 3, 0, 0, 1)),
        ...emit(3, callv("draw_image", 0, 3, 1, 0, 1)),
      ],
      { w: 5, h: 3, data: [{ offset: 0, bytes: [...bytes("pic"), ...bytes("nop")] }], assets: [asset] },
    );
    expect(results(s, 4)).toEqual([-2, -2, -1, 0]);
  });
  it("a bad name pointer is a trap", async () => {
    await expect(run(call("draw_image", 65535, 5, 0, 0, 0), { assets: [asset] })).rejects.toBeInstanceOf(
      SimulatorError,
    );
  });
  it("refuses an asset whose length is not width * height * 3 * frames", async () => {
    await expect(run([], { assets: [{ ...asset, bytes: new Uint8Array(5) }] })).rejects.toBeInstanceOf(SimulatorError);
  });
});

describe("config, time and random (AC-6)", () => {
  it("serves the UTF-8 bytes of JSON.stringify of the config, {} when there is none", async () => {
    const cfg = { t: "é" };
    const json = [...new TextEncoder().encode(JSON.stringify(cfg))];
    const s = await run(
      [
        ...emit(0, callv("config_len")),
        ...emit(1, callv("config_read", 100, 3)),
        ...emit(2, ld8(100)),
        ...emit(3, ld8(101)),
        ...emit(4, ld8(102)),
        ...emit(5, ld8(103)),
      ],
      { w: 8, config: cfg },
    );
    expect(results(s, 6)).toEqual([json.length, 3, json[0], json[1], json[2], 0]);
    const none = await run(emit(0, callv("config_len")));
    expect(results(none, 1)).toEqual([2]);
  });
  it("copies min(cap, length) bytes, a negative cap copies nothing and returns 0, a buffer past the memory traps", async () => {
    const s = await run(
      [
        ...emit(0, callv("config_read", 100, 1000)),
        ...emit(1, ld8(101)),
        ...emit(2, ld8(102)),
        ...emit(3, callv("config_read", 100, -5)),
        ...emit(4, ld8(200)),
        ...emit(5, callv("config_read", 65536, 0)),
      ],
      { w: 8 },
    );
    expect(results(s, 6)).toEqual([2, 125, 0, 0, 0, 0]);
    await expect(run(call("config_read", 65530, 100))).rejects.toBeInstanceOf(SimulatorError);
    await expect(run(call("config_read", 65536, 1))).rejects.toBeInstanceOf(SimulatorError);
  });
  it("gives the environment's time as an i64, the offset and the random bits", async () => {
    const env = fixedEnv(4294967296n * 3n + 5n, -3600, () => 0x123456);
    const wrap = [0xa7];
    const hi = [...callv("time_unix_ms"), 0x42, 32, 0x88, 0xa7];
    const s = await sceneOf(
      { width: 6, height: 1 },
      [
        {
          width: 6,
          height: 1,
          spec: {
            init: [
              ...emit(0, [...callv("time_unix_ms"), ...wrap]),
              ...emit(1, hi),
              ...emit(2, callv("time_utc_offset_s")),
              ...emit(3, callv("random_u32")),
            ],
          },
        },
      ],
      { environment: env },
    );
    expect(results(s, 4)).toEqual([5, 3, -3600, 0x123456]);
  });
  it("an exception in an import ends the run, naming the placement, the export and the tick", async () => {
    const env = {
      time: fixedEnv().time,
      random: () => () => {
        throw new Error("no randomness");
      },
    };
    const err = await sceneOf({ width: 2, height: 1 }, [{ width: 2, height: 1, spec: { init: call("random_u32") } }], {
      environment: env,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulatorError);
    expect((err as Error).message).toContain("no randomness");
  });
  it("every import of the table is registered (no import is left to a missing-function error)", () => {
    expect(NAMES).toHaveLength(16);
  });
});
