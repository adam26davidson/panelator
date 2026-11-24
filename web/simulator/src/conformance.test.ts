import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  type ConformanceScene,
  frameSha256,
  profileEnvironment,
  readScene,
  runConformance,
  xorshift32,
} from "./conformance.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const conf = join(root, "sdk", "conformance");
const widgets = join(root, "target", "widgets");
const MODULES = ["spike-clock", "spike-scroll", "spike-image"];

/** An 8-bit RGB, non-interlaced PNG decoded with node:zlib; all five filter types. */
function decodePng(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error("not 8-bit RGB, non-interlaced");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= 3 ? (out[y * stride + i - 3] as number) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= 3 ? (out[(y - 1) * stride + i - 3] as number) : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const add = [0, a, b, (a + b) >> 1, paeth][filter] as number;
      out[y * stride + i] = (x + add) & 255;
    }
  }
  return { width, height, rgb: out };
}

function files(scene: ConformanceScene) {
  const read = (p: string): Uint8Array => new Uint8Array(readFileSync(p));
  return {
    modules: Object.fromEntries(
      scene.placements.map((p) => {
        const file = join(widgets, `${p.module}.wasm`);
        if (!existsSync(file))
          throw new Error(
            `${file} is missing: run sdk/rust/build-widgets.sh (needs the toolchain of rust-toolchain.toml)`,
          );
        return [p.module, read(file)];
      }),
    ),
    assets: Object.fromEntries(scene.assets.map((a) => [a.file, read(join(conf, "assets", a.file))])),
    fonts: [
      readFileSync(join(conf, "fonts", "spleen-5x8.bdf"), "utf8"),
      readFileSync(join(conf, "fonts", "spleen-8x16.bdf"), "utf8"),
    ] as [string, string],
  };
}

describe("the modules", () => {
  it("are built, and their hashes are printed", () => {
    for (const m of MODULES) {
      const file = join(widgets, `${m}.wasm`);
      expect(existsSync(file), `${file} exists`).toBe(true);
      console.log(`module ${m}.wasm sha256 ${createHash("sha256").update(readFileSync(file)).digest("hex")}`);
    }
  });
});

describe("golden frames (AC-11)", () => {
  for (const name of ["spike-clock", "spike-scroll", "spike-image", "spike"]) {
    it(`scene ${name}: every captured frame equals its golden frame`, async () => {
      const scene = readScene(readFileSync(join(conf, "scenes", `${name}.json`), "utf8"));
      const golden = JSON.parse(readFileSync(join(conf, "golden", name, "frames.json"), "utf8")) as {
        frames: { tick: number; sha256: string }[];
      };
      const frames = await runConformance(scene, files(scene));
      expect(
        frames.map((f) => f.tick),
        `${name}: captured ticks`,
      ).toEqual(scene.ticks);
      expect(
        golden.frames.map((f) => f.tick),
        `${name}: frames.json ticks`,
      ).toEqual(scene.ticks);
      for (const { tick, frame } of frames) {
        const png = decodePng(readFileSync(join(conf, "golden", name, `tick-${tick}.png`)));
        const sha = await frameSha256(frame);
        let first = "";
        for (let i = 0; i < frame.length && !first; i++) {
          if (frame[i] !== png.rgb[i]) {
            const p = Math.floor(i / 3);
            const at = (b: Uint8Array): string => `(${[...b.slice(p * 3, p * 3 + 3)].join(",")})`;
            first = `first differing pixel (${p % scene.panel.width}, ${Math.floor(p / scene.panel.width)}): frame ${at(frame)}, golden ${at(png.rgb)}`;
          }
        }
        expect(first, `scene ${name} tick ${tick}: ${first}`).toBe("");
        expect(sha, `scene ${name} tick ${tick}: sha256`).toBe(golden.frames.find((f) => f.tick === tick)?.sha256);
      }
    });
  }
});

describe("the profile (AC-8)", () => {
  it("xorshift32 gives the document's first three values for seeds 1, 2 and 3", () => {
    const want = {
      1: [270369, 67634689, 2647435461],
      2: [540738, 134253570, 697882754],
      3: [811107, 201886211, 3025432647],
    };
    for (const [seed, values] of Object.entries(want)) {
      const r = xorshift32(Number(seed));
      expect([r(), r(), r()]).toEqual(values);
    }
  });
  it("the clock is start + (t * 1000) / 60 at ticks 0, 1, 59 and 60", () => {
    const scene = readScene(readFileSync(join(conf, "scenes", "spike.json"), "utf8"));
    const env = profileEnvironment(scene);
    const start = scene.startUnixMs;
    expect([0, 1, 59, 60].map((t) => Number(env.time(t).unixMs) - start)).toEqual([0, 16, 983, 1000]);
    expect(env.time(1).offsetS).toBe(scene.utcOffsetS);
  });
  it("readScene rejects an unknown and a missing field, naming it", () => {
    const good = JSON.parse(readFileSync(join(conf, "scenes", "spike-clock.json"), "utf8")) as Record<string, unknown>;
    expect(() => readScene({ ...good, extra: 1 })).toThrow(/unknown field extra/);
    const { ticks, ...without } = good;
    void ticks;
    expect(() => readScene(without)).toThrow(/missing field ticks/);
    const placements = (good.placements as Record<string, unknown>[]).map((p) => ({ ...p, bogus: true }));
    expect(() => readScene({ ...good, placements })).toThrow(/placements\[0\]: unknown field bogus/);
    const noSeed = (good.placements as Record<string, unknown>[]).map(({ seed, ...p }) => (void seed, p));
    expect(() => readScene({ ...good, placements: noSeed })).toThrow(/missing field seed/);
  });
  it("two runs of the same scene and files return equal frames", async () => {
    const scene = readScene(readFileSync(join(conf, "scenes", "spike-scroll.json"), "utf8"));
    const f = files(scene);
    const a = await runConformance(scene, f);
    const b = await runConformance(scene, f);
    expect(a).toEqual(b);
  });
});
