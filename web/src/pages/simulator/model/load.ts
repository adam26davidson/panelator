import {
  type ConformanceScene,
  createScene,
  liveEnvironment,
  loadModule,
  parseFont,
  readScene,
  type Scene,
} from "@panelator/simulator";
import sceneText from "../../../../../sdk/conformance/scenes/spike.json?raw";
import type { PlacementRow } from "./types";

/** Where the build serves the simulator's inputs (web/vite.config.ts). */
const BASE = "/simulator-files";

/** The scene the page shows: its panel, assets and placements. Its start time, offset, ticks and seeds are not used. */
export const SPIKE: ConformanceScene = readScene(sceneText);

export const initialRows = (scene: ConformanceScene): PlacementRow[] =>
  scene.placements.map((p) => ({ module: p.module, width: p.width, height: p.height }));

async function get(url: string, name: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(`${name}: could not be fetched (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!response.ok) throw new Error(`${name}: could not be fetched (${response.status})`);
  return response.arrayBuffer();
}

/** Fetches every file the scene names and builds the scene on the live environment; `pn_init` has returned when it resolves. */
export async function loadSimulator(scene: ConformanceScene): Promise<Scene> {
  const names = [...new Set(scene.placements.map((p) => p.module))];
  const [fonts, modules, assets] = await Promise.all([
    Promise.all(
      ["spleen-5x8.bdf", "spleen-8x16.bdf"].map(async (f) =>
        new TextDecoder().decode(await get(`${BASE}/fonts/${f}`, f)),
      ),
    ),
    Promise.all(
      names.map(async (n) => [n, new Uint8Array(await get(`${BASE}/widgets/${n}.wasm`, `${n}.wasm`))] as const),
    ),
    Promise.all(
      scene.assets.map(async (a) => ({
        name: a.name,
        width: a.width,
        height: a.height,
        frames: a.frames,
        bytes: new Uint8Array(await get(`${BASE}/assets/${a.file}`, a.file)),
      })),
    ),
  ]);
  const loaded = new Map<string, Awaited<ReturnType<typeof loadModule>>>();
  for (const [name, bytes] of modules) loaded.set(name, await loadModule(bytes, name));
  return createScene({
    panel: scene.panel,
    fonts: [parseFont(fonts[0] as string), parseFont(fonts[1] as string)],
    assets,
    placements: scene.placements.map((p) => ({
      module: loaded.get(p.module) as NonNullable<ReturnType<typeof loaded.get>>,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      z: p.z,
      opacity: p.opacity,
      config: p.config,
    })),
    environment: liveEnvironment(),
  });
}
