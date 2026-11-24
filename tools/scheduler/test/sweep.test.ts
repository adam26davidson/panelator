import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREFIX } from "./helpers/test-tmpdir.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";
import { ensureStateDirs, statePaths, type StatePaths } from "../src/state/paths.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { writeClaim } from "../src/state/claims.ts";
import { writeAgentState } from "../src/standing/state.ts";
import { ActionLog } from "../src/actions/log.ts";
import { applyAction, KINDS, loadActionLevels, registryActionsCheck, type ActionContext } from "../src/actions/index.ts";
import { HOLDER_WALK_MAX, holders, newSweepMemory, readDiskSweep, staleLeftovers, sweepVolumes, TEST_ROOT_PREFIX, type SweepDeps } from "../src/service/sweep.ts";
import { readJsonLines } from "../src/filer/input.ts";
import type { FreeSpace } from "../src/runner/host-space.ts";

const NOW = new Date("2026-11-14T12:00:00Z");
const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);
const age = (path: string, min: number): void => utimesSync(path, ago(min), ago(min));
const put = (path: string, files = 3): string => {
  mkdirSync(path, { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(path, `f${i}`), `${i}`);
  return path;
};

let before: string | undefined;
beforeEach(() => { before = process.env.CLAUDE_CODE_TMPDIR; });
afterEach(() => { if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR; else process.env.CLAUDE_CODE_TMPDIR = before; });

async function world() {
  const pair = repoPair();
  const tmp = mkdtempSync(join(tmpdir(), "sweep-tmp-"));
  process.env.CLAUDE_CODE_TMPDIR = tmp;
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const worktree = (issue: number, commit: boolean) => {
    const path = join(paths.worktrees, `issue-${issue}`);
    git(pair.repo, "worktree", "add", "-q", "-b", `issue-${issue}`, path, "origin/main");
    if (commit) { writeFileSync(join(path, "new.txt"), "work\n"); git(path, "add", "-A"); git(path, "commit", "-q", "-m", "unpushed work"); }
    return path;
  };
  return { pair, tmp, paths, worktree, deps: { paths, repoDir: pair.repo, now: () => NOW } };
}

it("TEST_ROOT_PREFIX is the test helper's PREFIX", () => expect(TEST_ROOT_PREFIX).toBe(PREFIX));

describe("staleLeftovers", () => {
  it("lists only old panelator-test roots, at each age", async () => {
    const w = await world();
    put(join(w.tmp, `${PREFIX}old`)); age(join(w.tmp, `${PREFIX}old`), 180);
    put(join(w.tmp, `${PREFIX}mid`)); age(join(w.tmp, `${PREFIX}mid`), 20);
    put(join(w.tmp, `${PREFIX}new`)); age(join(w.tmp, `${PREFIX}new`), 10);
    put(join(w.tmp, "claude-1000")); age(join(w.tmp, "claude-1000"), 600);
    const names = async (a: "stale" | "urgent") => (await staleLeftovers(w.tmp, a, w.deps)).map((l) => l.name).sort();
    expect(await names("stale")).toEqual([`${PREFIX}old`]);
    expect(await names("urgent")).toEqual([`${PREFIX}mid`, `${PREFIX}old`]);
    expect(await staleLeftovers(w.paths.root, "stale", w.deps)).toEqual([]);
  });

  it("never lists a worktree with a claim, a paused or blocked record, a running agent or an active chain; reports a missing registered one", async () => {
    const w = await world();
    const made = [1, 2, 3, 4, 5].map((n) => w.worktree(n, false));
    for (const p of made) age(p, 600);
    await writeClaim(w.paths, { issue: 1, state: initialChainState(1), worktree: made[0], started_at: NOW.toISOString(), last_activity_at: NOW.toISOString(), run_id: null });
    writeFileSync(join(w.paths.paused, "2.json"), "{}");
    writeFileSync(join(w.paths.blocked, "3.json"), "{}");
    const standing = put(join(w.paths.worktrees, "standing-infra-health")); age(standing, 600);
    await writeAgentState(w.paths, "infra-health", { last_run: null, next_run: null, pending_events: [], paused: false, paused_by: null, failures: 0, running: { run_id: "r", started_at: NOW.toISOString() } });
    const gone = w.worktree(6, false); age(gone, 600);
    require_rm(gone);
    const listed = await staleLeftovers(w.paths.root, "stale", { ...w.deps, activeIssues: () => [4] });
    expect(listed.map((l) => `${l.kind}:${l.name}`).sort()).toEqual(["missing-worktree:issue-6", "worktree:issue-5"].sort());
  });

  it("judges an old standing worktree with no running agent stale", async () => {
    const w = await world();
    const standing = put(join(w.paths.worktrees, "standing-x")); age(standing, 600);
    expect((await staleLeftovers(w.paths.root, "stale", w.deps)).map((l) => l.name)).toEqual(["standing-x"]);
  });
});

function require_rm(path: string): void {
  // a worktree directory the chain forgot: gone on disk, still registered
  execRm(path);
}
import { rmSync } from "node:fs";
const execRm = (p: string): void => rmSync(p, { recursive: true, force: true });

describe("holders", () => {
  it("ranks direct entries by inode count and bounds the walk", async () => {
    const w = await world();
    put(join(w.tmp, "big"), 30); put(join(w.tmp, "small"), 2); put(join(w.tmp, "mid"), 10);
    const h = await holders(w.tmp, w.deps);
    expect(h.map((x) => x.name)).toEqual(["big", "mid", "small"]);
    expect(h[0]).toMatchObject({ inodes: 31 });
    expect(HOLDER_WALK_MAX).toBe(500_000);
    put(join(w.paths.runs, "r1"), 5);
    expect((await holders(w.paths.root, w.deps)).map((x) => x.name)[0]).toBe("runs");
  });
});

describe("sweep_volume", () => {
  const ctxOf = (w: Awaited<ReturnType<typeof world>>, lines: Record<string, unknown>[] = []): ActionContext => ({
    paths: w.paths, parameters: undefined as never, log: new ActionLog(w.paths.actionsLog, w.paths), levels: loadActionLevels("agents/actions.yaml"),
    gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} }, now: () => NOW, repoDir: w.pair.repo, serviceLog: (r) => lines.push(r),
  });
  const run = (c: ActionContext, args: Record<string, unknown>, agent = "scheduler") => applyAction(c, { agent, run_id: "tick", kind: "sweep_volume", args, why: "stale leftovers on a checked volume" }, ["sweep_volume"]);

  it("is registered at level 1", () => {
    expect(registryActionsCheck("agents/actions.yaml")).toContain("sweep_volume");
    expect(Object.keys(KINDS)).toContain("sweep_volume");
  });

  it("refuses an unchecked path, a bad age and extra arguments", async () => {
    const w = await world();
    const c = ctxOf(w);
    expect((await run(c, { path: "/etc", age: "stale" })).reason).toContain("checked volume");
    expect((await run(c, { path: w.tmp, age: "now" })).reason).toContain("stale or urgent");
    expect((await run(c, { path: w.tmp, age: "stale", extra: 1 })).status).toBe("refused");
    expect((await run(c, { path: w.tmp })).status).toBe("refused");
  });

  it("removes only the stale root and the unclaimed worktree, and saves the worktree's commits (AC-4)", async () => {
    const w = await world();
    put(join(w.tmp, `${PREFIX}stale`)); age(join(w.tmp, `${PREFIX}stale`), 180);
    put(join(w.tmp, `${PREFIX}fresh`));
    put(join(w.tmp, "claude-1000")); put(join(w.tmp, "node-compile-cache")); writeFileSync(join(w.tmp, "unrelated"), "x");
    const w7 = w.worktree(7, false), w8 = w.worktree(8, true);
    await writeClaim(w.paths, { issue: 7, state: initialChainState(7), worktree: w7, started_at: NOW.toISOString(), last_activity_at: NOW.toISOString(), run_id: null });
    age(w7, 600); age(w8, 600);
    put(join(w.paths.runs, "r1")); put(join(w.paths.usage, "u"), 2);
    const snapshot = () => ({ tmp: readdirSync(w.tmp).sort(), runs: readdirSync(join(w.paths.runs, "r1")), usage: readdirSync(join(w.paths.usage, "u")), cc: readdirSync(join(w.tmp, "claude-1000")), unrelated: readFileSync(join(w.tmp, "unrelated"), "utf8") });
    const lines: Record<string, unknown>[] = [];
    const c = ctxOf(w, lines);
    expect((await run(c, { path: w.tmp, age: "stale" })).status).toBe("applied");
    expect((await run(c, { path: w.paths.root, age: "stale" })).status).toBe("applied");
    expect(existsSync(join(w.tmp, `${PREFIX}stale`))).toBe(false);
    expect(existsSync(join(w.tmp, `${PREFIX}fresh`))).toBe(true);
    expect(snapshot().tmp).toEqual([`${PREFIX}fresh`, "claude-1000", "node-compile-cache", "unrelated"].sort());
    expect(existsSync(w8)).toBe(false);
    expect(existsSync(w7)).toBe(true);
    const patches = readdirSync(w.paths.patchesSweep);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatch(/^issue-8-/);
    expect(readFileSync(join(w.paths.patchesSweep, patches[0]), "utf8")).toContain("unpushed work");
    expect(git(w.pair.repo, "worktree", "list")).not.toContain("issue-8");
    const rows = await readJsonLines<{ status: string; undo: unknown; agent: string }>(w.paths.actionsLog);
    expect(rows.map((r) => [r.status, r.undo, r.agent])).toEqual([["applied", null, "scheduler"], ["applied", null, "scheduler"]]);
    expect(lines.map((l) => l.kind)).toEqual(["disk-sweep", "disk-sweep"]);
    expect(lines[1]).toMatchObject({ removed: ["issue-8"], patches: [join(w.paths.patchesSweep, patches[0])] });
    expect(snapshot().runs).toEqual(["f0", "f1", "f2"]);
  });

  it("at the urgent age takes a root 20 minutes old and leaves one 10 minutes old", async () => {
    const w = await world();
    put(join(w.tmp, `${PREFIX}a`)); age(join(w.tmp, `${PREFIX}a`), 20);
    put(join(w.tmp, `${PREFIX}b`)); age(join(w.tmp, `${PREFIX}b`), 10);
    expect((await run(ctxOf(w), { path: w.tmp, age: "urgent" })).status).toBe("applied");
    expect(readdirSync(w.tmp)).toEqual([`${PREFIX}b`]);
  });
});

describe("sweepVolumes", () => {
  type Space = Record<string, FreeSpace>;
  async function tickWorld(space: () => Space) {
    const w = await world();
    const logs: Record<string, unknown>[] = [], notes: { gate: string; label: string; text: string }[] = [], events: { event: string; payload: Record<string, unknown> }[] = [];
    let now = NOW;
    const memory = newSweepMemory();
    const hook: { notify?: (n: unknown) => Promise<void>; emit?: () => Promise<void> } = {};
    const deps = (): SweepDeps => ({
      memory,
      paths: w.paths, repoDir: w.pair.repo, agentsDir: "agents", now: () => now, gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} },
      freeSpace: async (p) => { const s = space()[p]; if (!s) throw new Error("no such volume"); return s; },
      log: (r) => logs.push(r), notifier: { notify: async (n) => { await hook.notify?.(n); notes.push(n); } }, emitEvent: async (event, payload) => { await hook.emit?.(); events.push({ event, payload: payload as Record<string, unknown> }); },
    });
    return { ...w, logs, notes, events, hook, step: () => sweepVolumes(deps()), advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
  }
  const ample = (w: { tmp: string; paths: StatePaths }): Space => ({ [w.tmp]: { bytes: 20 * 2 ** 30, inodes: 1_000_000 }, [w.paths.root]: { bytes: 20 * 2 ** 30, inodes: 1_000_000 } });

  it("sweeps stale leftovers once an hour and logs nothing when there are none", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space); space = ample(w);
    await w.step();
    expect(w.logs).toEqual([]);
    expect((await readDiskSweep(w.paths))?.volumes.map((v) => v.removed)).toEqual([0, 0]);
    put(join(w.tmp, `${PREFIX}old`)); age(join(w.tmp, `${PREFIX}old`), 180);
    await w.step();
    expect(existsSync(join(w.tmp, `${PREFIX}old`))).toBe(true);
    w.advance(3600_000);
    await w.step();
    expect(existsSync(join(w.tmp, `${PREFIX}old`))).toBe(false);
    expect(w.logs.map((l) => l.kind)).toEqual(["disk-sweep"]);
    expect((await readDiskSweep(w.paths))?.volumes[0]).toMatchObject({ path: w.tmp, removed: 1 });
    expect(w.notes).toEqual([]);
  });

  it("sweeps urgently under a sweep floor, alarms once when still under a launch floor, and recovers", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space);
    put(join(w.tmp, `${PREFIX}fresh`));
    space = { ...ample(w), [w.tmp]: { bytes: 20 * 2 ** 30, inodes: 500 } };
    await w.step();
    expect(w.logs.map((l) => l.kind)).toEqual(["disk-sweep-urgent", "disk-sweep-alarm"]);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toMatchObject({ gate: "infra", label: "disk_full" });
    expect(w.notes[0].text).toContain(w.tmp);
    expect(w.notes[0].text).toContain("500");
    expect(w.notes[0].text).toContain(`${PREFIX}fresh`);
    const queue = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(queue).toHaveLength(1);
    expect(queue[0].finding).toMatchObject({ what: "host volume low after sweep", where: w.tmp, stops_pipeline: true });
    expect(w.events).toHaveLength(1);
    expect(w.events[0].payload).toMatchObject({ kind: "disk_full", path: w.tmp });
    expect("issue" in w.events[0].payload).toBe(false);
    expect((await readDiskSweep(w.paths))?.volumes[0].episode?.alarmed).toBe(true);
    w.advance(60_000);
    await w.step();
    expect(w.notes).toHaveLength(1);
    expect(w.events).toHaveLength(1);
    space = ample(w);
    w.advance(60_000);
    await w.step();
    expect(w.logs.at(-1)).toMatchObject({ kind: "disk-sweep-recovered", path: w.tmp });
    expect((await readDiskSweep(w.paths))?.volumes[0].episode).toBeUndefined();
  });

  it("does the alarm's four parts in order, notification first (spec 114 AC-4)", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space);
    const order: string[] = [];
    w.hook.notify = async () => { order.push("notify"); };
    const log = w.logs.push.bind(w.logs);
    w.logs.push = (...r) => { if (r[0]!.kind === "disk-sweep-alarm") order.push("log"); return log(...r); };
    space = { ...ample(w), [w.tmp]: { bytes: 20 * 2 ** 30, inodes: 500 } };
    await w.step();
    expect(order).toEqual(["notify", "log"]);
    expect(w.events).toHaveLength(1);
  });

  it("with every state write failing: one notification, nothing appended; the first sweep that can write appends one finding and one event (spec 114 AC-4)", async () => {
    const { installEnospc } = await import("./helpers/enospc-fs.mjs");
    let space: Space = {};
    const w = await tickWorld(() => space);
    space = { ...ample(w), [w.paths.root]: { bytes: 1000, inodes: 1_000_000 } };
    const sw = installEnospc(w.paths.root);
    w.hook.emit = async () => { if (sw.on) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); };
    try {
      for (let i = 0; i < 3; i++) { w.advance(60_000); await w.step().catch(() => {}); }
      expect(w.notes).toHaveLength(1);
      expect(w.events).toHaveLength(0);
      expect(existsSync(w.paths.findingsQueue)).toBe(false);
      sw.on = false;
      w.advance(60_000);
      await w.step().catch(() => {});
      w.advance(60_000);
      await w.step().catch(() => {});
      expect(w.notes).toHaveLength(1);
      const queue = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ timestamp: new Date(NOW.getTime() + 60_000).toISOString(), finding: { what: "host volume low after sweep" } });
      expect(w.events.filter((e) => e.event === "infra_alarm")).toHaveLength(1);
    } finally { sw.restore(); }
  });

  it("a notification that rejects with a space failure is sent again by the next sweep and not by the third (spec 114 AC-4)", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space);
    let calls = 0;
    w.hook.notify = async () => { calls++; if (calls === 1) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); };
    space = { ...ample(w), [w.tmp]: { bytes: 20 * 2 ** 30, inodes: 500 } };
    await w.step();
    expect(w.notes).toHaveLength(0);
    w.advance(60_000); await w.step();
    expect(w.notes).toHaveLength(1);
    w.advance(60_000); await w.step();
    expect(calls).toBe(2);
  });

  it("sweeps but does not alarm between the sweep floors and the launch floors", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space);
    put(join(w.tmp, `${PREFIX}old`)); age(join(w.tmp, `${PREFIX}old`), 180);
    space = { ...ample(w), [w.tmp]: { bytes: 20 * 2 ** 30, inodes: 50_000 } };
    await w.step();
    expect(w.logs.map((l) => l.kind)).toEqual(["disk-sweep-urgent", "disk-sweep"]);
    expect(w.notes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it("judges a volume with no inodes on bytes only, and skips one whose space cannot be read", async () => {
    let space: Space = {};
    const w = await tickWorld(() => space);
    space = { [w.tmp]: { bytes: 20 * 2 ** 30, inodes: null } };
    await w.step();
    expect(w.logs).toEqual([{ kind: "host-space-unknown", path: w.paths.root, error: "no such volume" }]);
    expect(w.notes).toEqual([]);
  });
});
