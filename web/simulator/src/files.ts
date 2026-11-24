import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceFiles, ConformanceScene } from "./conformance.ts";
import { readScene } from "./conformance.ts";

// Test helpers: the suite and the built modules, read from disk. Nothing here writes a file.
export const root = join(import.meta.dirname, "..", "..", "..");
export const suite = join(root, "sdk", "conformance");
export const widgets = join(root, "target", "widgets");

export const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

export function loadSuite(scene: ConformanceScene): ConformanceFiles {
  return {
    modules: Object.fromEntries(scene.placements.map((p) => [p.module, readBytes(join(widgets, `${p.module}.wasm`))])),
    assets: Object.fromEntries(scene.assets.map((a) => [a.file, readBytes(join(suite, "assets", a.file))])),
    fonts: {
      1: readFileSync(join(suite, "fonts", "spleen-5x8.bdf"), "utf8"),
      2: readFileSync(join(suite, "fonts", "spleen-8x16.bdf"), "utf8"),
    },
  };
}

export const loadScene = (name: string): ConformanceScene =>
  readScene(readFileSync(join(suite, "scenes", `${name}.json`), "utf8"));
