import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLastGood } from "../src/last-good.ts";
import { deriveKind, runHil, type RunInput } from "../src/run.ts";
import { banner, bootLines, makeBuild, MAIN_SHA, rig, SHA, status } from "./fakes.ts";

const input = (over: Partial<RunInput> = {}): RunInput => ({ kind: "pr", sha: SHA, runId: 9, buildDir: makeBuild(), ...over });
const BOARD = "/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0";

describe("a flashing run (AC-12)", () => {
  it("is absent when no board is found, flashing nothing", async () => {
    const r = rig([], { ports: ["usb-FIBOCOM_L850"] });
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "absent", board: { status: "absent" } });
    expect(res.reason).toMatch(/looked for/);
    expect(r.flasher.calls).toEqual([]);
    expect(r.serial.opens).toEqual([]);
  });

  it("is bricked when download mode cannot be entered twice", async () => {
    const r = rig([]);
    r.flasher.chip = [false, false];
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "bricked", board: { status: "bricked" }, reason: "download mode could not be entered" });
    expect(r.flasher.calls).toEqual(["chip", "chip"]);
  });

  it("tries download mode a second time before declaring it", async () => {
    const r = rig([bootLines(SHA)]);
    r.flasher.chip = [false, true];
    expect((await runHil(input(), r.deps)).outcome).toBe("pass");
  });

  it("passes on a pr, with no last-good image and so no flash back; the board holds the last status line", async () => {
    const r = rig([bootLines(SHA)]);
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({
      outcome: "pass", kind: "pr", sha: SHA, run_id: 9,
      board: { status: "ok", firmware_sha: SHA, uptime_s: 5, resets: 0, free_heap: 200000, free_psram: 8000000 },
      tests: [{ name: "boot-banner", status: "pass" }],
    });
    expect(r.flasher.calls.filter((c) => c.startsWith("flash"))).toHaveLength(1);
    expect(r.serial.opens[0]).toEqual({ port: BOARD, options: { reset: true } });
    expect(res.log).toContain("ESP-ROM:esp32s3-20210327");
    expect(readLastGood(r.cache)).toBeNull();
    expect(r.written).toHaveLength(1);
  });

  it("stores the last-good image on a passing main run only", async () => {
    const r = rig([bootLines(SHA)]);
    await runHil(input({ kind: "main" }), r.deps);
    expect(readLastGood(r.cache)?.commit).toBe(SHA);
    const p = rig([bootLines(SHA)]);
    await runHil(input({ kind: "pr" }), p.deps);
    expect(readLastGood(p.cache)).toBeNull();
  });

  it("flashes the last-good image back after a pr run and reads the board after it", async () => {
    const r = rig([bootLines(SHA), [banner(MAIN_SHA), status(MAIN_SHA, 11)]], { lastGood: MAIN_SHA });
    const res = await runHil(input(), r.deps);
    expect(res.outcome).toBe("pass");
    expect(r.flasher.calls).toEqual(["chip", expect.stringMatching(/^flash:.*hil-build/), expect.stringMatching(/^flash:.*last-good$/)]);
    expect(res.board).toMatchObject({ status: "ok", firmware_sha: MAIN_SHA, uptime_s: 11 });
  });

  it("is bricked when the flash back gives no banner", async () => {
    const r = rig([bootLines(SHA), []], { lastGood: MAIN_SHA });
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "bricked", board: { status: "bricked" } });
  });

  it("fails a failed test on a booted board, and a failed main run puts the old last-good back", async () => {
    const r = rig([[banner(SHA, { flash: 4, psram: 8 }), status(SHA)], [banner(MAIN_SHA), status(MAIN_SHA)]], { lastGood: MAIN_SHA });
    const res = await runHil(input({ kind: "main" }), r.deps);
    expect(res.outcome).toBe("fail");
    expect(res.tests[0]).toMatchObject({ name: "boot-banner", status: "fail" });
    expect(res.tests[0]!.message).toContain("flash_mb 4");
    expect(readLastGood(r.cache)?.commit).toBe(MAIN_SHA);
    expect(res.board.firmware_sha).toBe(MAIN_SHA);
  });

  it("restores the last-good image when the image under test gives no banner: fail, board ok", async () => {
    const r = rig([[], [banner(MAIN_SHA), status(MAIN_SHA)]], { lastGood: MAIN_SHA });
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "fail", board: { status: "ok", firmware_sha: MAIN_SHA } });
    expect(res.tests[0]!.message).toMatch(/did not boot.*restored/);
    expect(res.tests[0]!.message).toContain(MAIN_SHA);
  });

  it("is bricked when the restore does not boot either, or its flash fails", async () => {
    const a = rig([[], []], { lastGood: MAIN_SHA });
    expect((await runHil(input(), a.deps)).outcome).toBe("bricked");
    const b = rig([[]], { lastGood: MAIN_SHA });
    b.flasher.flashes = [true, false];
    const res = await runHil(input(), b.deps);
    expect(res).toMatchObject({ outcome: "bricked", board: { status: "bricked" } });
  });

  it("with no last-good image: fail when download mode answers, bricked when it does not", async () => {
    const a = rig([[]]);
    const res = await runHil(input(), a.deps);
    expect(res).toMatchObject({ outcome: "fail", board: { status: "ok", firmware_sha: SHA } });
    expect(res.tests[0]!.message).toMatch(/no last-good image exists yet/);
    const b = rig([[]]);
    b.flasher.chip = [true, false];
    const res2 = await runHil(input(), b.deps);
    expect(res2.outcome).toBe("bricked");
  });

  it("treats a failed flash of the image under test as not booting", async () => {
    const r = rig([[banner(MAIN_SHA), status(MAIN_SHA)]], { lastGood: MAIN_SHA });
    r.flasher.flashes = [false];
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "fail", board: { firmware_sha: MAIN_SHA } });
  });

  it("counts a test that throws as a failed test, not a failed harness", async () => {
    const r = rig([bootLines(SHA)]);
    r.deps.tests = [{ name: "boom", run: async () => { throw new Error("kaboom"); } }, { name: "later", run: async () => ({ status: "skip" }) }];
    const res = await runHil(input(), r.deps);
    expect(res.outcome).toBe("fail");
    expect(res.tests.map((t) => [t.name, t.status])).toEqual([["boom", "fail"], ["later", "skip"]]);
    expect(res.tests[0]!.message).toContain("kaboom");
  });

  it("passes when every test passed or was skipped", async () => {
    const r = rig([bootLines(SHA)]);
    r.deps.tests = [{ name: "a", run: async () => ({ status: "pass" }) }, { name: "b", run: async () => ({ status: "skip" }) }];
    expect((await runHil(input(), r.deps)).outcome).toBe("pass");
  });
});

describe("a soak run (AC-15)", () => {
  it("reads a status line without flashing, resetting or querying", async () => {
    const r = rig([[status(MAIN_SHA, 700)]]);
    const res = await runHil(input({ kind: "soak", buildDir: null }), r.deps);
    expect(res).toMatchObject({ outcome: "pass", kind: "soak", board: { status: "ok", firmware_sha: MAIN_SHA, uptime_s: 700 } });
    expect(res.tests).toMatchObject([{ name: "status-line", status: "pass" }]);
    expect(r.flasher.calls).toEqual([]);
    expect(r.serial.opens).toEqual([{ port: BOARD, options: { reset: false } }]);
  });
  it("fails, board ok, other fields null, without a status line in 20 s; never bricked", async () => {
    const r = rig([["noise"]]);
    const res = await runHil(input({ kind: "soak", buildDir: null }), r.deps);
    expect(res).toMatchObject({ outcome: "fail", board: { status: "ok", firmware_sha: null, uptime_s: null, resets: null } });
    expect(res.tests).toMatchObject([{ name: "status-line", status: "fail" }]);
    expect(r.flasher.calls).toEqual([]);
  });
  it("is absent without a board", async () => {
    const r = rig([], { ports: [] });
    const res = await runHil(input({ kind: "soak", buildDir: null }), r.deps);
    expect(res.outcome).toBe("absent");
    expect(r.flasher.calls).toEqual([]);
  });
});

describe("the other results", () => {
  it("a failed build reads the board like a soak run and posts one failed test naming the run", async () => {
    const r = rig([[status(MAIN_SHA)]]);
    const res = await runHil(input({ buildDir: null, buildFailed: { runUrl: "https://github.com/o/r/actions/runs/9" } }), r.deps);
    expect(res).toMatchObject({ outcome: "fail", board: { status: "ok", firmware_sha: MAIN_SHA } });
    expect(res.tests).toHaveLength(1);
    expect(res.tests[0]).toMatchObject({ name: "build", status: "fail" });
    expect(res.tests[0]!.message).toContain("https://github.com/o/r/actions/runs/9");
    expect(r.flasher.calls).toEqual([]);
  });

  it("an error mid-run becomes a failed 'harness' test with the board read so far", async () => {
    const r = rig([bootLines(SHA)]);
    r.flasher.throwOnFlash = true;
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "fail", tests: [{ name: "harness", status: "fail", message: "docker exploded" }] });
  });

  it("fails with 'board-lock' when the lock is not free in 15 minutes, flashing nothing", async () => {
    const r = rig([bootLines(SHA)]);
    writeFileSync(join(r.cache, "board.lock"), JSON.stringify({ pid: 1, at: r.clock.t }));
    const res = await runHil(input(), r.deps);
    expect(res).toMatchObject({ outcome: "fail", tests: [{ name: "board-lock", status: "fail" }] });
    expect(r.clock.t).toBeGreaterThanOrEqual(1_000_000 + 15 * 60_000);
    expect(r.flasher.calls).toEqual([]);
    expect(r.serial.opens).toEqual([]);
  });

  it("holds the lock until the result is written, then releases it", async () => {
    const r = rig([bootLines(SHA)]);
    let heldWhileWriting = false;
    const write = r.deps.writeResult;
    r.deps.writeResult = (x) => {
      heldWhileWriting = require_exists(join(r.cache, "board.lock"));
      write(x);
    };
    await runHil(input(), r.deps);
    expect(heldWhileWriting).toBe(true);
    expect(require_exists(join(r.cache, "board.lock"))).toBe(false);
  });

  it("derives the kind from the event, the ref and the soak input", () => {
    expect(deriveKind("pull_request", "refs/pull/1/merge", false)).toBe("pr");
    expect(deriveKind("push", "refs/heads/main", false)).toBe("main");
    expect(deriveKind("schedule", "refs/heads/main", false)).toBe("soak");
    expect(deriveKind("workflow_dispatch", "refs/heads/main", true)).toBe("soak");
    expect(deriveKind("workflow_dispatch", "refs/heads/main", false)).toBe("main");
    expect(deriveKind("workflow_dispatch", "refs/heads/issue-428", false)).toBe("pr");
  });

  it("cuts a huge log to 32 KB and still validates", async () => {
    const r = rig([[...Array.from({ length: 400 }, (_, i) => `noise line number ${i} ${"x".repeat(250)}`), ...bootLines(SHA)]]);
    const res = await runHil(input(), r.deps);
    expect(Buffer.byteLength(res.log)).toBeLessThanOrEqual(32768);
    expect(res.log).toContain(status(SHA));
  });
});

import { existsSync } from "node:fs";
function require_exists(p: string): boolean {
  return existsSync(p);
}
void mkdtempSync;
void tmpdir;
