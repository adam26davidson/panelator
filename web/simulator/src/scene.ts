import { IMPORT_MODULE, MAX_PAGES, PAGE } from "./abi.ts";
import { SimulatorError } from "./errors.ts";
import { drawText, type Font } from "./font.ts";
import { Layer } from "./layer.ts";
import type { LoadedModule } from "./module.ts";

export interface Asset {
  name: string;
  width: number;
  height: number;
  frames: number;
  /** Raw RGB, 3 bytes a pixel, frames one after another. */
  bytes: Uint8Array;
}

export interface PlacementSpec {
  module: LoadedModule;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  opacity: number;
  config: Record<string, unknown>;
}

export interface Environment {
  /** The time for a tick (0 during `pn_init`); read once per tick. */
  time(tick: number): { unixMs: number | bigint; offsetS: number };
  /** The random source of placement `index`: 32 random bits a call. */
  random(index: number): () => number;
}

export interface SceneOptions {
  panel: { width: number; height: number };
  /** Fonts 1 and 2 of the ABI, in that order. */
  fonts: [Font, Font];
  assets: Asset[];
  placements: PlacementSpec[];
  environment: Environment;
}

export interface PlacementInfo {
  index: number;
  name: string;
  updateHz: number;
  declaredWidth: number;
  declaredHeight: number;
  layer: { width: number; height: number };
}

export interface Scene {
  readonly panel: { width: number; height: number };
  /** The tick last run, -1 before the first. */
  readonly tick: number;
  /** The composed RGB frame of the tick last run (width * height * 3 bytes). */
  readonly frame: Uint8Array;
  readonly placements: readonly PlacementInfo[];
  /** Runs the next tick, or the given tick (never lower than the next one) with the ticks between skipped. */
  step(tick?: number): void;
}

const latin1 = (b: Uint8Array): string => {
  let s = "";
  for (const v of b) s += String.fromCharCode(v);
  return s;
};

interface Running {
  spec: PlacementSpec;
  info: PlacementInfo;
  layer: Layer;
  exports: { memory: WebAssembly.Memory; pn_init(): void; pn_update(tick: bigint): void };
  order: number;
}

/** Instantiates every placement with a layer of its size, calls `pn_init` in order, and returns the scene. */
export async function createScene(options: SceneOptions): Promise<Scene> {
  const { panel, fonts, assets, environment } = options;
  if (!(Number.isInteger(panel.width) && panel.width > 0 && Number.isInteger(panel.height) && panel.height > 0)) {
    throw new SimulatorError("panel", `the panel ${panel.width} by ${panel.height} is not two positive integers`);
  }
  const byName = new Map<string, Asset>();
  for (const a of assets) {
    if (a.bytes.length !== a.width * a.height * a.frames * 3) {
      throw new SimulatorError(
        "asset length",
        `asset ${a.name}: ${a.bytes.length} bytes, expected ${a.width} * ${a.height} * ${a.frames} * 3 = ${a.width * a.height * a.frames * 3}`,
      );
    }
    byName.set(latin1(new TextEncoder().encode(a.name)), a);
  }
  const frame = new Uint8Array(panel.width * panel.height * 3);
  let tick = -1;
  let next = 0;
  let ended = false;
  let now = environment.time(0);
  const encoder = new TextEncoder();

  const running: Running[] = [];
  const stepOf = (r: Running, exportName: string, t: number, fn: () => void): void => {
    try {
      fn();
      const pages = r.exports.memory.buffer.byteLength / PAGE;
      if (!r.spec.module.boundedMemory && pages > MAX_PAGES) {
        throw new SimulatorError(
          "memory limit",
          `memory limit: the memory grew to ${pages} pages, the limit is ${MAX_PAGES}`,
        );
      }
    } catch (e) {
      ended = true;
      const why = e instanceof Error ? e.message : String(e);
      throw new SimulatorError(
        "trap",
        `placement ${r.info.index} (${r.info.name}): ${exportName} at tick ${t} ended in an error: ${why}`,
        { placement: r.info.index, module: r.info.name, export: exportName, tick: t, cause: e },
      );
    }
  };

  const hostFor = (index: number, spec: PlacementSpec, layer: Layer, memoryRef: { memory?: WebAssembly.Memory }) => {
    const bytes = (): Uint8Array => new Uint8Array((memoryRef.memory as WebAssembly.Memory).buffer); // read afresh: growth replaces it
    const slice = (ptr: number, len: number, what: string): Uint8Array => {
      const mem = bytes();
      const p = ptr >>> 0;
      const l = len >>> 0;
      if (p + l > mem.length)
        throw new SimulatorError("memory access", `${what}: [${p}, ${p + l}) is outside the ${mem.length}-byte memory`);
      return mem.subarray(p, p + l);
    };
    const fontOf = (id: number): Font | undefined => (id === 1 ? fonts[0] : id === 2 ? fonts[1] : undefined);
    const config = encoder.encode(JSON.stringify(spec.config ?? {}));
    const random = environment.random(index);
    return {
      layer_width: () => layer.width,
      layer_height: () => layer.height,
      draw_fill: (c: number) => layer.fill(c),
      draw_pixel: (x: number, y: number, c: number) => layer.pixel(x, y, c),
      draw_line: (a: number, b: number, c: number, d: number, col: number) => layer.line(a, b, c, d, col),
      draw_rect: (x: number, y: number, w: number, h: number, c: number, f: number) => layer.rect(x, y, w, h, c, f),
      draw_circle: (x: number, y: number, r: number, c: number, f: number) => layer.circle(x, y, r, c, f),
      draw_text: (font: number, x: number, y: number, ptr: number, len: number, c: number) => {
        const text = slice(ptr, len, "draw_text");
        const f = fontOf(font);
        return f ? drawText(f, layer, x, y, text, c) : -1;
      },
      text_width: (font: number, ptr: number, len: number) => {
        const text = slice(ptr, len, "text_width");
        const f = fontOf(font);
        return f ? drawText(f, undefined, 0, 0, text, 0) : -1;
      },
      font_height: (font: number) => fontOf(font)?.cellHeight ?? -1,
      draw_image: (np: number, nl: number, frameNo: number, x: number, y: number) => {
        const asset = byName.get(latin1(slice(np, nl, "draw_image")));
        if (!asset) return -1;
        if (frameNo < 0 || frameNo >= asset.frames) return -2;
        const base = frameNo * asset.width * asset.height * 3;
        const x0 = Math.max(0, -x);
        const x1 = Math.min(asset.width, layer.width - x);
        for (let iy = Math.max(0, -y); iy < Math.min(asset.height, layer.height - y); iy++) {
          for (let ix = x0; ix < x1; ix++) {
            const s = base + (iy * asset.width + ix) * 3;
            layer.setRGBA(
              x + ix,
              y + iy,
              asset.bytes[s] as number,
              asset.bytes[s + 1] as number,
              asset.bytes[s + 2] as number,
              255,
            );
          }
        }
        return 0;
      },
      config_len: () => config.length,
      config_read: (ptr: number, cap: number) => {
        if (cap < 0) return 0;
        const buffer = slice(ptr, cap, "config_read");
        const n = Math.min(cap, config.length);
        buffer.set(config.subarray(0, n));
        return n;
      },
      time_unix_ms: () => BigInt(now.unixMs),
      time_utc_offset_s: () => now.offsetS,
      random_u32: () => random() | 0,
    };
  };

  for (const [index, spec] of options.placements.entries()) {
    const layer = new Layer(spec.width, spec.height);
    const memoryRef: { memory?: WebAssembly.Memory } = {};
    const host = hostFor(index, spec, layer, memoryRef);
    const instance = await WebAssembly.instantiate(spec.module.module, { [IMPORT_MODULE]: host });
    const ex = instance.exports as unknown as Running["exports"];
    memoryRef.memory = ex.memory;
    running.push({
      spec,
      layer,
      exports: ex,
      order: index,
      info: {
        index,
        name: spec.module.name,
        updateHz: spec.module.updateHz,
        declaredWidth: spec.module.width,
        declaredHeight: spec.module.height,
        layer: { width: layer.width, height: layer.height },
      },
    });
  }
  for (const r of running) stepOf(r, "pn_init", 0, () => r.exports.pn_init());
  const byZ = [...running].sort((a, b) => a.spec.z - b.spec.z || a.order - b.order);

  const due = (hz: number, t: number): boolean =>
    t === 0 || (hz > 0 && Math.floor((t * hz) / 60) !== Math.floor(((t - 1) * hz) / 60));

  const compose = (): void => {
    frame.fill(0);
    for (const r of byZ) {
      const { x, y, opacity } = r.spec;
      const { layer } = r;
      for (let ly = Math.max(0, -y); ly < Math.min(layer.height, panel.height - y); ly++) {
        for (let lx = Math.max(0, -x); lx < Math.min(layer.width, panel.width - x); lx++) {
          const s = (ly * layer.width + lx) * 4;
          const a = Math.floor(((layer.data[s + 3] as number) * opacity + 127) / 255);
          if (a === 0) continue;
          const d = ((y + ly) * panel.width + x + lx) * 3;
          for (let ch = 0; ch < 3; ch++) {
            frame[d + ch] = Math.floor(
              ((layer.data[s + ch] as number) * a + (frame[d + ch] as number) * (255 - a) + 127) / 255,
            );
          }
        }
      }
    }
  };

  const scene: Scene = {
    panel: { width: panel.width, height: panel.height },
    get tick() {
      return tick;
    },
    frame,
    placements: running.map((r) => r.info),
    step(to?: number) {
      if (ended) throw new SimulatorError("ended", "the scene ended in an error and steps no further");
      const t = to ?? next;
      if (!Number.isInteger(t) || t < next) throw new RangeError(`tick ${t} is not an integer of at least ${next}`);
      now = environment.time(t);
      for (const r of byZ) {
        if (due(r.spec.module.updateHz, t)) stepOf(r, "pn_update", t, () => r.exports.pn_update(BigInt(t)));
      }
      compose();
      tick = t;
      next = t + 1;
    },
  };
  compose();
  return scene;
}
