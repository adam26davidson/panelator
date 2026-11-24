import { loadModule } from "./module.ts";
import { parseFont } from "./font.ts";
import { createScene, type Asset, type Environment, type PlacementSpec, type Scene } from "./scene.ts";
import { assemble, type ModuleSpec } from "./testwasm.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { suite } from "./files.ts";

// Test helpers: build a scene of hand-assembled modules.
export const fonts = {
  1: parseFont(readFileSync(join(suite, "fonts", "spleen-5x8.bdf"), "utf8")),
  2: parseFont(readFileSync(join(suite, "fonts", "spleen-8x16.bdf"), "utf8")),
};

export const fixedEnv = (unixMs = 1000n, offsetS = 0, rnd: () => number = () => 7): Environment => ({
  time: () => ({ unixMs, offsetS }),
  random: () => rnd,
});

export interface Place extends Omit<PlacementSpec, "module" | "opacity" | "x" | "y" | "z"> {
  spec: ModuleSpec;
  x?: number;
  y?: number;
  z?: number;
  opacity?: number;
}

export async function sceneOf(
  panel: { width: number; height: number },
  places: Place[],
  extra: { assets?: Asset[]; environment?: Environment } = {},
): Promise<Scene> {
  const placements: PlacementSpec[] = [];
  for (const p of places) {
    const { spec, ...rest } = p;
    placements.push({ x: 0, y: 0, z: 0, opacity: 255, ...rest, module: await loadModule(assemble(spec)) });
  }
  return createScene({ panel, fonts, assets: extra.assets ?? [], placements, environment: extra.environment ?? fixedEnv() });
}

/** The set pixels of a white-on-black frame as rows of 0 and 1. */
export function bitmap(scene: Scene): number[][] {
  const { width, height } = scene.panel;
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => (scene.frame[(y * width + x) * 3] === 255 ? 1 : 0)),
  );
}

export const WHITE = -1; // 0xFFFFFFFF as an i32
