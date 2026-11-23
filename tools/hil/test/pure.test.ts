import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBanner, parseStatus } from "../src/lines.ts";
import { acquireLock, LockTimeout, type Clock } from "../src/lock.ts";
import { readLastGood, storeLastGood, cacheDir } from "../src/last-good.ts";
import { findPort } from "../src/port.ts";
import { cutLog, emptyBoard, schemaErrors, type HilResult } from "../src/result.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const tmp = () => mkdtempSync(join(tmpdir(), "hil-"));

describe("lines", () => {
  it("parses the banner", () => {
    expect(parseBanner(`panelator boot sha=${SHA} idf=v5.5.6 flash_mb=16 psram_mb=8 reset=poweron\r`)).toEqual({
      sha: SHA, idf: "v5.5.6", flash_mb: 16, psram_mb: 8, reset: "poweron",
    });
    expect(parseBanner("ESP-ROM:esp32s3-20210327")).toBeNull();
    expect(parseBanner(`panelator boot sha=${SHA} idf=v5.5.6 flash_mb=16 psram_mb=8`)).toBeNull();
  });
  it("parses the status line and tolerates fields added at its end", () => {
    const line = `panelator status sha=${SHA}-dirty uptime_s=15 resets=-1 free_heap=214000 free_psram=8300000`;
    expect(parseStatus(line)).toEqual({ sha: `${SHA}-dirty`, uptime_s: 15, resets: -1, free_heap: 214000, free_psram: 8300000 });
    expect(parseStatus(`${line} temp_c=41`)?.free_psram).toBe(8300000);
    expect(parseStatus("panelator status sha=x")).toBeNull();
  });
});

describe("the result", () => {
  const ok = (): HilResult => ({
    outcome: "pass", kind: "pr", sha: SHA, run_id: 7,
    board: { status: "ok", firmware_sha: SHA, uptime_s: 3, resets: 0, free_heap: 1, free_psram: 2 },
    tests: [{ name: "boot-banner", status: "pass", duration_ms: 12 }], log: "x\n",
  });
  it("validates a result, and a board with null fields", () => {
    expect(schemaErrors(ok())).toBeNull();
    expect(schemaErrors({ ...ok(), outcome: "absent", board: emptyBoard("absent"), reason: "none" })).toBeNull();
  });
  it("rejects extra and missing fields", () => {
    expect(schemaErrors({ ...ok(), extra: 1 })).not.toBeNull();
    const { log: _log, ...rest } = ok();
    expect(schemaErrors(rest)).not.toBeNull();
    expect(schemaErrors({ ...ok(), outcome: "weird" })).not.toBeNull();
  });
  it("cuts the log to the tail, at a line boundary, within 32 KB", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"é".repeat(5)}`).join("\n") + "\n";
    const cut = cutLog(text);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(32768);
    expect(text.endsWith(cut)).toBe(true);
    expect(cut.startsWith("line ")).toBe(true);
    expect(schemaErrors({ ...ok(), log: cut })).toBeNull();
    expect(cutLog("short\n")).toBe("short\n");
    expect(cutLog("a\nb\nc\n", 3)).toBe("c\n");
  });
});

describe("findPort", () => {
  const base = { prefixes: ["usb-Espressif_", "usb-1a86_"], exists: () => true };
  it("uses PANELATOR_HIL_PORT, absent when it does not exist", () => {
    expect(findPort({ ...base, env: { PANELATOR_HIL_PORT: "/dev/ttyX" }, list: () => [] })).toEqual({ found: true, path: "/dev/ttyX" });
    const r = findPort({ ...base, exists: () => false, env: { PANELATOR_HIL_PORT: "/dev/ttyX" }, list: () => [] });
    expect(r.found).toBe(false);
  });
  it("finds the one configured entry and never touches the modem", () => {
    const r = findPort({ ...base, env: {}, list: () => ["usb-FIBOCOM_L850-if00", "usb-1a86_USB_Serial-if00-port0"] });
    expect(r).toEqual({ found: true, path: "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0" });
  });
  it("is absent for none, and for several with the reason naming them", () => {
    expect(findPort({ ...base, env: {}, list: () => ["usb-FIBOCOM_x"] }).found).toBe(false);
    const r = findPort({ ...base, env: {}, list: () => ["usb-1a86_a", "usb-Espressif_b"] });
    expect(r.found).toBe(false);
    if (!r.found) expect(r.reason).toMatch(/usb-1a86_a.*usb-Espressif_b.*PANELATOR_HIL_PORT/);
    expect(findPort({ ...base, env: {}, list: () => { throw new Error("ENOENT"); } }).found).toBe(false);
  });
});

describe("the board lock", () => {
  function fakeClock(): Clock & { t: number } {
    const c = { t: 0, now: () => c.t, sleep: async (ms: number) => { c.t += ms; } };
    return c;
  }
  it("is exclusive, released by its holder, and times out on a live holder", async () => {
    const path = join(tmp(), "board.lock");
    const alive = () => true;
    const release = await acquireLock(path, { timeoutMs: 1000, isAlive: alive, pid: 1, clock: fakeClock() });
    const clock = fakeClock();
    await expect(acquireLock(path, { timeoutMs: 15 * 60_000, isAlive: alive, pid: 2, clock })).rejects.toBeInstanceOf(LockTimeout);
    expect(clock.t).toBeGreaterThanOrEqual(15 * 60_000);
    release();
    expect(existsSync(path)).toBe(false);
    const again = await acquireLock(path, { timeoutMs: 1000, isAlive: alive, pid: 2, clock: fakeClock() });
    again();
  });
  it("takes over from a dead holder and from a lock older than the job timeout", async () => {
    const path = join(tmp(), "board.lock");
    writeFileSync(path, JSON.stringify({ pid: 99, at: 0 }));
    const r1 = await acquireLock(path, { timeoutMs: 1000, isAlive: () => false, pid: 5, clock: fakeClock() });
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(5);
    r1();
    writeFileSync(path, JSON.stringify({ pid: 99, at: 0 }));
    const clock = fakeClock();
    clock.t = 2 * 60 * 60_000;
    (await acquireLock(path, { timeoutMs: 1000, isAlive: () => true, pid: 6, clock }))();
    writeFileSync(path, "not json");
    (await acquireLock(path, { timeoutMs: 1000, isAlive: () => true, pid: 7, clock: fakeClock() }))();
  });
});

describe("the last-good image", () => {
  function build(): string {
    const dir = tmp();
    mkdirSync(join(dir, "bootloader"));
    writeFileSync(join(dir, "bootloader/bootloader.bin"), "b");
    writeFileSync(join(dir, "panelator.bin"), "app");
    writeFileSync(join(dir, "flasher_args.json"), JSON.stringify({
      flash_settings: { flash_mode: "dio", flash_size: "16MB", flash_freq: "80m" },
      flash_files: { "0x0": "bootloader/bootloader.bin", "0x10000": "panelator.bin" },
    }));
    return dir;
  }
  it("is absent before the first store, then stored and replaced whole", () => {
    const cache = tmp();
    expect(readLastGood(cache)).toBeNull();
    storeLastGood(cache, build(), SHA);
    const got = readLastGood(cache);
    expect(got?.commit).toBe(SHA);
    expect(readFileSync(join(got!.dir, "panelator.bin"), "utf8")).toBe("app");
    const second = build();
    writeFileSync(join(second, "panelator.bin"), "app2");
    storeLastGood(cache, second, "f".repeat(40));
    expect(readLastGood(cache)?.commit).toBe("f".repeat(40));
    expect(readFileSync(join(cache, "last-good/panelator.bin"), "utf8")).toBe("app2");
  });
  it("reads the cache from PANELATOR_HIL_CACHE", () => {
    expect(cacheDir({ PANELATOR_HIL_CACHE: "/x" })).toBe("/x");
    expect(cacheDir({})).toMatch(/\.cache\/panelator-hil$/);
  });
});
