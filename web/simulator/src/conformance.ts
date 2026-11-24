import { SimulatorError } from "./errors.ts";
import { parseFont } from "./font.ts";
import { loadModule, type LoadedModule } from "./module.ts";
import { createScene, type Environment } from "./scene.ts";

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

export interface ConformanceFiles {
  /** The bytes of each module by name (`spike-clock`). */
  modules: Record<string, Uint8Array>;
  /** The bytes of each asset by its file (`spike-image.rgb`). */
  assets: Record<string, Uint8Array>;
  /** The two BDF files as text. */
  fonts: { 1: string; 2: string };
}

type Obj = Record<string, unknown>;

function object(v: unknown, path: string, fields: readonly string[]): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new SimulatorError(`scene: ${path} is not an object`, { rule: "scene field" });
  const o = v as Obj;
  for (const k of Object.keys(o))
    if (!fields.includes(k)) throw new SimulatorError(`scene: unknown field ${path === "" ? k : `${path}.${k}`}`, { rule: "scene field" });
  for (const k of fields)
    if (!(k in o)) throw new SimulatorError(`scene: missing field ${path === "" ? k : `${path}.${k}`}`, { rule: "scene field" });
  return o;
}

function int(v: unknown, path: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new SimulatorError(`scene: ${path} is not an integer from ${min} to ${max}`, { rule: "scene field" });
  return v;
}

function text(v: unknown, path: string): string {
  if (typeof v !== "string") throw new SimulatorError(`scene: ${path} is not a string`, { rule: "scene field" });
  return v;
}

function list(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new SimulatorError(`scene: ${path} is not a list`, { rule: "scene field" });
  return v;
}

/** Reads a scene file of the document's "The conformance profile"; an unknown or missing field is an error naming it. */
export function readScene(json: unknown): ConformanceScene {
  const value = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const o = object(value, "", ["abi", "panel", "start_unix_ms", "utc_offset_s", "ticks", "assets", "placements"]);
  if (o.abi !== "0.1") throw new SimulatorError(`scene: abi is ${JSON.stringify(o.abi)}, expected "0.1"`, { rule: "scene field" });
  const panel = object(o.panel, "panel", ["width", "height"]);
  const ticks = list(o.ticks, "ticks").map((t, i) => int(t, `ticks[${i}]`, 0));
  ticks.forEach((t, i) => {
    if (i > 0 && t <= (ticks[i - 1] as number)) throw new SimulatorError("scene: ticks is not ascending", { rule: "scene field" });
  });
  return {
    abi: "0.1",
    panel: { width: int(panel.width, "panel.width", 1), height: int(panel.height, "panel.height", 1) },
    startUnixMs: int(o.start_unix_ms, "start_unix_ms"),
    utcOffsetS: int(o.utc_offset_s, "utc_offset_s"),
    ticks,
    assets: list(o.assets, "assets").map((a, i) => {
      const p = `assets[${i}]`;
      const e = object(a, p, ["name", "file", "width", "height", "frames"]);
      return {
        name: text(e.name, `${p}.name`),
        file: text(e.file, `${p}.file`),
        width: int(e.width, `${p}.width`, 1),
        height: int(e.height, `${p}.height`, 1),
        frames: int(e.frames, `${p}.frames`, 1),
      };
    }),
    placements: list(o.placements, "placements").map((a, i) => {
      const p = `placements[${i}]`;
      const e = object(a, p, ["module", "x", "y", "width", "height", "z", "opacity", "config", "seed"]);
      const config = e.config;
      if (typeof config !== "object" || config === null || Array.isArray(config))
        throw new SimulatorError(`scene: ${p}.config is not an object`, { rule: "scene field" });
      const seed = int(e.seed, `${p}.seed`, 1, 0xffffffff);
      return {
        module: text(e.module, `${p}.module`),
        x: int(e.x, `${p}.x`),
        y: int(e.y, `${p}.y`),
        width: int(e.width, `${p}.width`, 1),
        height: int(e.height, `${p}.height`, 1),
        z: int(e.z, `${p}.z`),
        opacity: int(e.opacity, `${p}.opacity`, 0, 255),
        config: config as Record<string, unknown>,
        seed,
      };
    }),
  };
}

/** One step of xorshift32 on 32 bits. */
export function xorshift32(x: number): number {
  let v = x >>> 0;
  v = (v ^ (v << 13)) >>> 0;
  v = (v ^ (v >>> 17)) >>> 0;
  v = (v ^ (v << 5)) >>> 0;
  return v;
}

/** The profile's `time_unix_ms` at tick `t`: `start + (t * 1000) / 60`, integer division. */
export function profileUnixMs(startUnixMs: number, t: number): bigint {
  return BigInt(startUnixMs) + (BigInt(t) * 1000n) / 60n;
}

/** The environment of the conformance profile. */
export function profileEnvironment(scene: ConformanceScene): Environment {
  return {
    time: (t) => ({ unixMs: profileUnixMs(scene.startUnixMs, t), offsetS: scene.utcOffsetS }),
    random: (index) => {
      let state = (scene.placements[index] as { seed: number }).seed >>> 0;
      return () => {
        state = xorshift32(state);
        return state;
      };
    },
  };
}

/** Runs a scene by the profile and returns a copy of the frame at each captured tick. */
export async function runConformance(scene: ConformanceScene, files: ConformanceFiles): Promise<{ tick: number; frame: Uint8Array }[]> {
  const loaded = new Map<string, LoadedModule>();
  for (const p of scene.placements) {
    if (loaded.has(p.module)) continue;
    const bytes = files.modules[p.module];
    if (!bytes) throw new SimulatorError(`conformance: no module named ${p.module}`, { rule: "conformance files", module: p.module });
    loaded.set(p.module, await loadModule(bytes));
  }
  const assets = scene.assets.map((a) => {
    const bytes = files.assets[a.file];
    if (!bytes) throw new SimulatorError(`conformance: no asset file ${a.file}`, { rule: "conformance files" });
    return { name: a.name, width: a.width, height: a.height, frames: a.frames, bytes };
  });
  const sim = await createScene({
    panel: scene.panel,
    fonts: { 1: parseFont(files.fonts[1]), 2: parseFont(files.fonts[2]) },
    assets,
    placements: scene.placements.map((p) => ({ ...p, module: loaded.get(p.module) as LoadedModule, name: p.module })),
    environment: profileEnvironment(scene),
  });
  const last = scene.ticks[scene.ticks.length - 1] ?? -1;
  const out: { tick: number; frame: Uint8Array }[] = [];
  for (let t = 0; t <= last; t++) {
    sim.step();
    if (scene.ticks.includes(t)) out.push({ tick: t, frame: sim.frame.slice() });
  }
  return out;
}

/** The SHA-256 of a frame's bytes, in lowercase hex. */
export async function frameSha256(frame: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", frame as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
