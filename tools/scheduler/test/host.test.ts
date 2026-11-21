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
  it("clears the host notice on resume but keeps a queued one (spec 102 AC-6)", async () => {
    const clears: unknown[] = [];
    let cause: string | null = "EAI_AGAIN";
    const clock = { t: Date.parse("2026-11-01T00:00:00Z") };
    const m = new HostMonitor({ paths: statePaths(root), now: () => new Date(clock.t), write: () => {}, notifier: { notify: async () => {}, clear: async (sel) => { clears.push(sel); } }, emitEvent: async () => {}, probe: async () => cause });
    await m.beginTick();
    await m.onTransient("EAI_AGAIN", "boom");
    expect(clears).toEqual([]);
    cause = null;
    clock.t = Date.parse(m.paused!.next_probe_at);
    expect(await m.probeIfDue()).toBe(true);
    expect(clears).toEqual([{ issue: 0, gate: "infra", label: "host", keepQueued: true }]);
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
});
