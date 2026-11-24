import { IMPORT_MODULE, MAX_PAGES, PAGE_BYTES } from "./abi.ts";
import { Layer } from "./draw.ts";
import { SimulatorError } from "./errors.ts";
import type { Font } from "./font.ts";
import type { LoadedModule } from "./module.ts";
import { decodeUtf8, encodeUtf8 } from "./utf8.ts";

export interface Asset {
  name: string;
  width: number;
  height: number;
  frames: number;
  /** Raw RGB, `width * height * 3 * frames` bytes. */
  bytes: Uint8Array;
}

export interface PlacementSpec {
  module: LoadedModule;
  /** The module's name, used in errors; defaults to `module <index>`. */
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  opacity: number;
  config?: Record<string, unknown>;
}

export interface Environment {
  /** The time for a tick, read once per step (`0` for `pn_init`). */
  time(tick: number): { unixMs: bigint; offsetS: number };
  /** The random source of placement `index`: 32 random bits a call. */
  random(index: number): () => number;
}

export interface SceneInit {
  panel: { width: number; height: number };
  fonts: { 1: Font; 2: Font };
  assets: readonly Asset[];
  placements: readonly PlacementSpec[];
  environment: Environment;
}

export interface PlacementInfo {
  index: number;
  name: string;
  updateHz: number;
  /** The module's declared size. */
  declaredWidth: number;
  declaredHeight: number;
  /** The layer's size: the placement's own. */
  width: number;
  height: number;
}

interface Running {
  index: number;
  name: string;
  spec: PlacementSpec;
  layer: Layer;
  memory: WebAssembly.Memory;
  init: () => void;
  update: (tick: bigint) => void;
}

const isPositiveInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

export class Scene {
  readonly panel: { width: number; height: number };
  readonly frame: Uint8Array;
  readonly placements: readonly PlacementInfo[];
  #tick = -1;
  #failed: SimulatorError | undefined;
  #time = { unixMs: 0n, offsetS: 0 };
  readonly #runs: Running[];
  readonly #order: Running[];
  readonly #env: Environment;

  /** @internal use `createScene`. */
  constructor(panel: { width: number; height: number }, runs: Running[], env: Environment) {
    this.panel = { width: panel.width, height: panel.height };
    this.frame = new Uint8Array(panel.width * panel.height * 3);
    this.#runs = runs;
    this.#env = env;
    this.#order = [...runs].sort((a, b) => a.spec.z - b.spec.z || a.index - b.index);
    this.placements = runs.map((r) => ({
      index: r.index,
      name: r.name,
      updateHz: r.spec.module.updateHz,
      declaredWidth: r.spec.module.width,
      declaredHeight: r.spec.module.height,
      width: r.layer.width,
      height: r.layer.height,
    }));
  }

  /** The tick last run, -1 before the first. */
  get tick(): number {
    return this.#tick;
  }

  /** The time of the tick being run. @internal */
  get time(): { unixMs: bigint; offsetS: number } {
    return this.#time;
  }

  /** Calls `pn_init` of every placement in the given order and composes tick 0's layers. @internal */
  init(): void {
    this.#time = this.#env.time(0);
    for (const r of this.#runs) this.#call(r, "pn_init", 0, () => r.init());
    this.#compose();
  }

  /**
   * Runs the next tick (from 0). Given `tick`, an integer never lower than the next one, it runs that tick instead:
   * the ticks between are not run, and the due rule applies at that tick as written.
   */
  step(tick?: number): void {
    if (this.#failed) throw this.#failed;
    const next = this.#tick + 1;
    const t = tick ?? next;
    if (!Number.isSafeInteger(t) || t < next)
      throw new SimulatorError(`step: tick ${String(t)} is not an integer of at least ${next}`, {
        rule: "step",
        tick: next,
      });
    this.#time = this.#env.time(t);
    this.#tick = t;
    for (const r of this.#order) {
      const hz = r.spec.module.updateHz;
      if (t === 0 || (hz > 0 && bucket(t, hz) !== bucket(t - 1, hz)))
        this.#call(r, "pn_update", t, () => r.update(BigInt(t)));
    }
    this.#compose();
  }

  #call(r: Running, name: string, tick: number, f: () => void): void {
    try {
      f();
      if (!r.spec.module.growthBounded && r.memory.buffer.byteLength > MAX_PAGES * PAGE_BYTES) {
        throw new SimulatorError(
          `memory limit: the memory is ${r.memory.buffer.byteLength / PAGE_BYTES} pages, over the limit of ${MAX_PAGES} pages`,
          { rule: "memory limit" },
        );
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.#failed = new SimulatorError(
        `placement ${r.index} (${r.name}) failed in ${name} at tick ${tick}: ${detail}`,
        {
          rule: cause instanceof SimulatorError ? cause.rule : "trap",
          placement: r.index,
          module: r.name,
          export: name,
          tick,
          cause,
        },
      );
      throw this.#failed;
    }
  }

  /** The document's composition: layers in ascending z, integer formula, over black. */
  #compose(): void {
    const { width: pw, height: ph } = this.panel;
    const f = this.frame;
    f.fill(0);
    for (const r of this.#order) {
      const { layer } = r;
      const { x, y, opacity } = r.spec;
      const x0 = Math.max(0, -x);
      const x1 = Math.min(layer.width - 1, pw - 1 - x);
      for (let j = Math.max(0, -y); j <= Math.min(layer.height - 1, ph - 1 - y); j++) {
        for (let i = x0; i <= x1; i++) {
          const s = (j * layer.width + i) * 4;
          const a = Math.floor(((layer.data[s + 3] as number) * opacity + 127) / 255);
          const o = ((y + j) * pw + (x + i)) * 3;
          for (let c = 0; c < 3; c++) {
            f[o + c] = Math.floor(((layer.data[s + c] as number) * a + (f[o + c] as number) * (255 - a) + 127) / 255);
          }
        }
      }
    }
  }
}

const bucket = (t: number, hz: number): bigint => (BigInt(t) * BigInt(hz)) / 60n;

/** Builds a scene: instantiates every placement, gives it a layer of its size and calls `pn_init` in the given order. */
export async function createScene(init: SceneInit): Promise<Scene> {
  const { panel, assets, placements, environment } = init;
  if (!isPositiveInt(panel.width) || !isPositiveInt(panel.height))
    throw new SimulatorError(`scene: the panel ${panel.width} by ${panel.height} is not two positive integers`, {
      rule: "scene",
    });
  for (const a of assets) {
    if (a.bytes.length !== a.width * a.height * 3 * a.frames)
      throw new SimulatorError(
        `scene: asset ${a.name} has ${a.bytes.length} bytes, expected ${a.width} * ${a.height} * 3 * ${a.frames}`,
        { rule: "scene asset" },
      );
  }
  const assetNames = assets.map((asset) => ({ asset, name: encodeUtf8(asset.name) }));
  const runs: Running[] = [];
  let scene: Scene | undefined;
  for (const [index, spec] of placements.entries()) {
    if (!isPositiveInt(spec.width) || !isPositiveInt(spec.height))
      throw new SimulatorError(`scene: placement ${index} has the size ${spec.width} by ${spec.height}`, {
        rule: "scene",
        placement: index,
      });
    const name = spec.name ?? `module ${index}`;
    const layer = new Layer(spec.width, spec.height);
    const config = encodeUtf8(JSON.stringify(spec.config ?? {}));
    const random = environment.random(index);
    const holder = { memory: undefined as unknown as WebAssembly.Memory };
    // Read afresh on every call: growing the memory replaces its buffer.
    const bytes = (ptr: number, len: number): Uint8Array => {
      const p = ptr >>> 0;
      const l = len >>> 0;
      const buf = holder.memory.buffer;
      if (p + l > buf.byteLength)
        throw new SimulatorError(`memory: the range ${p}..${p + l} is outside the ${buf.byteLength} bytes of memory`, {
          rule: "memory",
        });
      return new Uint8Array(buf, p, l);
    };
    const fontOf = (id: number): Font | undefined => (id === 1 ? init.fonts[1] : id === 2 ? init.fonts[2] : undefined);
    const imports = {
      layer_width: () => layer.width,
      layer_height: () => layer.height,
      draw_fill: (c: number) => layer.fill(c),
      draw_pixel: (x: number, y: number, c: number) => layer.pixel(x, y, c),
      draw_line: (x0: number, y0: number, x1: number, y1: number, c: number) => layer.line(x0, y0, x1, y1, c),
      draw_rect: (x: number, y: number, w: number, h: number, c: number, f: number) =>
        layer.rect(x, y, w, h, c, f !== 0),
      draw_circle: (cx: number, cy: number, r: number, c: number, f: number) => layer.circle(cx, cy, r, c, f !== 0),
      draw_text: (font: number, x: number, y: number, ptr: number, len: number, c: number) => {
        const text = bytes(ptr, len);
        const f = fontOf(font);
        return f ? layer.text(f, x, y, decodeUtf8(text), c, true) : -1;
      },
      text_width: (font: number, ptr: number, len: number) => {
        const text = bytes(ptr, len);
        const f = fontOf(font);
        return f ? layer.text(f, 0, 0, decodeUtf8(text), 0, false) : -1;
      },
      font_height: (font: number) => fontOf(font)?.cellHeight ?? -1,
      draw_image: (nptr: number, nlen: number, frame: number, x: number, y: number) => {
        const wanted = bytes(nptr, nlen);
        const found = assetNames.find(
          (a) => a.name.length === wanted.length && a.name.every((b, i) => b === wanted[i]),
        );
        if (!found) return -1;
        const a = found.asset;
        if (frame < 0 || frame >= a.frames) return -2;
        layer.image(a.bytes, frame * a.width * a.height * 3, a.width, a.height, x, y);
        return 0;
      },
      config_len: () => config.length,
      config_read: (ptr: number, cap: number) => {
        if (cap < 0) return 0;
        const dst = bytes(ptr, cap);
        const n = Math.min(cap, config.length);
        dst.set(config.subarray(0, n));
        return n;
      },
      time_unix_ms: () => BigInt.asIntN(64, (scene as Scene).time.unixMs),
      time_utc_offset_s: () => (scene as Scene).time.offsetS,
      random_u32: () => random(),
    };
    let instance: WebAssembly.Instance;
    try {
      instance = await WebAssembly.instantiate(spec.module.module, { [IMPORT_MODULE]: imports });
    } catch (cause) {
      throw new SimulatorError(`placement ${index} (${name}) could not be instantiated: ${String(cause)}`, {
        rule: "instantiate",
        placement: index,
        module: name,
        cause,
      });
    }
    holder.memory = instance.exports.memory as WebAssembly.Memory;
    runs.push({
      index,
      name,
      spec,
      layer,
      memory: holder.memory,
      init: instance.exports.pn_init as () => void,
      update: instance.exports.pn_update as (tick: bigint) => void,
    });
  }
  scene = new Scene(panel, runs, environment);
  scene.init();
  return scene;
}
