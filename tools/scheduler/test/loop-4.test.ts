import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeClaim } from "../src/state/claims.ts";
import { routes, setup, settle, dns, serviceRecords, outageSetup } from "./helpers/loop-harness.ts";

describe("Scheduler.tick plain files (spec 072)", () => {
  it("checks on the first tick, not at +30 minutes, again at +1 hour, and survives a failing check", async () => {
    const { s, deps, paths, setNow } = await setup(routes([]));
    const { CredentialStore } = await import("../src/credentials/store.ts");
    const store = new CredentialStore({ dir: join(paths.root, "cred-store"), systemdCreds: join(import.meta.dirname, "helpers", "fake-systemd-creds") });
    mkdirSync(store.dir, { recursive: true });
    const file = join(paths.root, "app.pem");
    writeFileSync(file, "x");
    await store.writeSecret("github-app-key", "k", "import");
    deps.plainFiles = { store, paths: { "github-app-key": file }, fromStore: new Set(["github-app-key"]) };
    const notes = () => deps.notifier && existsSync(paths.plainFilesReminder);
    await s.tick();
    expect(notes()).toBe(true);
    rmSync(paths.plainFilesReminder);
    setNow(new Date("2026-10-12T12:30:00Z"));
    await s.tick();
    expect(existsSync(paths.plainFilesReminder)).toBe(false);
    setNow(new Date("2026-10-12T13:00:00Z"));
    await s.tick();
    expect(existsSync(paths.plainFilesReminder)).toBe(true);
    writeFileSync(join(store.dir, "index.json"), "{");
    setNow(new Date("2026-10-12T14:00:00Z"));
    const info = await s.tick();
    expect(info.errors).toEqual([]);
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"plain-files-check-failed"');
  }, 60000);
});
describe("Scheduler.tick: transient failures (spec 015)", () => {
  describe("host outage pauses the scheduler (spec 100)", () => {
    const hostFile = (paths: { host: string }) => JSON.parse(readFileSync(paths.host, "utf8"));
    const logs = (paths: Parameters<typeof serviceRecords>[0], kind: string) => serviceRecords(paths).filter((r) => r.kind === kind);
    const queued = (paths: { findingsQueue: string }) => (existsSync(paths.findingsQueue) ? readFileSync(paths.findingsQueue, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

    it("pauses on a transient failure the probe confirms, and counts nothing (AC-2)", async () => {
      let calls = 0;
      const t = await outageSetup(async () => { calls++; throw dns(); });
      t.setProbe("EAI_AGAIN");
      await t.s.tick();
      await settle();
      const c = await t.claim();
      expect(c.outage).toBeUndefined();
      expect(c.state.chainFailures).toBeNull();
      expect(existsSync(join(t.paths.escalations, "7.json"))).toBe(false);
      expect(hostFile(t.paths).paused).toEqual({ since: t.deps.now().toISOString(), cause: "EAI_AGAIN", probes: 1, next_probe_at: new Date(t.deps.now().getTime() + 60_000).toISOString(), notified: false });
      expect(logs(t.paths, "host-paused")).toEqual([expect.objectContaining({ cause: "EAI_AGAIN", error: "getaddrinfo EAI_AGAIN api.github.com" })]);
      expect(logs(t.paths, "transient-outage")).toEqual([]);
      expect(queued(t.paths)).toEqual([]);
      expect(t.notifications).toEqual([]);
      expect(t.events).toEqual([]);
      expect(calls).toBe(1);
    }, 60_000);

    it("leaves an outage the claim already has as it was (AC-2)", async () => {
      const t = await outageSetup(async () => { throw dns(); });
      const c0 = await t.claim();
      const outage = { since: c0.last_activity_at, count: 3, last: "x", retry_at: c0.last_activity_at, alarmed: false };
      await writeClaim(t.paths, { ...c0, outage });
      t.setProbe("ENETUNREACH");
      await t.s.tick();
      await settle();
      expect((await t.claim()).outage).toEqual(outage);
    }, 60_000);

    it("pauses before any claim is read when the freshness fetch fails transiently (AC-2)", async () => {
      let calls = 0;
      const t = await outageSetup(async () => { calls++; return (await t.claim()); });
      t.deps.fetchOrigin = async () => { throw dns(); };
      t.allowErrors(/freshness/);
      t.setProbe("EAI_AGAIN");
      const info = await t.s.tick();
      await settle();
      expect(info).toMatchObject({ eligible: 0, claimed: [], released: [], standing: [] });
      expect(calls).toBe(0);
      expect(hostFile(t.paths).paused).toMatchObject({ cause: "EAI_AGAIN", probes: 1 });
      // The probe passing leaves the failure as today: an error of the tick, no pause.
      const u = await outageSetup(async (_d, c) => c);
      u.deps.fetchOrigin = async () => { throw dns(); };
      u.allowErrors(/freshness/);
      expect((await u.s.tick()).errors.join()).toContain("freshness");
      expect(existsSync(u.paths.host) ? hostFile(u.paths).paused : null).toBeNull();
    }, 60_000);

    it("a paused tick only sweeps and prunes, re-probes on a backoff and resumes on the tick that passes, 30 h later, with nothing released (AC-3, AC-4, AC-6)", async () => {
      let calls = 0;
      let failing = true;
      const t = await outageSetup(async (_d, c) => { calls++; if (failing) throw dns(); return c; });
      t.setProbe("EAI_AGAIN");
      await t.s.tick();
      await settle();
      expect(calls).toBe(1);
      const since = t.deps.now().getTime();
      // Not due yet: nothing is probed, nothing runs, the tick line carries the pause.
      t.advance(30);
      const info = await t.s.tick();
      await settle();
      expect(info).toMatchObject({ eligible: 0, claimed: [], released: [], standing: [] });
      expect(calls).toBe(1);
      const tickLine = logs(t.paths, "tick").at(-1)!;
      expect(tickLine.host).toMatchObject({ cause: "EAI_AGAIN", probes: 1 });
      // Re-probes fail: probes count up, the wait doubles, the first cause is kept.
      t.advance(30);
      await t.s.tick();
      expect(hostFile(t.paths).paused).toMatchObject({ probes: 2, cause: "EAI_AGAIN", next_probe_at: new Date(t.deps.now().getTime() + 120_000).toISOString() });
      t.setProbe("ENETDOWN");
      t.advance(120);
      await t.s.tick();
      expect(hostFile(t.paths).paused).toMatchObject({ probes: 3, cause: "EAI_AGAIN", next_probe_at: new Date(t.deps.now().getTime() + 240_000).toISOString() });
      // The pause lasts 30 h: one notice, no release, no ceiling.
      t.advance(30 * 3600);
      await t.s.tick();
      await t.s.tick();
      expect(logs(t.paths, "host-paused-notice")).toHaveLength(1);
      expect(t.notifications.filter((n) => n.gate === "infra" && n.label === "host")).toHaveLength(1);
      expect(t.events.filter((e) => e.event === "infra_alarm")).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ kind: "host_outage", cause: "EAI_AGAIN", probes: expect.any(Number) }) }]);
      expect(queued(t.paths).filter((f) => f.finding.what === "host outage pauses the scheduler: EAI_AGAIN")).toEqual([expect.objectContaining({ finding: expect.objectContaining({ stops_pipeline: true, where: "scheduler host", noticed_how: "scheduler host probe" }) })]);
      expect(calls).toBe(1);
      // The probe passes: the same tick resumes and starts the claim at once.
      t.setProbe(null);
      failing = false;
      t.advance(1800);
      const resumed = await t.s.tick();
      await settle();
      expect(resumed.released).toEqual([]);
      expect(calls).toBe(2);
      expect(logs(t.paths, "host-resumed")).toEqual([expect.objectContaining({ cause: "EAI_AGAIN", paused_ms: expect.any(Number) })]);
      const state = hostFile(t.paths);
      expect(state.paused).toBeNull();
      expect(state.downtime).toEqual([{ from: new Date(since).toISOString(), to: t.deps.now().toISOString(), reason: "host" }]);
      expect(await t.claim()).toBeTruthy();
      expect((await t.claim()).outage).toBeUndefined();
      expect(logs(t.paths, "stale-claim")).toEqual([]);
      expect(t.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    }, 60_000);

    it("a full disk notifies on the first paused tick with the disk_full kind (AC-5)", async () => {
      const t = await outageSetup(async () => { throw dns(); });
      t.setProbe("ENOSPC");
      await t.s.tick();
      await settle();
      await t.s.tick();
      expect(logs(t.paths, "host-paused-notice")).toHaveLength(1);
      expect(t.events).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ kind: "disk_full", cause: "ENOSPC" }) }]);
    }, 60_000);

    it("a gap since the last tick of the previous process is downtime, so a claim idle through it is not released (AC-6)", async () => {
      const t = await outageSetup(async (_d, c) => c);
      const now = t.deps.now().getTime();
      const c0 = await t.claim();
      await writeClaim(t.paths, { ...c0, last_activity_at: new Date(now - 10 * 3600_000).toISOString() });
      writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: new Date(now - 10 * 3600_000).toISOString(), downtime: [] }));
      expect((await t.s.tick()).released).toEqual([]);
      await settle();
      expect(logs(t.paths, "downtime")).toEqual([expect.objectContaining({ reason: "stopped", ms: 10 * 3600_000 })]);
      expect(hostFile(t.paths).last_seen_at).toBe(t.deps.now().toISOString());
      expect(await t.claim()).toBeTruthy();
    }, 60_000);

    it("a pending self-restart neither resumes nor releases a claim waiting on its checks, and keeps when it began (spec 104 AC-1, AC-3; issue #412)", async () => {
      let calls = 0;
      const t = await outageSetup(async (_d, c) => { calls++; return c; });
      const now = t.deps.now().getTime();
      const c0 = await t.claim();
      // The #254 case: the claim went to verify, then nothing polled it for longer than the liveness window.
      await writeClaim(t.paths, { ...c0, last_activity_at: new Date(now - 3 * 3600_000).toISOString() });
      t.deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
      const first = await t.s.tick();
      await settle();
      expect(first.restartPending).toBe(true);
      expect(first.released).toEqual([]);
      expect(hostFile(t.paths).restart_pending_since).toBe(t.deps.now().toISOString());
      const since = hostFile(t.paths).restart_pending_since;
      t.deps.fastForward = async () => ({ moved: false, changedPaths: [] });
      t.advance(3600);
      const later = await t.s.tick();
      await settle();
      expect(later.released).toEqual([]);
      expect(calls).toBe(0);
      expect(await t.claim()).toBeTruthy();
      expect(logs(t.paths, "stale-claim")).toEqual([]);
      // A later tick keeps the first moment.
      expect(hostFile(t.paths).restart_pending_since).toBe(since);
    }, 60_000);

    it("the next process counts the previous one's pending restart as downtime, so the waiting claim is resumed, not released (spec 104 AC-2)", async () => {
      let calls = 0;
      const t = await outageSetup(async (_d, c) => { calls++; return c; });
      const now = t.deps.now().getTime();
      const c0 = await t.claim();
      await writeClaim(t.paths, { ...c0, last_activity_at: new Date(now - 3 * 3600_000).toISOString() });
      // The previous process saw its last tick a moment ago (a short gap: no `stopped` interval), its restart pending for 2 h 55 min.
      const since = new Date(now - (2 * 3600 + 55 * 60) * 1000).toISOString();
      writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: new Date(now - 30_000).toISOString(), downtime: [], restart_pending_since: since }));
      const tick = await t.s.tick();
      await settle();
      expect(tick.released).toEqual([]);
      expect(calls).toBe(1);
      const state = hostFile(t.paths);
      expect(state.restart_pending_since).toBeUndefined();
      // The test's poll interval is short, so the 30 s gap is a `stopped` interval too; the union counts once.
      expect(state.downtime).toContainEqual({ from: since, to: t.deps.now().toISOString(), reason: "restart" });
      expect(logs(t.paths, "downtime")).toContainEqual(expect.objectContaining({ reason: "restart", ms: (2 * 3600 + 55 * 60) * 1000 }));
    }, 60_000);

    it("without the pending-restart interval the same idle claim is released (spec 104 AC-2, control)", async () => {
      const t = await outageSetup(async (_d, c) => c);
      const now = t.deps.now().getTime();
      const c0 = await t.claim();
      await writeClaim(t.paths, { ...c0, last_activity_at: new Date(now - 3 * 3600_000).toISOString() });
      writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: new Date(now - 30_000).toISOString(), downtime: [] }));
      expect((await t.s.tick()).released).toEqual([7]);
    }, 60_000);

    it("a downtime shorter than the idle time less the window still releases (AC-6)", async () => {
      const t = await outageSetup(async (_d, c) => c);
      const now = t.deps.now().getTime();
      const c0 = await t.claim();
      await writeClaim(t.paths, { ...c0, last_activity_at: new Date(now - 10 * 3600_000).toISOString() });
      const iv = { from: new Date(now - 10 * 3600_000).toISOString(), to: new Date(now - 3 * 3600_000).toISOString(), reason: "host" };
      writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: null, downtime: [iv] }));
      expect((await t.s.tick()).released).toEqual([7]);
    }, 60_000);

    it("a claim idle through a 165,076,291 ms sleep is not released by the first tick after `resumed` (AC-6, issue #15)", async () => {
      const t = await outageSetup(async (_d, c) => c);
      const SLEPT = 165_076_291;
      let ticks = 0;
      const infos: Awaited<ReturnType<typeof t.s.tick>>[] = [];
      const orig = t.s.tick.bind(t.s);
      t.s.tick = async () => { const r = await orig(); infos.push(r); if (++ticks === 2) t.s.stop("test"); return r; };
      t.deps.sleep = async () => { t.setNow(new Date(t.deps.now().getTime() + SLEPT)); };
      await t.s.run();
      expect(logs(t.paths, "resumed")).toEqual([expect.objectContaining({ slept_ms: SLEPT })]);
      expect(infos.map((i) => i.released)).toEqual([[], []]);
      expect(await t.claim()).toBeTruthy();
      expect(hostFile(t.paths).downtime).toEqual([expect.objectContaining({ reason: "sleep" })]);
    }, 60_000);

    it("an outage's age counts running time only: 29 h of downtime in a 30 h outage is not past the ceiling (AC-8)", async () => {
      const t = await outageSetup(async () => { throw dns(); });
      const c0 = await t.claim();
      const now = t.deps.now().getTime();
      const since = new Date(now - 30 * 3600_000).toISOString();
      await writeClaim(t.paths, { ...c0, outage: { since, count: 5, last: "x", retry_at: since, alarmed: true } });
      const iv = { from: new Date(now - 29.5 * 3600_000).toISOString(), to: new Date(now - 0.5 * 3600_000).toISOString(), reason: "host" };
      writeFileSync(t.paths.host, JSON.stringify({ paused: null, last_seen_at: null, downtime: [iv] }));
      await t.s.tick();
      await settle();
      const c = await t.claim();
      expect(c.outage).toMatchObject({ since, count: 6 });
      expect(c.outage?.past_ceiling).toBeUndefined();
      expect(c.state.chainFailures).toBeNull();
    }, 60_000);
  });
});
