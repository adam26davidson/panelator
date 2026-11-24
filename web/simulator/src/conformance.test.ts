import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { frameSha256, profileUnixMs, runConformance, xorshift32 } from "./conformance.ts";
import { loadScene, loadSuite, readBytes, suite, widgets } from "./files.ts";
import { decodePng } from "./png.ts";

const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

describe("golden frames (AC-11)", () => {
  it("states the SHA-256 of each module it runs", () => {
    for (const f of ["spike-clock.wasm", "spike-scroll.wasm", "spike-image.wasm"]) {
      console.log(`module ${f} sha256 ${createHash("sha256").update(readBytes(join(widgets, f))).digest("hex")}`);
    }
  });

  for (const name of ["spike-clock", "spike-scroll", "spike-image", "spike"]) {
    it(`scene ${name}: every captured frame equals its golden frame`, async () => {
      const scene = loadScene(name);
      const golden = JSON.parse(readFileSync(join(suite, "golden", name, "frames.json"), "utf8")) as {
        frames: { tick: number; sha256: string }[];
      };
      const frames = await runConformance(scene, loadSuite(scene));
      expect(
        golden.frames.map((f) => f.tick),
        `${name}: frames.json lists the ticks the scene captures`,
      ).toEqual(frames.map((f) => f.tick));
      for (const { tick, frame } of frames) {
        const want = golden.frames.find((f) => f.tick === tick) as { sha256: string };
        const png = decodePng(readBytes(join(suite, "golden", name, `tick-${tick}.png`)));
        expect(png.width * png.height * 3).toBe(frame.length);
        for (let i = 0; i < frame.length; i += 3) {
          if (frame[i] !== png.rgb[i] || frame[i + 1] !== png.rgb[i + 1] || frame[i + 2] !== png.rgb[i + 2]) {
            const p = i / 3;
            expect.fail(
              `scene ${name} tick ${tick}: first differing pixel (${p % png.width}, ${Math.floor(p / png.width)}) is ${hex([...frame.subarray(i, i + 3)])}, golden ${hex([...png.rgb.subarray(i, i + 3)])}`,
            );
          }
        }
        expect(await frameSha256(frame), `scene ${name} tick ${tick}`).toBe(want.sha256);
      }
    });
  }
});

describe("the profile (AC-8)", () => {
  it("xorshift32 gives the document's first three values for seeds 1, 2 and 3", () => {
    const first = (seed: number) => {
      const out: number[] = [];
      let x = seed;
      for (let i = 0; i < 3; i++) out.push((x = xorshift32(x)));
      return out;
    };
    expect(first(1)).toEqual([270369, 67634689, 2647435461]);
    expect(first(2)).toEqual([540738, 134253570, 697882754]);
    expect(first(3)).toEqual([811107, 201886211, 3025432647]);
  });

  it("the clock is start + (t * 1000) / 60 at ticks 0, 1, 59 and 60", () => {
    const start = 1798757998000;
    expect([0, 1, 59, 60].map((t) => profileUnixMs(start, t))).toEqual([
      BigInt(start),
      BigInt(start + 16),
      BigInt(start + 983),
      BigInt(start + 1000),
    ]);
  });
});
