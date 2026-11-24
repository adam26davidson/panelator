import { describe, expect, it } from "vitest";
import { startFailureExit, unhandledRejectionHandler, waitForStateSpace } from "../src/service/start-gate.ts";
import type { FreeSpace } from "../src/runner/host-space.ts";

const MIB = 2 ** 20;
const full: FreeSpace = { bytes: 10 * MIB, inodes: 500 };
const room: FreeSpace = { bytes: 20 * 2 ** 30, inodes: 1e6 };

function gate(reads: (FreeSpace | Error)[], opts: { send?: (t: string) => Promise<void>; signal?: AbortSignal } = {}) {
  const clock = { t: Date.parse("2026-11-22T23:00:00Z") };
  const sleeps: number[] = [];
  const err: string[] = [];
  const reads_ = [...reads];
  const run = () => waitForStateSpace({
    root: "/state", now: () => clock.t, stderr: (l) => err.push(l), send: opts.send, signal: opts.signal,
    freeSpace: async () => { const r = reads_.shift() ?? room; if (r instanceof Error) throw r; return r; },
    sleep: async (ms, signal) => { if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" }); sleeps.push(ms / 1000); clock.t += ms; },
  });
  return { run, sleeps, err };
}

describe("waitForStateSpace (spec 114 AC-6)", () => {
  it("returns null at once, writing and sending nothing, when there is room", async () => {
    const sent: string[] = [];
    const g = gate([room], { send: async (t) => { sent.push(t); } });
    expect(await g.run()).toBeNull();
    expect(sent).toEqual([]);
    expect(g.err).toEqual([]);
    expect(g.sleeps).toEqual([]);
  });

  it("full for three reads then room: one stderr line, one message, the returned record, backed-off reads", async () => {
    const sent: string[] = [];
    const g = gate([full, full, full, room], { send: async (t) => { sent.push(t); } });
    const r = await g.run();
    expect(g.err).toEqual(["panelator-scheduler: state volume full, waiting to start: /state has 10 MiB free and 500 free inodes"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("cannot start");
    expect(sent[0]).toContain("/state");
    expect(sent[0]).toContain("10 MiB");
    expect(sent[0]).toContain("starts by itself");
    expect(g.sleeps).toEqual([60, 120, 240]);
    expect(r).toEqual({ since: "2026-11-22T23:00:00.000Z", waited_ms: 420_000, free_bytes: 10 * MIB, free_inodes: 500 });
  });

  it("a send that fails twice then succeeds delivers one message and never writes the token", async () => {
    let calls = 0;
    const sent: string[] = [];
    const g = gate([full, full, full, full, room], { send: async (t) => { if (++calls <= 2) throw new Error("Telegram sendMessage failed"); sent.push(t); } });
    await g.run();
    expect(sent).toHaveLength(1);
    expect(calls).toBe(3);
    expect(g.err.filter((l) => l.includes("not sent"))).toHaveLength(2);
    expect(g.err.join("\n")).not.toMatch(/bot\d|token/i);
  });

  it("returns null when the read throws, and counts a failing re-read as room", async () => {
    expect(await gate([new Error("statfs")]).run()).toBeNull();
    const g = gate([full, new Error("statfs")]);
    expect(await g.run()).toMatchObject({ free_bytes: 10 * MIB });
  });

  it("keeps waiting while the volume is above the write floor but under the launch floors", async () => {
    const g = gate([full, { bytes: 100 * MIB, inodes: 1e6 }, room]);
    await g.run();
    expect(g.sleeps).toEqual([60, 120]);
  });

  it("the stop signal ends the wait", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(gate([full], { signal: ac.signal }).run()).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("start failure helpers (spec 114 AC-7)", () => {
  const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  it("maps a space failure to exit 75 and its line, anything else to null", () => {
    expect(startFailureExit(enospc)).toEqual({ code: 75, line: "panelator-scheduler: state volume full during start: ENOSPC: no space left on device, write" });
    expect(startFailureExit(new Error("boom"))).toBeNull();
  });
  it("the unhandledRejection handler logs a space failure and rethrows any other reason", () => {
    const log: Record<string, unknown>[] = [];
    const h = unhandledRejectionHandler((r) => log.push(r));
    h(enospc);
    expect(log).toEqual([{ kind: "error", error: "unhandled: ENOSPC: no space left on device, write" }]);
    expect(() => h(new Error("boom"))).toThrow("boom");
  });
});
