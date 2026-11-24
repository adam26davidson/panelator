import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { notifierChain } from "../src/notify/chain.ts";
import { probeHost, readHostState } from "../src/service/host.ts";
import { ServiceLog } from "../src/service/log.ts";
import { Scheduler } from "../src/service/loop.ts";
import type { FreeSpace } from "../src/runner/host-space.ts";
import { installEnospc } from "./helpers/enospc-fs.mjs";
import { fakeChannel } from "./helpers/fake-channel.ts";
import { outageSetup, serviceRecords } from "./helpers/loop-harness.ts";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
const records = (paths: { serviceLog: string }, kind: string) => serviceRecords(paths).filter((r) => r.kind === kind);

async function world(rootSpace: { v: FreeSpace }) {
  const t = await outageSetup(async (_d, c) => c);
  t.allowErrors(/./);
  t.deps.freeSpace = async (p) => (p === t.paths.root ? rootSpace.v : { bytes: 20 * GIB, inodes: 1_000_000 });
  const probe = vi.fn(async () => probeHost({ paths: t.paths, freeSpace: t.deps.freeSpace, fetch: (async () => new Response(null, { status: 200 })) as never }));
  t.deps.probeHost = probe;
  // The monitor was built with the harness's notifier and probe: build the scheduler again over the changed deps.
  t.deps.host = undefined;
  const s = new Scheduler(t.deps, { driveChain: async (_d, c) => c });
  return { ...t, s, probe };
}

describe("a state volume under the write floor (spec 114 AC-2)", () => {
  it("pauses with the exact error, calls no probe and writes nothing of the tick's usual state", async () => {
    const space = { v: { bytes: 10 * MIB, inodes: 50 } };
    const t = await world(space);
    const claimBefore = readFileSync(`${t.paths.claims}/7.json`, "utf8");
    await t.s.tick();
    const paused = records(t.paths, "host-paused");
    expect(paused).toEqual([expect.objectContaining({ cause: "ENOSPC", error: `state volume under the write floor: ${t.paths.root} has 10 MiB free and 50 free inodes (floor 64 MiB, 100 inodes)` })]);
    expect(t.probe).not.toHaveBeenCalled();
    expect(existsSync(t.paths.eventsBackfilled)).toBe(false);
    expect(existsSync(`${t.paths.parameters}.lock`)).toBe(false);
    expect(readFileSync(`${t.paths.claims}/7.json`, "utf8")).toBe(claimBefore);
    expect(serviceRecords(t.paths).find((r) => r.kind === "tick")).toMatchObject({ host: { cause: "ENOSPC" } });
    // Still under the floor on the next tick: the same early return, no second pause record.
    t.advance(10);
    await t.s.tick();
    expect(records(t.paths, "host-paused")).toHaveLength(1);
    expect(t.probe).not.toHaveBeenCalled();
  }, 60_000);

  it("a first tick under the write floor still records the stopped interval (spec 100 AC-6)", async () => {
    const space = { v: { bytes: 10 * MIB, inodes: 50 } };
    const t = await world(space);
    const now = t.deps.now().getTime();
    writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: new Date(now - 5 * 3600_000).toISOString(), downtime: [] }));
    await t.s.tick();
    expect(records(t.paths, "downtime")).toEqual([expect.objectContaining({ reason: "stopped", ms: 5 * 3600_000 })]);
    space.v = { bytes: 30 * GIB, inodes: 1_000_000 };
    t.advance(120);
    await t.s.tick();
    const st = await readHostState(t.paths);
    expect(st.downtime.filter((d) => d.reason === "stopped")).toHaveLength(1);
  }, 60_000);

  it("logs host-space-unknown and goes on when the read fails", async () => {
    const t = await outageSetup(async (_d, c) => c);
    t.deps.freeSpace = async (p) => { if (p === t.paths.root) throw new Error("statfs failed"); return { bytes: 20 * GIB, inodes: 1_000_000 }; };
    await t.s.tick();
    expect(records(t.paths, "host-space-unknown").some((r) => r.path === t.paths.root)).toBe(true);
    expect(records(t.paths, "host-paused")).toHaveLength(0);
  }, 60_000);

  it("100 MiB free runs as today; a volume back above 64 MiB and under 512 MiB stays paused through a due probe", async () => {
    const space = { v: { bytes: 100 * MIB, inodes: 1_000_000 } };
    const t = await world(space);
    await t.s.tick();
    expect(records(t.paths, "host-paused")).toHaveLength(0);
    space.v = { bytes: 10 * MIB, inodes: 1_000_000 };
    t.advance(10);
    await t.s.tick();
    expect(records(t.paths, "host-paused")).toHaveLength(1);
    space.v = { bytes: 100 * MIB, inodes: 1_000_000 };
    t.advance(120);
    await t.s.tick();
    expect(t.probe).toHaveBeenCalled();
    expect(records(t.paths, "host-resumed")).toHaveLength(0);
    expect((await readHostState(t.paths)).paused).toMatchObject({ cause: "ENOSPC" });
  }, 60_000);
});

describe("the outage of 2026-11-22 (spec 114 AC-4, AC-9)", () => {
  async function outage(failFirstSend: boolean) {
    const space = { v: { bytes: 20 * GIB, inodes: 1_000_000 } as FreeSpace };
    const t = await world(space);
    const ch = fakeChannel();
    const sw = installEnospc(t.paths.root);
    sw.on = false;
    t.deps.serviceLog = new ServiceLog(t.paths.serviceLog);
    t.deps.notifier = notifierChain({ paths: t.paths, telegram: () => ch, now: () => t.deps.now(), log: (r) => t.deps.serviceLog.write(r), hours: 6, repeatHours: 24 });
    t.deps.emitEvent = async () => { if (sw.on) throw enospc(); };
    t.deps.host = undefined;
    const s = new Scheduler(t.deps, { driveChain: async (_d, c) => c });
    await s.tick();
    return { ...t, s, ch, sw, space, failFirstSend };
  }
  const label = (ch: { sent: string[] }, l: string) => ch.sent.filter((m) => m.startsWith(`infra: ${l}`));

  it("AC-9: run() never rejects, one message of each label, the findings and the interval land after the resume", async () => {
    const w = await outage(false);
    const claim = readFileSync(`${w.paths.claims}/7.json`, "utf8");
    let wallBefore = "";
    try {
      w.space.v = { bytes: 0, inodes: 0 };
      w.sw.on = true;
      for (let i = 2; i <= 7; i++) { w.advance(15); await expect(w.s.tick()).resolves.toBeDefined(); }
      expect(w.ch.sent).toHaveLength(2);
      expect(label(w.ch, "host")).toHaveLength(1);
      expect(label(w.ch, "disk_full")).toHaveLength(1);
      wallBefore = new Date().toISOString();
      w.sw.on = false;
      w.space.v = { bytes: 30 * GIB, inodes: 1_000_000 };
      w.advance(15);
      await w.s.tick();
    } finally { w.sw.restore(); }
    expect(w.ch.sent).toHaveLength(2);
    const recs = serviceRecords(w.paths);
    for (const kind of ["host-paused", "host-paused-notice", "host-resumed"]) expect(recs.filter((r) => r.kind === kind)).toHaveLength(1);
    expect(recs.filter((r) => r.kind === "tick" && r.host)).toHaveLength(6);
    const at = (k: string) => recs.findIndex((r) => r.kind === k);
    expect([at("host-paused"), at("host-paused-notice"), at("host-resumed")]).toEqual([...[at("host-paused"), at("host-paused-notice"), at("host-resumed")]].sort((a, b) => a - b));
    // The records the service log kept in memory carry the time they were made, not the time they were written.
    for (const r of recs.filter((r) => r.kind === "host-paused" || r.kind === "host-paused-notice" || (r.kind === "tick" && r.host))) expect(String(r.at) <= wallBefore).toBe(true);
    expect(String(recs.find((r) => r.kind === "host-resumed")!.at) >= wallBefore).toBe(true);
    const findings = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l).finding);
    expect(findings.filter((f) => f.what === "host outage pauses the scheduler: ENOSPC")).toHaveLength(1);
    expect(findings.find((f) => f.what === "host outage pauses the scheduler: ENOSPC")).toMatchObject({ stops_pipeline: true });
    const host = await readHostState(w.paths);
    expect(host.paused).toBeNull();
    expect(host.downtime.filter((d) => d.reason === "host")).toHaveLength(1);
    expect(readFileSync(`${w.paths.claims}/7.json`, "utf8")).toBe(claim);
    expect(await w.claim()).toBeTruthy();
  }, 120_000);

  it("AC-4: a send that fails on the first paused tick delivers nothing then; the next tick sends one of each, and none after", async () => {
    const w = await outage(true);
    try {
      w.space.v = { bytes: 0, inodes: 0 };
      w.sw.on = true;
      w.ch.failNext = 2;
      w.advance(15);
      await w.s.tick();
      expect(w.ch.sent).toHaveLength(0);
      for (let i = 0; i < 4; i++) { w.advance(15); await w.s.tick(); }
      expect(label(w.ch, "host")).toHaveLength(1);
      expect(label(w.ch, "disk_full")).toHaveLength(1);
    } finally { w.sw.restore(); }
  }, 120_000);
});

describe("run() with a service log that cannot be appended (spec 114 AC-1)", () => {
  it("does not reject when the tick rejects and the log append throws", async () => {
    const t = await outageSetup(async (_d, c) => c);
    const log = new ServiceLog(t.paths.serviceLog, { append: () => { throw enospc(); }, stderr: () => {} });
    t.deps.serviceLog = log;
    t.deps.log = (rec) => log.write(rec);
    t.deps.host = undefined;
    const s = new Scheduler(t.deps, { driveChain: async (_d, c) => c });
    s.tick = async () => { throw enospc(); };
    t.deps.sleep = async () => { s.stop("test"); };
    await expect(s.run()).resolves.toBeUndefined();
  });
});
