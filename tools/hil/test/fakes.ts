import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { Flasher, ToolResult } from "../src/flasher.ts";
import { storeLastGood } from "../src/last-good.ts";
import type { Clock } from "../src/lock.ts";
import { schemaErrors, type HilResult } from "../src/result.ts";
import type { RunDeps } from "../src/run.ts";
import type { Serial, SerialOptions, SerialSession } from "../src/serial.ts";

export const SHA = "a".repeat(40);
export const MAIN_SHA = "b".repeat(40);
export const config = loadConfig();

export class FakeClock implements Clock {
  t = 1_000_000;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms;
  };
}

export const banner = (sha: string, o = { flash: 16, psram: 8 }) =>
  `panelator boot sha=${sha} idf=v5.5.6 flash_mb=${o.flash} psram_mb=${o.psram} reset=ext`;
export const status = (sha: string, up = 5) => `panelator status sha=${sha} uptime_s=${up} resets=0 free_heap=200000 free_psram=8000000`;
export const bootLines = (sha: string) => ["ESP-ROM:esp32s3-20210327", banner(sha), status(sha)];

export class FakeSerial implements Serial {
  opens: { port: string; options: SerialOptions }[] = [];
  private clock: FakeClock;
  private scripts: string[][];
  constructor(clock: FakeClock, scripts: string[][]) {
    this.clock = clock;
    this.scripts = scripts;
  }
  async open(port: string, options: SerialOptions): Promise<SerialSession> {
    this.opens.push({ port, options });
    const lines = [...(this.scripts.shift() ?? [])];
    return {
      nextLine: async (ms) => {
        const l = lines.shift();
        if (l !== undefined) {
          this.clock.t += 50;
          return l;
        }
        this.clock.t += ms;
        return null;
      },
      close: async () => {},
    };
  }
}

export class FakeFlasher implements Flasher {
  calls: string[] = [];
  chip: boolean[] = [];
  flashes: boolean[] = [];
  throwOnFlash = false;
  async chipQuery(): Promise<ToolResult> {
    this.calls.push("chip");
    return { ok: this.chip.shift() ?? true, output: "chip query" };
  }
  async flash(_port: string, dir: string): Promise<ToolResult> {
    this.calls.push(`flash:${dir}`);
    if (this.throwOnFlash) throw new Error("docker exploded");
    return { ok: this.flashes.shift() ?? true, output: "flash output" };
  }
}

export function makeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), "hil-build-"));
  mkdirSync(join(dir, "bootloader"));
  writeFileSync(join(dir, "bootloader/bootloader.bin"), "b");
  writeFileSync(join(dir, "panelator.bin"), "app");
  writeFileSync(
    join(dir, "flasher_args.json"),
    JSON.stringify({
      flash_settings: { flash_mode: "dio", flash_size: "16MB", flash_freq: "80m" },
      flash_files: { "0x0": "bootloader/bootloader.bin", "0x10000": "panelator.bin" },
      extra_esptool_args: { chip: "esp32s3" },
    }),
  );
  return dir;
}

export interface Rig {
  clock: FakeClock;
  flasher: FakeFlasher;
  serial: FakeSerial;
  cache: string;
  deps: RunDeps;
  written: HilResult[];
}

export function rig(scripts: string[][], opts: { ports?: string[]; lastGood?: string } = {}): Rig {
  const clock = new FakeClock();
  const flasher = new FakeFlasher();
  const serial = new FakeSerial(clock, scripts);
  const cache = mkdtempSync(join(tmpdir(), "hil-cache-"));
  if (opts.lastGood) storeLastGood(cache, makeBuild(), opts.lastGood);
  const written: HilResult[] = [];
  const deps: RunDeps = {
    flasher,
    serial,
    clock,
    config,
    cache,
    ports: { env: {}, list: () => opts.ports ?? ["usb-1a86_USB_Serial-if00-port0", "usb-FIBOCOM_L850"], exists: () => true },
    isAlive: () => true,
    writeResult: (r) => {
      const errors = schemaErrors(r);
      if (errors) throw new Error(`invalid: ${errors}`);
      written.push(r);
    },
  };
  return { clock, flasher, serial, cache, deps, written };
}
