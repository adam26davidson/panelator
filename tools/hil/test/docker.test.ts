import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chipQueryArgs, dockerFlasher, flashArgs, imageName, readerArgs, type Exec } from "../src/docker.ts";
import { makeBuild } from "./fakes.ts";
import { readFlasherArgs } from "../src/flasher-args.ts";

const IMAGE = "example/image:1@sha256:" + "0".repeat(64);

describe("the docker commands (AC-17)", () => {
  it("queries the chip with esptool in the image, on the resolved device", () => {
    const a = chipQueryArgs(IMAGE, "/dev/ttyUSB0");
    expect(a.slice(0, 5)).toEqual(["run", "--rm", "--device", "/dev/ttyUSB0", IMAGE]);
    expect(a).toContain("chip_id");
    expect(a).toContain("no_reset");
  });
  it("flashes the offsets and files of flasher_args.json, in offset order, with its flash settings", () => {
    const dir = makeBuild();
    const a = flashArgs(IMAGE, "/dev/ttyUSB0", dir, readFlasherArgs(dir));
    expect(a).toContain(`${dir}:/img:ro`);
    const i = a.indexOf("write_flash");
    expect(a.slice(i)).toEqual(["write_flash", "--flash_mode", "dio", "--flash_size", "16MB", "--flash_freq", "80m", "0x0", "bootloader/bootloader.bin", "0x10000", "panelator.bin"]);
    expect(a[a.indexOf("--chip") + 1]).toBe("esp32s3");
    expect(a[a.indexOf("--after") + 1]).toBe("no_reset");
  });
  it("starts the reader passive (no reset) or with a reset", () => {
    const passive = readerArgs(IMAGE, "/dev/ttyUSB0", "n", { reset: false }, 30);
    const reset = readerArgs(IMAGE, "/dev/ttyUSB0", "n", { reset: true }, 30);
    expect(passive.slice(-4)).toEqual(["/reader.py", "/dev/ttyUSB0", "passive", "30"]);
    expect(reset.slice(-2)[0]).toBe("reset");
    expect(passive.join(" ")).toContain("reader.py:/reader.py:ro");
  });
  it("maps exit codes and output to the flasher interface, resolving the by-id link first", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (args) => {
      seen.push(args);
      return args.includes("chip_id") ? { code: 2, output: "no answer" } : { code: 0, output: "Hash of data verified." };
    };
    const f = dockerFlasher(IMAGE, exec, () => "/dev/ttyUSB0");
    expect(await f.chipQuery("/dev/serial/by-id/x")).toEqual({ ok: false, output: "no answer" });
    expect(await f.flash("/dev/serial/by-id/x", makeBuild())).toEqual({ ok: true, output: "Hash of data verified." });
    expect(seen.every((a) => a[3] === "/dev/ttyUSB0")).toBe(true);
    const killed = dockerFlasher(IMAGE, async () => ({ code: null, output: "killed" }), () => "/dev/ttyUSB0");
    expect((await killed.chipQuery("p")).ok).toBe(false);
  });
  it("names the image only from firmware/idf-image.txt", () => {
    const file = join(mkdtempSync(join(tmpdir(), "img-")), "idf-image.txt");
    writeFileSync(file, `${IMAGE}\n`);
    expect(imageName(file)).toBe(IMAGE);
    expect(imageName()).toMatch(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
  });
});
