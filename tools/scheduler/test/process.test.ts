import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessGroupAlive, scopeArgv, spawnBounded } from "../src/runner/process.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
function eventsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  const p = join(dir, "events.jsonl");
  writeFileSync(p, '{"type":"a"}\n{"type":"b"}\n');
  return p;
}

describe("scopeArgv (AC-30)", () => {
  it("wraps the command in a transient scope with the memory and OOM properties", () => {
    expect(scopeArgv(["claude", "-p", "x"], "panelator-stage-r1")).toEqual([
      "systemd-run", "--user", "--scope", "--quiet", "--unit", "panelator-stage-r1",
      "-p", "MemoryMax=50%", "-p", "OOMPolicy=continue", "-p", "KillMode=control-group", "--", "claude", "-p", "x",
    ]);
  });
});

describe("spawnBounded", () => {
  it("streams stdout and returns the exit code", async () => {
    const chunks: string[] = [];
    const r = await spawnBounded({ argv: [process.execPath, script, eventsFile(), "-", "3"], env: {}, cwd: tmpdir(), timeoutMs: 10_000, onStdoutChunk: (c) => chunks.push(c.toString()) });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(chunks.join("")).toBe('{"type":"a"}\n{"type":"b"}\n');
  });
  it("kills the whole process group on timeout, including a grandchild that ignores SIGTERM (AC-23, review focus 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "proc-"));
    const pidFile = join(dir, "grandchild.pid");
    const r = await spawnBounded({
      argv: [process.execPath, script, eventsFile(), "-", "0", "60000"], env: { SPAWN_GRANDCHILD: "1", GRANDCHILD_PID_FILE: pidFile },
      cwd: dir, timeoutMs: 1_000, graceMs: 500, onStdoutChunk: () => {},
    });
    expect(r.timedOut).toBe(true);
    const gpid = Number(readFileSync(pidFile, "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(gpid, 0)).toThrow();
    expect(isProcessGroupAlive(r.pgid)).toBe(false);
  }, 20_000);
  it("kills when killOnEvent returns true", async () => {
    let seen = 0;
    const r = await spawnBounded({
      argv: [process.execPath, script, eventsFile(), "-", "0", "60000"], env: {}, cwd: tmpdir(), timeoutMs: 30_000, graceMs: 200,
      onStdoutChunk: () => { seen++; }, killOnEvent: () => seen > 0,
    });
    expect(r.killedByEvent).toBe(true);
    expect(r.timedOut).toBe(false);
  }, 20_000);
  it("escalates to SIGKILL after the grace period when the leader ignores SIGTERM", async () => {
    const r = await spawnBounded({
      argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000)"], env: {}, cwd: tmpdir(),
      timeoutMs: 500, graceMs: 400, onStdoutChunk: () => {},
    });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe("SIGKILL");
    expect(isProcessGroupAlive(r.pgid)).toBe(false);
  }, 20_000);
});
