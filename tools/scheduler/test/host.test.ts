import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downtimeBetween, DOWNTIME_KEEP_MS, HostMonitor, PROBE_HOSTS, PROBE_TIMEOUT_MS, probeHost, readHostState, recordDowntime, writeHostState } from "../src/service/host.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const GIB = 2 ** 30;
let root: string;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), "host-")); await ensureStateDirs(statePaths(root)); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const ok = async () => ({ bytes: 20 * GIB, inodes: 1e6 });

describe("probeHost (spec 100 AC-1)", () => {
  it("passes when space is fine and both hosts answer, with HEAD, manual redirect and a timeout signal", async () => {
    const fetch = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 200 }));
    expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: ok })).toBeNull();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(PROBE_HOSTS.map((h) => `https://${h}/`));
    const init = fetch.mock.calls[0][1]!;
    expect(init.method).toBe("HEAD");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(PROBE_TIMEOUT_MS).toBe(10_000);
  });
  it("fails with ENOSPC and makes no request when space is low", async () => {
    const fetch = vi.fn();
    expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: async () => ({ bytes: 100 * 2 ** 20, inodes: 1e6 }) })).toBe("ENOSPC");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("passes when the space cannot be read", async () => {
    const log: unknown[] = [];
    const fetch = async () => new Response(null, { status: 200 });
    expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: async () => { throw new Error("nope"); }, log: (r) => log.push(r) })).toBeNull();
    expect(log.length).toBeGreaterThan(0);
  });
  it("fails with the transient cause of the first host that throws", async () => {
    const fetch = vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo"), { code: "EAI_AGAIN" }) }); });
    expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: ok })).toBe("EAI_AGAIN");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("treats a 403 and a 500 as reached", async () => {
    for (const status of [403, 500]) {
      const fetch = async () => new Response(null, { status });
      expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: ok })).toBeNull();
    }
  });
  it("fails on a TimeoutError", async () => {
    const fetch = async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); };
    expect(await probeHost({ paths: statePaths(root), fetch: fetch as never, freeSpace: ok })).toBe("TimeoutError");
  });
});

const iv = (from: string, to: string, reason: "host" | "sleep" | "stopped" = "host") => ({ from, to, reason });
describe("downtimeBetween (AC-6)", () => {
  const t = (h: number) => new Date(Date.UTC(2026, 10, 1, h)).toISOString();
  it("sums disjoint intervals", () => expect(downtimeBetween([iv(t(1), t(2)), iv(t(3), t(5))], t(0), t(10))).toBe(3 * 3600_000));
  it("counts overlapping and nested intervals once", () => expect(downtimeBetween([iv(t(1), t(4)), iv(t(2), t(5)), iv(t(2), t(3))], t(0), t(10))).toBe(4 * 3600_000));
  it("clips to the window", () => expect(downtimeBetween([iv(t(0), t(6))], t(2), t(4))).toBe(2 * 3600_000));
  it("is zero for no overlap or an empty window", () => {
    expect(downtimeBetween([iv(t(1), t(2))], t(3), t(4))).toBe(0);
    expect(downtimeBetween([iv(t(1), t(2))], t(4), t(3))).toBe(0);
  });
});

describe("host state file", () => {
  it("round-trips, reads a missing file as empty and rejects an invalid one", async () => {
    const paths = statePaths(root);
    expect(await readHostState(paths)).toEqual({ paused: null, last_seen_at: null, downtime: [] });
    const s = { paused: { since: "2026-11-01T00:00:00Z", cause: "EAI_AGAIN", probes: 2, next_probe_at: "2026-11-01T00:05:00Z", notified: false }, last_seen_at: "2026-11-01T00:01:00Z", downtime: [iv("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z", "sleep")] };
    await writeHostState(paths, s);
    expect(await readHostState(paths)).toEqual(s);
    writeFileSync(paths.host, JSON.stringify({ nope: 1 }));
    await expect(readHostState(paths)).rejects.toThrow(/invalid host state/);
  });
  it("recordDowntime appends and drops entries older than 90 days", async () => {
    const paths = statePaths(root);
    const now = Date.parse("2026-11-21T00:00:00Z");
    const old = iv(new Date(now - DOWNTIME_KEEP_MS - 7200_000).toISOString(), new Date(now - DOWNTIME_KEEP_MS - 3600_000).toISOString());
    await writeHostState(paths, { paused: null, last_seen_at: null, downtime: [old] });
    const fresh = iv("2026-11-20T00:00:00Z", "2026-11-20T01:00:00Z", "stopped");
    await recordDowntime(paths, fresh, now);
    expect((await readHostState(paths)).downtime).toEqual([fresh]);
  });
});

describe("HostMonitor", () => {
  const make = (probe: () => Promise<string | null>, clock = { t: Date.parse("2026-11-01T00:00:00Z") }) => {
    const log: Record<string, unknown>[] = [];
    const notes: unknown[] = [];
    const events: unknown[] = [];
    const m = new HostMonitor({ paths: statePaths(root), now: () => new Date(clock.t), write: (r) => log.push(r), notifier: { notify: async (n) => { notes.push(n); } }, emitEvent: async (e, p) => { events.push([e, p]); }, probe });
    return { m, log, notes, events, clock };
  };
  it("keeps the first moment a restart became pending, and the next process records it as restart downtime and clears it (spec 104 AC-1, AC-2)", async () => {
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const { m } = make(async () => null, clock);
    await m.beginTick();
    await m.markRestartPending();
    clock.t += 600_000;
    await m.markRestartPending();
    expect((await readHostState(statePaths(root))).restart_pending_since).toBe("2026-11-01T00:00:00.000Z");
    clock.t += 3600_000;
    const next = make(async () => null, clock);
    await next.m.beginTick();
    await next.m.startupGap(60);
    const s = await readHostState(statePaths(root));
    expect(s.restart_pending_since).toBeUndefined();
    expect(s.downtime).toEqual([{ from: "2026-11-01T00:00:00.000Z", to: "2026-11-01T01:10:00.000Z", reason: "restart" }]);
    expect(next.log).toEqual([{ kind: "downtime", from: "2026-11-01T00:00:00.000Z", to: "2026-11-01T01:10:00.000Z", ms: 4200_000, reason: "restart" }]);
    expect(next.m.downtimeMs("2026-10-31T23:00:00Z", "2026-11-01T02:00:00Z")).toBe(4200_000);
  });
  it("records no restart interval when none was pending", async () => {
    const { m, log } = make(async () => null);
    await m.beginTick();
    await m.startupGap(60);
    expect(log).toEqual([]);
    expect((await readHostState(statePaths(root))).downtime).toEqual([]);
  });
  it("probes at most once per tick", async () => {
    const probe = vi.fn(async () => null);
    const { m } = make(probe);
    await m.beginTick();
    expect(await m.onTransient("EAI_AGAIN", "e")).toBe(false);
    expect(await m.onTransient("EAI_AGAIN", "e")).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await m.beginTick();
    await m.onTransient("EAI_AGAIN", "e");
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("pauses, backs off 60, 120, ... 1800 and resumes with a host interval", async () => {
    let cause: string | null = "EAI_AGAIN";
    const { m, log, clock } = make(async () => cause);
    await m.beginTick();
    expect(await m.onTransient("EAI_AGAIN", "boom")).toBe(true);
    expect(m.paused).toMatchObject({ probes: 1, notified: false, next_probe_at: new Date(clock.t + 60_000).toISOString() });
    expect(log.filter((r) => r.kind === "host-paused")).toHaveLength(1);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      clock.t = Date.parse(m.paused!.next_probe_at);
      expect(await m.probeIfDue()).toBe(false);
      waits.push(Date.parse(m.paused!.next_probe_at) - clock.t);
    }
    expect(waits.map((w) => w / 1000)).toEqual([120, 240, 480, 960, 1800, 1800, 1800, 1800]);
    expect(m.paused!.cause).toBe("EAI_AGAIN");
    cause = null;
    clock.t = Date.parse(m.paused!.next_probe_at);
    expect(await m.probeIfDue()).toBe(true);
    expect(m.paused).toBeNull();
    expect(log.some((r) => r.kind === "host-resumed")).toBe(true);
    expect((await readHostState(statePaths(root))).downtime).toMatchObject([{ reason: "host", from: "2026-11-01T00:00:00.000Z" }]);
  });
  it("notifies once after two hours, and at once for ENOSPC", async () => {
    const a = make(async () => "EAI_AGAIN");
    await a.m.beginTick();
    await a.m.onTransient("EAI_AGAIN", "boom");
    await a.m.noticeIfDue();
    expect(a.notes).toHaveLength(0);
    a.clock.t += 2 * 3600_000;
    await a.m.noticeIfDue();
    await a.m.noticeIfDue();
    expect(a.notes).toMatchObject([{ gate: "infra", issue: 0, label: "host" }]);
    expect(a.events).toMatchObject([["infra_alarm", { kind: "host_outage", cause: "EAI_AGAIN" }]]);
  });
  it("clears its infra notice on the probe that resumes, only then (spec 102 AC-6)", async () => {
    const clears: unknown[] = [];
    let cause: string | null = "EAI_AGAIN";
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const m = new HostMonitor({ paths: statePaths(root), now: () => new Date(clock.t), write: () => {}, notifier: { notify: async () => {}, clear: async (sel) => { clears.push(sel); } }, emitEvent: async () => {}, probe: async () => cause });
    await m.beginTick();
    expect(await m.probeIfDue()).toBe(false);
    await m.onTransient("EAI_AGAIN", "boom");
    clock.t = Date.parse(m.paused!.next_probe_at);
    expect(await m.probeIfDue()).toBe(false);
    expect(clears).toEqual([]);
    cause = null;
    clock.t = Date.parse(m.paused!.next_probe_at);
    expect(await m.probeIfDue()).toBe(true);
    expect(clears).toEqual([{ issue: 0, gate: "infra", label: "host" }]);
  });
  it("logs a clear that rejects and still resumes (spec 102 AC-6)", async () => {
    const log: Record<string, unknown>[] = [];
    let cause: string | null = "EAI_AGAIN";
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const m = new HostMonitor({ paths: statePaths(root), now: () => new Date(clock.t), write: (r) => log.push(r), notifier: { notify: async () => {}, clear: async () => { throw new Error("nope"); } }, emitEvent: async () => {}, probe: async () => cause });
    await m.beginTick();
    await m.onTransient("EAI_AGAIN", "boom");
    cause = null;
    clock.t = Date.parse(m.paused!.next_probe_at);
    expect(await m.probeIfDue()).toBe(true);
    expect(log).toContainEqual({ kind: "error", error: "notify clear: nope" });
    expect(m.paused).toBeNull();
  });
});

describe("a state volume that takes no writes (spec 114 AC-2 to AC-4)", () => {
  const HOUR = 3600_000;
  const spaceErr = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  async function world(opts: { notify?: (n: unknown) => Promise<unknown> } = {}) {
    const { installEnospc } = await import("./helpers/enospc-fs.mjs");
    const clock = { t: Date.parse("2026-11-22T23:00:00Z") };
    const log: Record<string, unknown>[] = [];
    const notes: unknown[] = [];
    const events: [string, Record<string, unknown>][] = [];
    const paths = statePaths(root);
    const probeCause = { v: null as string | null };
    const m = new HostMonitor({
      paths, now: () => new Date(clock.t), write: (r) => log.push(r),
      notifier: { notify: async (n) => { if (opts.notify) await opts.notify(n); notes.push(n); return { channel: "telegram" as const }; } },
      emitEvent: async (e, p) => { await writeHostStateProbe(); events.push([e, p as Record<string, unknown>]); }, probe: async () => probeCause.v,
    });
    const sw = installEnospc(paths.root);
    // The event emitter of the real loop writes under the state root; here it fails the same way.
    async function writeHostStateProbe(): Promise<void> { if (sw.on) throw spaceErr(); }
    return { m, clock, log, notes, events, paths, sw, probeCause } as { probeCause: { v: string | null }; m: HostMonitor; clock: { t: number }; log: Record<string, unknown>[]; notes: unknown[]; events: [string, Record<string, unknown>][]; paths: ReturnType<typeof statePaths>; sw: { on: boolean; restore(): void } };
  }

  it("pauseFor records the pause and the line with the given error and calls no probe", async () => {
    const w = await world();
    w.sw.on = false;
    await w.m.beginTick();
    await w.m.pauseFor("ENOSPC", "state volume under the write floor: /x has 3 MiB free and 9 free inodes (floor 64 MiB, 100 inodes)");
    expect(w.m.paused).toMatchObject({ cause: "ENOSPC", probes: 1, notified: false });
    expect(w.log).toEqual([{ kind: "host-paused", cause: "ENOSPC", error: expect.stringContaining("under the write floor") }]);
    await w.m.pauseFor("ENOSPC", "again");
    expect(w.log).toHaveLength(1);
    w.sw.restore();
  });

  it("holds the pause when host.json cannot be saved, logs once, and writes the whole pause after the resume", async () => {
    const w = await world();
    await w.m.beginTick();
    expect(await w.m.onTransient("ENOSPC", "x")).toBe(false); // the probe passes: no pause
    await w.m.beginTick(); // the probe result is memoised within a tick
    w.probeCause.v = "ENOSPC";
    expect(await w.m.onTransient("ENOSPC", "full")).toBe(true); // host.json cannot be saved; the pause holds
    expect(w.log.filter((r) => r.kind === "host-paused")).toHaveLength(1);
    w.probeCause.v = null;
    expect(w.m.paused?.cause).toBe("ENOSPC");
    for (let i = 0; i < 5; i++) await w.m.markSeen();
    expect(w.log.filter((r) => String(r.error).startsWith("host state:"))).toHaveLength(1);
    w.sw.on = false;
    w.clock.t += 2 * HOUR;
    // The probe passes (null): the pause ends and the file gets the whole state.
    expect(await w.m.probeIfDue()).toBe(true);
    const s = await readHostState(w.paths);
    expect(s.paused).toBeNull();
    expect(s.downtime).toHaveLength(1);
    expect(s.downtime[0]).toMatchObject({ from: "2026-11-22T23:00:00.000Z", reason: "host" });
    w.sw.restore();
  });

  it("a save failing with another error rejects", async () => {
    const w = await world();
    w.sw.on = false;
    await w.m.beginTick();
    w.sw.restore();
    rmSync(join(root, "host.json"), { force: true });
    writeFileSync(join(root, "host.json.tmp"), "");
    const bad = new HostMonitor({ paths: { ...w.paths, host: join(root, "no-such-dir-file", "x", "host.json") }, now: () => new Date(), write: () => {}, notifier: { notify: async () => {} }, probe: async () => null });
    writeFileSync(join(root, "no-such-dir-file"), "a file, not a directory");
    await bad.beginTick();
    await expect(bad.markSeen()).rejects.toThrow();
  });

  it("the notice sends first and each part stands alone: one message, nothing appended, then one finding and one alarm", async () => {
    const w = await world();
    await w.m.beginTick();
    await w.m.pauseFor("ENOSPC", "full");
    w.clock.t += 1000;
    await w.m.noticeIfDue();
    for (let i = 0; i < 10; i++) { w.clock.t += 1000; await w.m.noticeIfDue(); }
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toMatchObject({ label: "host", gate: "infra" });
    expect(w.m.paused?.notified).toBe(true);
    const due = "2026-11-22T23:00:01.000Z";
    w.sw.on = false;
    w.clock.t += 1000;
    await w.m.noticeIfDue();
    await w.m.noticeIfDue();
    const { readFileSync } = await import("node:fs");
    const findings = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ finding: { stops_pipeline: true }, timestamp: due });
    expect(w.events.filter(([e, p]) => e === "infra_alarm" && p.kind === "disk_full")).toHaveLength(1);
    expect(w.log.filter((r) => r.kind === "host-paused-notice")).toHaveLength(1);
    w.sw.restore();
  });

  it("a notification that rejects with a space failure is sent again on the next call and notified stays false between", async () => {
    let fail = true;
    const w = await world({ notify: async () => { if (fail) { fail = false; throw spaceErr(); } } });
    w.sw.on = false;
    await w.m.beginTick();
    await w.m.pauseFor("ENOSPC", "full");
    await w.m.noticeIfDue();
    expect(w.notes).toHaveLength(0);
    expect(w.m.paused?.notified).toBe(false);
    await w.m.noticeIfDue();
    expect(w.notes).toHaveLength(1);
    expect(w.m.paused?.notified).toBe(true);
    w.sw.restore();
  });

  it("a part failing with another error is logged and not retried while the later parts happen", async () => {
    const w = await world();
    w.sw.on = false;
    writeFileSync(join(root, "blocker"), "x");
    const broken = { ...w.paths, findingsQueue: join(root, "blocker", "findings.jsonl") };
    let calls = 0;
    const m2 = new HostMonitor({ paths: broken, now: () => new Date(w.clock.t), write: (r) => w.log.push(r), notifier: { notify: async () => { calls++; return { channel: "telegram" as const }; } }, emitEvent: async (e) => { w.events.push([e, {}]); }, probe: async () => null });
    await m2.beginTick();
    await m2.pauseFor("ENOSPC", "full");
    await m2.noticeIfDue();
    await m2.noticeIfDue();
    expect(calls).toBe(1);
    expect(w.log.filter((r) => String(r.error).startsWith("host notice finding:"))).toHaveLength(1);
    expect(w.events.filter(([e]) => e === "infra_alarm")).toHaveLength(1);
    w.sw.restore();
  });
});
