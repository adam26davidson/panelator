import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";

// The golden frames in Chromium (spec 115 AC-12): the engine's source, built by Vite for this test, is loaded into a page
// of the preview server's origin and given the module, font, asset and scene bytes read from disk here. Nothing of this
// is in the app's bundle or its routes.
const root = join(import.meta.dirname, "..", "..");
const conf = join(root, "sdk", "conformance");
const b64 = (path: string) => readFileSync(path).toString("base64");

let engine: Promise<string> | undefined;
function engineSource(): Promise<string> {
  engine ??= build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: join(root, "web", "simulator", "src", "index.ts"), formats: ["es"], fileName: "engine" },
    },
  }).then((out) => {
    const result = Array.isArray(out) ? out[0] : out;
    const chunk = result && "output" in result ? result.output.find((o) => o.type === "chunk") : undefined;
    if (!chunk || chunk.type !== "chunk") throw new Error("the engine did not build");
    return chunk.code;
  });
  return engine;
}

for (const name of ["spike-clock", "spike-scroll", "spike-image", "spike"]) {
  test(`scene ${name}: every captured frame equals its golden frame in Chromium`, async ({ page }) => {
    const code = await engineSource();
    await page.route("**/__engine.js", (route) => route.fulfill({ contentType: "text/javascript", body: code }));
    await page.goto("/");
    const sceneText = readFileSync(join(conf, "scenes", `${name}.json`), "utf8");
    const scene = JSON.parse(sceneText) as {
      placements: { module: string }[];
      assets: { file: string }[];
    };
    const golden = JSON.parse(readFileSync(join(conf, "golden", name, "frames.json"), "utf8")) as {
      frames: { tick: number; sha256: string }[];
    };
    const input = {
      sceneText,
      modules: Object.fromEntries(
        [...new Set(scene.placements.map((p) => p.module))].map((m) => [
          m,
          b64(join(root, "target", "widgets", `${m}.wasm`)),
        ]),
      ),
      assets: Object.fromEntries(scene.assets.map((a) => [a.file, b64(join(conf, "assets", a.file))])),
      fonts: [
        readFileSync(join(conf, "fonts", "spleen-5x8.bdf"), "utf8"),
        readFileSync(join(conf, "fonts", "spleen-8x16.bdf"), "utf8"),
      ],
    };
    const result = await page.evaluate(async (i) => {
      const url = "/__engine.js";
      const e = await import(/* @vite-ignore */ url);
      const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const parsed = e.readScene(i.sceneText);
      const frames = await e.runConformance(parsed, {
        modules: Object.fromEntries(Object.entries(i.modules).map(([k, v]) => [k, bytes(v)])),
        assets: Object.fromEntries(Object.entries(i.assets).map(([k, v]) => [k, bytes(v)])),
        fonts: i.fonts,
      });
      const hashes = await Promise.all(
        frames.map(async (f: { tick: number; frame: Uint8Array }) => ({
          tick: f.tick,
          sha: await e.frameSha256(f.frame),
        })),
      );
      const last = frames[frames.length - 1];
      const { width, height } = parsed.panel;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      e.presentFrame(context, last.frame, width, height);
      const read = context.getImageData(0, 0, width, height).data;
      let presented = true;
      for (let p = 0; p < width * height; p++) {
        for (let c = 0; c < 3; c++) if (read[p * 4 + c] !== last.frame[p * 3 + c]) presented = false;
        if (read[p * 4 + 3] !== 255) presented = false;
      }
      return { hashes, presented, lastTick: last.tick };
    }, input);
    expect(
      result.hashes.map((h) => h.tick),
      `scene ${name}: captured ticks`,
    ).toEqual(golden.frames.map((f) => f.tick));
    for (const h of result.hashes) {
      expect(h.sha, `scene ${name} tick ${h.tick}`).toBe(golden.frames.find((f) => f.tick === h.tick)?.sha256);
    }
    expect(result.presented, `scene ${name} tick ${result.lastTick}: the canvas holds the frame`).toBe(true);
  });
}
