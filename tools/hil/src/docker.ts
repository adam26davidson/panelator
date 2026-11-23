// The real flasher and serial source (spec 106 AC-17): esptool and a pyserial reader run from the pinned image
// with `docker run --rm --device <port>`. The harness opens no device node itself.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { readFlasherArgs, type FlasherArgs } from "./flasher-args.ts";
import type { Flasher, ToolResult } from "./flasher.ts";
import type { Serial, SerialOptions, SerialSession } from "./serial.ts";

const root = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const READER = resolve(dirname(new URL(import.meta.url).pathname), "reader.py");

/** The image of firmware/idf-image.txt, the one place it is named. */
export function imageName(file = join(root, "firmware", "idf-image.txt")): string {
  return readFileSync(file, "utf8").trim();
}

const BAUD = "460800";

export function chipQueryArgs(image: string, device: string): string[] {
  return ["run", "--rm", "--device", device, image, "esptool.py", "--port", device, "--before", "default_reset", "--after", "no_reset", "chip_id"];
}

export function flashArgs(image: string, device: string, dir: string, args: FlasherArgs): string[] {
  const s = args.flash_settings;
  const files = Object.entries(args.flash_files).sort((a, b) => Number(a[0]) - Number(b[0]));
  return [
    "run", "--rm", "--device", device, "-v", `${resolve(dir)}:/img:ro`, "-w", "/img", image,
    "esptool.py", "--chip", args.extra_esptool_args?.chip ?? "esp32s3", "--port", device, "--baud", BAUD,
    "--before", "default_reset", "--after", "no_reset",
    "write_flash", "--flash_mode", s.flash_mode, "--flash_size", s.flash_size, "--flash_freq", s.flash_freq,
    ...files.flatMap(([offset, file]) => [offset, file]),
  ];
}

export function readerArgs(image: string, device: string, name: string, options: SerialOptions, maxSeconds: number): string[] {
  return [
    "run", "--rm", "-i", "--name", name, "--device", device, "-v", `${READER}:/reader.py:ro`, image,
    "python3", "/reader.py", device, options.reset ? "reset" : "passive", String(maxSeconds),
  ];
}

export type Exec = (args: string[], timeoutMs: number) => Promise<{ code: number | null; output: string }>;

export const dockerExec: Exec = (args, timeoutMs) =>
  new Promise((done) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, output: `${output}\n${e.message}` });
    });
  });

/** The device node behind a /dev/serial/by-id symlink, which is what `--device` needs. */
const deviceOf = (port: string): string => realpathSync(port);

export function dockerFlasher(image: string, exec: Exec = dockerExec, resolveDevice: (p: string) => string = deviceOf, timeoutS = { query: 60, flash: 300 }): Flasher {
  return {
    async chipQuery(port) {
      const r = await exec(chipQueryArgs(image, resolveDevice(port)), timeoutS.query * 1000);
      return { ok: r.code === 0, output: r.output } satisfies ToolResult;
    },
    async flash(port, dir) {
      const r = await exec(flashArgs(image, resolveDevice(port), dir, readFlasherArgs(dir)), timeoutS.flash * 1000);
      return { ok: r.code === 0, output: r.output } satisfies ToolResult;
    },
  };
}

export function dockerSerial(image: string, resolveDevice: (p: string) => string = deviceOf, maxSeconds = 180): Serial {
  return {
    async open(port, options): Promise<SerialSession> {
      const name = `panelator-hil-reader-${process.pid}-${Date.now()}`;
      const child = spawn("docker", readerArgs(image, resolveDevice(port), name, options, maxSeconds), { stdio: ["pipe", "pipe", "pipe"] });
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | undefined;
      const poke = (): void => wake?.();
      createInterface({ input: child.stdout }).on("line", (l) => {
        queue.push(l);
        poke();
      });
      child.stderr.on("data", (d: Buffer) => queue.push(`reader: ${d.toString().trim()}`));
      child.on("close", () => {
        ended = true;
        poke();
      });
      child.on("error", () => {
        ended = true;
        poke();
      });
      return {
        async nextLine(timeoutMs) {
          const deadline = Date.now() + timeoutMs;
          while (queue.length === 0) {
            const left = deadline - Date.now();
            if (ended || left <= 0) return null;
            await new Promise<void>((r) => {
              const t = setTimeout(r, left);
              wake = () => {
                clearTimeout(t);
                r();
              };
            });
          }
          return queue.shift() ?? null;
        },
        async close() {
          child.kill("SIGKILL");
          spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
        },
      };
    },
  };
}

export function dockerHardware(_env: Record<string, string | undefined>): { flasher: Flasher; serial: Serial } {
  const image = imageName();
  return { flasher: dockerFlasher(image), serial: dockerSerial(image) };
}
