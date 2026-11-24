import { SimulatorError } from "./errors.ts";
import { parseFont } from "./font.ts";
import { loadModule } from "./module.ts";
import { type Asset, createScene, type Environment } from "./scene.ts";

export interface ConformanceScene {
  abi: string;
  panel: { width: number; height: number };
  startUnixMs: number;
  utcOffsetS: number;
  ticks: number[];
  assets: { name: string; file: string; width: number; height: number; frames: number }[];
  placements: {
    module: string;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    opacity: number;
    config: Record<string, unknown>;
    seed: number;
  }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks that `o` has exactly the `fields`, each of its kind; names the first unknown or missing one. */
function exact(
  o: unknown,
  where: string,
  fields: Record<string, "number" | "string" | "array" | "object">,
): Record<string, unknown> {
  if (!isObject(o)) throw new SimulatorError("scene", `${where} is not an object`);
  for (const k of Object.keys(o)) if (!(k in fields)) throw new SimulatorError("scene", `${where}: unknown field ${k}`);
  for (const [k, kind] of Object.entries(fields)) {
    if (!(k in o)) throw new SimulatorError("scene", `${where}: missing field ${k}`);
    const v = o[k];
    const ok = kind === "array" ? Array.isArray(v) : kind === "object" ? isObject(v) : typeof v === kind;
    if (!ok) throw new SimulatorError("scene", `${where}: field ${k} is not a ${kind}`);
  }
  return o;
}

/** Reads a scene file of the document's "The conformance profile", rejecting an unknown or missing field by name. */
export function readScene(json: string | unknown): ConformanceScene {
  const root = exact(typeof json === "string" ? JSON.parse(json) : json, "scene", {
    abi: "string",
    panel: "object",
    start_unix_ms: "number",
    utc_offset_s: "number",
    ticks: "array",
    assets: "array",
    placements: "array",
  });
  const panel = exact(root.panel, "panel", { width: "number", height: "number" });
  const assets = (root.assets as unknown[]).map((a, i) =>
    exact(a, `assets[${i}]`, { name: "string", file: "string", width: "number", height: "number", frames: "number" }),
  );
  const placements = (root.placements as unknown[]).map((p, i) =>
    exact(p, `placements[${i}]`, {
      module: "string",
      x: "number",
      y: "number",
      width: "number",
      height: "number",
      z: "number",
      opacity: "number",
      config: "object",
      seed: "number",
    }),
  );
  if (root.abi !== "0.1") throw new SimulatorError("scene", `abi is ${String(root.abi)}, not 0.1`);
  return {
    abi: root.abi,
    panel: panel as ConformanceScene["panel"],
    startUnixMs: root.start_unix_ms as number,
    utcOffsetS: root.utc_offset_s as number,
    ticks: root.ticks as number[],
    assets: assets as ConformanceScene["assets"],
    placements: placements as ConformanceScene["placements"],
  };
}

/** xorshift32 on its own state; the new state is returned (docs/widget-abi.md "The conformance profile"). */
export function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    return x;
  };
}

/** The profile's environment: time is `start_unix_ms + (t * 1000) / 60`, the offset the scene's, random per placement. */
export function profileEnvironment(scene: ConformanceScene): Environment {
  return {
    time: (t) => ({ unixMs: scene.startUnixMs + Math.floor((t * 1000) / 60), offsetS: scene.utcOffsetS }),
    random: (i) => xorshift32((scene.placements[i] as { seed: number }).seed),
  };
}

export interface ConformanceFiles {
  /** Module bytes by name (`spike-clock`). */
  modules: Record<string, Uint8Array>;
  /** Asset bytes by the scene's `file`. */
  assets: Record<string, Uint8Array>;
  /** The text of the BDF files: font 1 (5x8) and font 2 (8x16). */
  fonts: [string, string];
}

/** Runs a scene of the profile from tick 0 to its last captured tick and returns a copy of each captured frame. */
export async function runConformance(
  scene: ConformanceScene,
  files: ConformanceFiles,
): Promise<{ tick: number; frame: Uint8Array }[]> {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new SimulatorError("scene", `missing file: ${what}`);
    return v;
  };
  const modules = new Map<string, Awaited<ReturnType<typeof loadModule>>>();
  for (const p of scene.placements) {
    if (!modules.has(p.module))
      modules.set(p.module, await loadModule(need(files.modules[p.module], `module ${p.module}`), p.module));
  }
  const assets: Asset[] = scene.assets.map((a) => ({
    name: a.name,
    width: a.width,
    height: a.height,
    frames: a.frames,
    bytes: need(files.assets[a.file], `asset ${a.file}`),
  }));
  const sim = await createScene({
    panel: scene.panel,
    fonts: [parseFont(files.fonts[0]), parseFont(files.fonts[1])],
    assets,
    placements: scene.placements.map((p) => ({
      module: modules.get(p.module) as NonNullable<ReturnType<typeof modules.get>>,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      z: p.z,
      opacity: p.opacity,
      config: p.config,
    })),
    environment: profileEnvironment(scene),
  });
  const captured = new Set(scene.ticks);
  const last = Math.max(...scene.ticks);
  const out: { tick: number; frame: Uint8Array }[] = [];
  for (let t = 0; t <= last; t++) {
    sim.step();
    if (captured.has(t)) out.push({ tick: t, frame: sim.frame.slice() });
  }
  return out;
}

/** The SHA-256 of a frame's bytes in lowercase hex. */
export async function frameSha256(frame: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", frame as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
