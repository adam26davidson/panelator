import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standingWorld } from "./helpers/e2e-routes.ts";
import { git } from "./helpers/repo-pair.ts";
import { readJsonLines } from "../src/filer/input.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";
import type { LogEntry } from "../src/actions/log.ts";
import type { FreeSpace } from "../src/runner/host-space.ts";
import type { DiskSweep } from "../src/service/sweep.ts";

// Spec 064 AC-7: the sweep and infra health, end to end on recorded worlds.
const T0 = new Date("2026-10-01T00:00:00Z");
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000);
const touch = (path: string, d: Date): void => utimesSync(path, d, d);
const ROOMY = 3_000_000;
const before = process.env.CLAUDE_CODE_TMPDIR;
afterEach(() => { if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = before; });

async function sweepWorld(inodesOf: (path: string, tmp: string) => number, results: Record<string, unknown[]> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "sweep-e2e-"));
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  const w = await standingWorld(results, async (path): Promise<FreeSpace> => ({ bytes: 20 * 2 ** 30, inodes: inodesOf(path, tmp) }));
  await writeAgentState(w.paths, "infra-health", { ...(await readAgentState(w.paths, "infra-health"))!, paused: false, paused_by: null });
  for (const name of ["findings-filer", "action-audit", "operator"]) await writeAgentState(w.paths, name, { ...(await readAgentState(w.paths, name))!, paused: true, paused_by: "maintainer" });
  w.setNow(T0);
  const root = (name: string, minutesOld: number): string => {
    const p = join(tmp, name);
    mkdirSync(p);
    for (let i = 0; i < 3; i++) writeFileSync(join(p, `f${i}`), "x");
    touch(p, at(-minutesOld));
    return p;
  };
  const idle = async () => { for (let i = 0; i < 1000 && w.scheduler.active; i++) await new Promise((r) => setTimeout(r, 25)); };
  const service = () => readJsonLines<Record<string, unknown> & { kind: string }>(w.paths.serviceLog);
  const actions = () => readJsonLines<LogEntry>(w.paths.actionsLog);
  const report = () => JSON.parse(readFileSync(w.paths.diskSweep, "utf8")) as DiskSweep;
  const findings = () => readJsonLines<{ finding: Record<string, unknown> }>(w.paths.findingsQueue);
  return { ...w, tmp, root, idle, service, actions, report, findings };
}

describe("end to end: the scheduler sweeps its own volumes (spec 064 AC-7)", () => {
  it("clears two stale test roots on a low volume without an alarm, and leaves the fresh one", async () => {
    const w = await sweepWorld(() => ROOMY);
    const a = w.root("panelator-test-a", 180), b = w.root("panelator-test-b", 180), fresh = w.root("panelator-test-fresh", 0);
    w.deps.freeSpace = async (path) => ({ bytes: 20 * 2 ** 30, inodes: path === w.tmp && existsSync(a) ? 50_000 : ROOMY });
    await w.scheduler.tick(); await w.idle();
    const kinds = (await w.service()).map((r) => r.kind);
    expect(kinds).toContain("disk-sweep-urgent");
    expect(kinds).not.toContain("disk-sweep-alarm");
    const rows = (await w.actions()).filter((r) => r.kind === "sweep_volume");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", agent: "scheduler", undo: null });
    expect(existsSync(a) || existsSync(b)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(w.notifications).toEqual([]);
    expect(existsSync(w.paths.findingsQueue) ? await w.findings() : []).toEqual([]);
    const volume = w.report().volumes.find((v) => v.path === w.tmp)!;
    expect(volume.removed).toBe(2);
    expect(volume.episode).toBeUndefined();
  }, 60_000);

  it("alarms once on a volume the sweep cannot clear, and recovers; infra health then judges the holder", async () => {
    let recovered = false, sawFresh = false;
    const w = await sweepWorld((path, tmp) => (path === tmp && !recovered ? 500 : ROOMY), {
      "infra-health": [(run: { prompt: string }) => {
        sawFresh = run.prompt.includes("panelator-test-fresh");
        return { summary: "a killed test run held the temp volume", findings: [{ what: "leaked test root held the temp volume", where: "panelator-test-fresh", evidence: "the report names it as the largest holder", noticed_how: "infra health sweep", stops_pipeline: false }] };
      }],
    });
    const fresh = w.root("panelator-test-fresh", 0);
    const state = async () => (await readAgentState(w.paths, "infra-health"))!;
    await w.scheduler.tick(); await w.idle();
    expect((await w.service()).filter((r) => r.kind === "disk-sweep-alarm")).toHaveLength(1);
    expect(w.notifications).toHaveLength(1);
    expect(w.notifications[0]).toMatchObject({ gate: "infra", label: "disk_full" });
    expect(w.notifications[0].text).toContain(w.tmp);
    expect(w.notifications[0].text).toContain("500");
    expect(w.notifications[0].text).toContain("panelator-test-fresh");
    const queued = await w.findings();
    expect(queued).toHaveLength(1);
    expect(queued[0].finding).toMatchObject({ what: "host volume low after sweep", where: w.tmp, stops_pipeline: true });
    const events = (await state()).pending_events.filter((e) => e.event === "infra_alarm");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ kind: "disk_full", path: w.tmp });
    expect((events[0].payload as Record<string, unknown>).issue).toBeUndefined();
    // spec 059 AC-3: the agent is due but its launch is postponed while the volume is full
    expect(w.adapter.ran).toEqual([]);

    w.setNow(at(0.5));
    await w.scheduler.tick(); await w.idle();
    expect(w.notifications).toHaveLength(1);
    expect((await w.service()).filter((r) => r.kind === "disk-sweep-alarm")).toHaveLength(1);
    expect((await state()).pending_events.filter((e) => e.event === "infra_alarm")).toHaveLength(1);

    recovered = true;
    w.setNow(at(100));
    await w.scheduler.tick(); await w.idle();
    expect((await w.service()).filter((r) => r.kind === "disk-sweep-recovered")).toHaveLength(1);
    expect(w.report().volumes.find((v) => v.path === w.tmp)?.episode).toBeUndefined();
    expect(existsSync(fresh)).toBe(true);
    await w.scheduler.tick(); await w.idle();
    expect(w.adapter.ran).toEqual(["infra-health"]);
    expect(sawFresh).toBe(true);
    const all = await w.findings();
    expect(all.map((f) => f.finding.what)).toEqual(["host volume low after sweep", "leaked test root held the temp volume"]);
  }, 60_000);

  it("removes an unclaimed old worktree on the routine sweep and saves its unpushed commit", async () => {
    const w = await sweepWorld(() => ROOMY);
    await w.scheduler.tick(); await w.idle();
    const add = (issue: number) => {
      const p = join(w.paths.worktrees, `issue-${issue}`);
      git(w.pair.repo, "worktree", "add", "-q", "-b", `issue-${issue}`, p, "origin/main");
      return p;
    };
    const old = add(8), live = add(9);
    writeFileSync(join(old, "new.txt"), "work\n"); git(old, "add", "-A"); git(old, "commit", "-q", "-m", "unpushed commit");
    touch(old, at(-180)); touch(live, at(59));
    w.setNow(at(30));
    await w.scheduler.tick(); await w.idle();
    expect(existsSync(old)).toBe(true);
    w.setNow(at(61));
    await w.scheduler.tick(); await w.idle();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(live)).toBe(true);
    const patches = readdirSync(w.paths.patchesSweep);
    expect(patches).toHaveLength(1);
    expect(readFileSync(join(w.paths.patchesSweep, patches[0]), "utf8")).toContain("unpushed commit");
    const rows = (await w.actions()).filter((r) => r.kind === "sweep_volume");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "applied", undo: null, agent: "scheduler" });
  }, 60_000);
});

describe("end to end: infra health runs (spec 064 AC-7, spec 030 section 6)", () => {
  const why = "Independently verified operational change from the input";
  const wake = async (w: Awaited<ReturnType<typeof sweepWorld>>, events: { event: string; payload: unknown }[]) => {
    const s = (await readAgentState(w.paths, "infra-health"))!;
    await writeAgentState(w.paths, "infra-health", { ...s, pending_events: events.map((e) => ({ ...e, at: T0.toISOString() })) });
    await w.scheduler.tick(); await w.idle();
  };

  it("runs over a service log with a NUL-only line and a NUL-prefixed record (spec 103 AC-3)", async () => {
    let prompt = "";
    const w = await sweepWorld(() => ROOMY, { "infra-health": [(run: { prompt: string }) => { prompt = run.prompt; return { summary: "nothing wrong" }; }] });
    const rec = (m: number, kind: string) => JSON.stringify({ at: at(m).toISOString(), kind }) + "\n";
    appendFileSync(w.paths.serviceLog, rec(-60, "tick") + "\u0000".repeat(300) + "\n" + "\u0000".repeat(200) + rec(-30, "tick"));
    await wake(w, [{ event: "infra_alarm", payload: { kind: "unknown_kind" } }]);
    expect(w.adapter.ran).toEqual(["infra-health"]);
    const log = await w.service();
    expect(log.filter((r) => r.kind === "standing-error")).toEqual([]);
    expect(prompt).toContain("skipped_lines");
    expect(prompt).toContain(w.paths.serviceLog);
  }, 60_000);

  it("re-runs a failed main workflow once", async () => {
    const w = await sweepWorld(() => ROOMY, { "infra-health": [{ summary: "re-ran main", actions: [{ kind: "rerun_workflow", args: { run_id: 9 }, why }] }] });
    await wake(w, [{ event: "ci_failure_main", payload: { check: "test", run_id: 9, sha: "abc" } }]);
    expect(w.mock.calls.filter((c) => /\/actions\/runs\/9\/rerun$/.test(c.url))).toHaveLength(1);
    expect((await w.actions()).filter((r) => r.kind === "rerun_workflow")).toEqual([expect.objectContaining({ status: "applied", agent: "infra-health" })]);
  }, 60_000);

  it("pauses a standing agent with three consecutive failures", async () => {
    const w = await sweepWorld(() => ROOMY, { "infra-health": [{ summary: "paused a failing agent", actions: [{ kind: "pause_agent", args: { name: "operator" }, why }] }] });
    await writeAgentState(w.paths, "operator", { ...(await readAgentState(w.paths, "operator"))!, paused: false, paused_by: null, failures: 3 });
    await wake(w, [{ event: "infra_alarm", payload: { kind: "network_outage", agent: "operator" } }]);
    const operator = (await readAgentState(w.paths, "operator"))!;
    expect(operator).toMatchObject({ paused: true, paused_by: "infra-health" });
  }, 60_000);

  it("files a finding, not an action, for an alarm of a kind it does not know", async () => {
    const w = await sweepWorld(() => ROOMY, { "infra-health": [{ summary: "unknown alarm kind", findings: [{ what: "infra_alarm of unknown kind meteor", where: "infra_alarm payload", evidence: "kind meteor is not one of the kinds I know", noticed_how: "infra health sweep" }] }] });
    await wake(w, [{ event: "infra_alarm", payload: { kind: "meteor" } }]);
    expect((await w.actions()).filter((r) => r.agent === "infra-health")).toEqual([]);
    expect((await w.findings()).map((f) => f.finding.what)).toEqual(["infra_alarm of unknown kind meteor"]);
  }, 60_000);
});
