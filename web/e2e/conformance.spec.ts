import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";

// Spec 115 AC-12: the engine's source, built by Vite for this test, runs the four scenes of the suite in Chromium.
// Nothing here is part of the app's bundle or its routes.
const repo = join(import.meta.dirname, "..", "..");
const suite = join(repo, "sdk", "conformance");
const b64 = (path: string) => readFileSync(path).toString("base64");

let engine = "";
test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: { entry: join(repo, "web", "simulator", "src", "index.ts"), name: "PanelatorSim", formats: ["iife"] },
    },
  });
  const bundles = Array.isArray(output) ? output : [output];
  engine = (bundles[0] as { output: { code: string }[] }).output[0]?.code ?? "";
  expect(engine.length).toBeGreaterThan(1000);
});

for (const name of ["spike-clock", "spike-scroll", "spike-image", "spike"]) {
  test(`scene ${name}: every captured frame equals its golden frame in Chromium, and the canvas shows it`, async ({
    page,
  }) => {
    const sceneText = readFileSync(join(suite, "scenes", `${name}.json`), "utf8");
    const sceneJson = JSON.parse(sceneText) as {
      assets: { file: string }[];
      placements: { module: string }[];
    };
    const golden = JSON.parse(readFileSync(join(suite, "golden", name, "frames.json"), "utf8")) as {
      frames: { tick: number; sha256: string }[];
    };
    await page.route("**/__engine.js", (route) => route.fulfill({ contentType: "text/javascript", body: engine }));
    await page.goto("/");
    await page.addScriptTag({ url: "/__engine.js" });
    const files = {
      modules: Object.fromEntries(
        sceneJson.placements.map((p) => [p.module, b64(join(repo, "target", "widgets", `${p.module}.wasm`))]),
      ),
      assets: Object.fromEntries(sceneJson.assets.map((a) => [a.file, b64(join(suite, "assets", a.file))])),
      fonts: {
        1: readFileSync(join(suite, "fonts", "spleen-5x8.bdf"), "utf8"),
        2: readFileSync(join(suite, "fonts", "spleen-8x16.bdf"), "utf8"),
      },
    };
    const result = await page.evaluate(
      async ({ sceneText, files }) => {
        const sim = (window as unknown as { PanelatorSim: Record<string, (...a: never[]) => unknown> })
          .PanelatorSim as never as {
          readScene(t: string): { panel: { width: number; height: number } };
          runConformance(s: unknown, f: unknown): Promise<{ tick: number; frame: Uint8Array }[]>;
          frameSha256(f: Uint8Array): Promise<string>;
          presentFrame(c: CanvasRenderingContext2D, f: Uint8Array, w: number, h: number): void;
        };
        const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        const scene = sim.readScene(sceneText);
        const frames = await sim.runConformance(scene, {
          modules: Object.fromEntries(Object.entries(files.modules).map(([k, v]) => [k, bytes(v)])),
          assets: Object.fromEntries(Object.entries(files.assets).map(([k, v]) => [k, bytes(v)])),
          fonts: files.fonts,
        });
        const hashes: { tick: number; sha: string }[] = [];
        for (const f of frames) hashes.push({ tick: f.tick, sha: await sim.frameSha256(f.frame) });
        const last = frames[frames.length - 1] as { frame: Uint8Array };
        const { width, height } = scene.panel;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        sim.presentFrame(context, last.frame, width, height);
        const read = context.getImageData(0, 0, width, height).data;
        let wrong = 0;
        for (let i = 0; i < width * height; i++) {
          if (
            read[i * 4] !== last.frame[i * 3] ||
            read[i * 4 + 1] !== last.frame[i * 3 + 1] ||
            read[i * 4 + 2] !== last.frame[i * 3 + 2] ||
            read[i * 4 + 3] !== 255
          )
            wrong++;
        }
        return { hashes, wrong };
      },
      { sceneText, files },
    );
    expect(
      result.hashes.map((h) => h.tick),
      `scene ${name}: the ticks captured`,
    ).toEqual(golden.frames.map((f) => f.tick));
    for (const h of result.hashes) {
      const want = golden.frames.find((f) => f.tick === h.tick)?.sha256;
      expect(h.sha, `scene ${name} tick ${h.tick}`).toBe(want);
    }
    expect(result.wrong, `scene ${name}: pixels of the last tick that differ after presentFrame and getImageData`).toBe(
      0,
    );
  });
}
