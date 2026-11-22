import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerOf } from "../src/chain/machine.ts";
import { listClaims } from "../src/state/claims.ts";
import { statePaths } from "../src/state/paths.ts";
import { readAgentState, writeAgentState } from '../src/standing/state.ts';
import { chainWorld, standingWorld, NETWORK_DOWN, type ChainWorld } from "./helpers/e2e-routes.ts";
import { probeHost } from "../src/service/host.ts";
import { tmpdir } from "node:os";
import { specOf, repoFiles, PLAN, APPROVE, agents, expectSettled, kinds, serviceRecords, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-10");

describe("end to end: a reflection run records its plan and its metrics snapshot (spec 028 AC-6)", () => {
  it("a charter reflection with no items still files a plan issue", async () => {
    const w = await standingWorld({ "charter-reflection": [{ summary: "nothing to change", plan: { title: "Plan", summary: "Nothing to change.", observations: [], items: [], metrics_note: "no data", open_questions_note: "none", deferred: [] } }] });
    for (const name of Object.keys(w.registry)) await writeAgentState(w.paths, name, { ...(await readAgentState(w.paths, name))!, paused: name !== "charter-reflection", paused_by: name !== "charter-reflection" ? "maintainer" : null });
    w.setNow(new Date("2026-10-09T00:00:00Z"));
    await w.scheduler.tick();
    for (let i = 0; i < 6000 && w.scheduler.active; i++) await new Promise((r) => setTimeout(r, 25));
    expect(w.adapter.ran).toEqual(["charter-reflection"]);
    expect(w.issues.map((i) => i.title)).toEqual(["Charter plan 2026-10-09"]);
    expect(w.issues[0]!.body).toContain("This plan has no items.");
  }, 60_000);
});
// ---------------------------------------------------------------------------------------------------------------
// Spec 100 AC-9, AC-10: a host that cannot work pauses the scheduler; only an issue's own failures spend its bounds.

describe("end to end: a host outage pauses the scheduler (spec 100 AC-10)", () => {
  const clock = (w: ChainWorld) => {
    const c = { offset: 0 };
    w.deps.now = () => new Date(Date.now() + c.offset);
    return c;
  };
  const hostState = (w: { paths: { host: string } }) => JSON.parse(readFileSync(w.paths.host, "utf8"));
  const infraAlarms = async (w: { paths: ReturnType<typeof statePaths> }) => (await readAgentState(w.paths, "infra-health"))!.pending_events.filter((e) => e.event === "infra_alarm");

  it("ten ticks over 30 h with the probe failing release nothing, spend nothing, and the chain merges once the host is back", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), host: (tick) => (tick <= 10 ? "EAI_AGAIN" : null), results: { plan: [PLAN], implement: [NETWORK_DOWN, a.implement(9)], review: [APPROVE] } });
    const c = clock(w);
    // The credential check (spec 099) comes due daily and would take the slot on the resuming tick of a 30 h fake clock.
    await writeAgentState(w.paths, "credential-check", { ...(await readAgentState(w.paths, "credential-check"))!, paused: true, paused_by: "maintainer" });
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    const before = (await listClaims(w.paths))[0];
    for (let i = 2; i <= 10; i++) {
      c.offset += 3 * 3600_000;
      await w.tick();
    }
    expect(c.offset).toBe(27 * 3600_000);
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    const claim = (await listClaims(w.paths))[0];
    expect(claim.outage).toBeUndefined();
    expect(claim.state.chainFailures).toBeNull();
    expect(ledgerOf(claim.state)).toEqual(ledgerOf(before.state));
    let records = serviceRecords(w);
    for (const kind of ["chain-error", "transient-outage", "transient-outage-ceiling", "stale-claim"]) expect(records.filter((r) => r.kind === kind)).toEqual([]);
    expect(records.filter((r) => r.kind === "host-paused")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "host-paused-notice")).toHaveLength(1);
    expect(w.notifications.filter((n) => n.gate === "infra")).toEqual([expect.objectContaining({ issue: 0, label: "host" })]);
    expect(await infraAlarms(w)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ kind: "host_outage", cause: "EAI_AGAIN" }) })]);
    expect(hostState(w).paused).toMatchObject({ cause: "EAI_AGAIN", notified: true });
    expect(existsSync(join(w.paths.escalations, "7.json"))).toBe(false);

    c.offset += 3 * 3600_000;
    await w.tick();
    await expectSettled(w);
    records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "host-resumed")).toHaveLength(1);
    expect(hostState(w)).toMatchObject({ paused: null, downtime: [expect.objectContaining({ reason: "host" })] });
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "review"]);
    expect(kinds(w, "stage").filter((r) => r.stage === "implement").at(-1)).toMatchObject({ outcome: "ok", attempt: 1 });
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
  }, 240_000);

  it("a full temp volume pauses with cause ENOSPC, notifies at once, and the spec stage runs untouched once space returns (spec 059 AC-6's first world)", async () => {
    const TMP = process.env.CLAUDE_CODE_TMPDIR || tmpdir();
    const ROOMY = async (_path: string) => ({ bytes: 20 * 2 ** 30, inodes: 1_000_000 });
    const LOW = async (path: string) => (path === TMP ? { bytes: 100 * 2 ** 20, inodes: 1_000_000 } : ROOMY(path));
    let reader = LOW;
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles({ spec: null }), freeSpace: (path) => reader(path),
      host: () => probeHost({ paths: w.paths, freeSpace: (path) => reader(path), fetch: (async () => new Response(null, { status: 200 })) as never }),
      results: { spec: [a.spec(12, { "specs/010-thing/spec.md": specOf() })], review: [APPROVE] },
    });
    const c = clock(w);
    for (let i = 0; i < 3; i++) {
      await w.tick();
      c.offset += 1000_000;
    }
    const during = (await listClaims(w.paths))[0];
    expect(during.outage).toBeUndefined();
    expect(w.adapter.ran).toEqual([]);
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "host-paused")).toEqual([expect.objectContaining({ cause: "ENOSPC" })]);
    expect(records.filter((r) => r.kind === "host-paused-notice")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage")).toEqual([]);
    expect(records.filter((r) => String(r.kind).startsWith("disk-sweep")).length).toBeGreaterThan(0);
    const findings = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings.filter((f) => f.finding.what === "host outage pauses the scheduler: ENOSPC")).toEqual([expect.objectContaining({ finding: expect.objectContaining({ stops_pipeline: true }) })]);
    expect(w.notifications.filter((n) => n.gate === "infra" && n.label === "host")).toHaveLength(1);
    expect((await infraAlarms(w)).filter((e) => (e.payload as { probes?: number }).probes !== undefined)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ kind: "disk_full", cause: "ENOSPC" }) })]);
    expect(ledgerOf(during.state)).toMatchObject({ specRescues: 0, history: [] });

    reader = ROOMY;
    await w.tick();
    expect(w.adapter.ran.slice(0, 2)).toEqual(["spec", "review"]);
    expect(kinds(w, "stage")[0]).toMatchObject({ stage: "spec", outcome: "ok", attempt: 1 });
    expect(serviceRecords(w).filter((r) => r.kind === "host-resumed")).toHaveLength(1);
  }, 240_000);

  it("a transient failure with the probe passing is the issue's own: unchanged, no host pause (spec 015 AC-12's second chain)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [NETWORK_DOWN, NETWORK_DOWN, NETWORK_DOWN, NETWORK_DOWN, a.implement(9)], review: [APPROVE] } });
    const c = clock(w);
    for (let i = 0; i < 5; i++) {
      await w.tick();
      c.offset += 2000_000;
    }
    await expectSettled(w);
    const records = serviceRecords(w);
    expect(records.filter((r) => String(r.kind).startsWith("host-"))).toEqual([]);
    expect(records.filter((r) => r.kind === "transient-outage")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
  }, 240_000);

  describe("standing agents", () => {
    type SW = Awaited<ReturnType<typeof standingWorld>>;
    const T0 = "2026-10-01T00:00:00.000Z";
    const idle = async (w: SW) => { for (let i = 0; i < 1000 && w.scheduler.active; i++) await new Promise((r) => setTimeout(r, 25)); expect(w.scheduler.active).toBe(0); };
    const dueNow = async (w: SW, name: string, extra: Record<string, unknown> = {}) => { const st = (await readAgentState(w.paths, name))!; await writeAgentState(w.paths, name, { ...st, ...extra, next_run: w.deps.now().toISOString() }); };
    const tickAt = async (w: SW, at: string) => { w.setNow(new Date(at)); await w.scheduler.tick(); await idle(w); };
    const capture = (w: SW) => { const logs: Record<string, unknown>[] = []; w.deps.log = (r) => { logs.push(r as Record<string, unknown>); }; return logs; };

    it("a run lost to the network while the probe fails pauses the scheduler and leaves the agent alone, then runs on the next due tick", async () => {
      const w = await standingWorld({ "findings-filer": [NETWORK_DOWN, { summary: "triaged", decisions: [] }] });
      const logs = capture(w);
      await dueNow(w, "findings-filer");
      w.setProbe("EAI_AGAIN");
      await tickAt(w, T0);
      let st = (await readAgentState(w.paths, "findings-filer"))!;
      expect(st).toMatchObject({ failures: 0, next_run: T0, last_run: null });
      expect(st.outage).toBeUndefined();
      expect(st.postponed_until).toBeUndefined();
      expect(st.running).toBeUndefined();
      expect(logs.filter((l) => l.kind === "standing-host-paused")).toEqual([expect.objectContaining({ agent: "findings-filer", cause: "EAI_AGAIN" })]);
      expect(logs.filter((l) => l.kind === "standing-outage" || l.kind === "standing-postponed")).toEqual([]);
      expect(JSON.parse(readFileSync(w.paths.host, "utf8")).paused).toMatchObject({ cause: "EAI_AGAIN" });
      await tickAt(w, "2026-10-01T00:00:30.000Z");
      expect(w.adapter.ran).toEqual(["findings-filer"]);
      w.setProbe(null);
      await tickAt(w, "2026-10-01T00:01:10.000Z");
      st = (await readAgentState(w.paths, "findings-filer"))!;
      expect(st.last_run?.outcome).toBe("ok");
      expect(w.adapter.ran).toEqual(["findings-filer", "findings-filer"]);
    }, 60_000);

    it("an outage's age counts running time only: a 30 h outage with 28 h of downtime is not past the ceiling (AC-8)", async () => {
      const w = await standingWorld({ operator: [NETWORK_DOWN] });
      const logs = capture(w);
      const since = "2026-09-29T18:00:00.000Z";
      await dueNow(w, "operator", { outage: { since, count: 10, last: "x", alarmed: true } });
      writeFileSync(w.paths.host, JSON.stringify({ paused: null, last_seen_at: null, downtime: [{ from: "2026-09-29T19:00:00.000Z", to: "2026-09-30T23:00:00.000Z", reason: "host" }] }));
      await tickAt(w, T0);
      const st = (await readAgentState(w.paths, "operator"))!;
      expect(st).toMatchObject({ failures: 0, outage: { since, count: 11 } });
      expect(st.outage?.past_ceiling).toBeUndefined();
      expect(logs.filter((l) => l.kind === "standing-outage-ceiling")).toEqual([]);
    }, 60_000);
  });
});
