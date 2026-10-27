import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { MAX_CHAIN_FAILURES, Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { writeToken } from "../src/state/token.ts";
import { initialChainState } from "../src/chain/machine.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";

const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
const issue = (n: number, labels = ["validated", "class:product"]) => ({ number: n, title: `i${n}`, body: "Spec: specs/010-thing/spec.md", user: BOT, labels: labels.map((name) => ({ name })), created_at: `2026-10-0${n}T00:00:00Z`, updated_at: "2026-10-12T00:00:00Z" });

function routes(issues: unknown[], labelsNow: Record<number, string[]> = {}): Route[] {
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: issues, headers: pageLink(url, 1, 1) }) },
    { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: issues.length } } } } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/\d+\/timeline$/, reply: () => ({ body: [] }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)$/, reply: (m) => ({ body: { ...issue(Number(m[1])), labels: (labelsNow[Number(m[1])] ?? ["validated", "in-progress"]).map((name) => ({ name })) } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/\d+\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: {} }) },
  ];
}

async function setup(rs: Route[], slots = 1, drive?: NonNullable<ConstructorParameters<typeof Scheduler>[1]>["driveChain"]) {
  const pair = repoPair(withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec }, "specs/010-thing/spec.md"));
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const gh = mockGitHub(rs);
  const notifications: Notification[] = [];
  const started: number[] = [];
  let now = new Date("2026-10-12T12:00:00Z");
  let mono = 0;
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", slots, state_dir: paths.root, poll_interval_s: 5 };
  const deps: SchedulerDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    // the "chain" here is a stub: it records the issue and parks the claim in verify so the test controls time
    adapterFor: () => { throw new Error("not used"); }, systemdScope: false, now: () => now, log: () => {},
    fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
    botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
    fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => mono, requestRestart: () => { started.push(-1); },
  };
  const s = new Scheduler(deps, { driveChain: drive ?? (async (_d, claim) => { started.push(claim.issue); return { ...claim, state: { ...claim.state, stage: "verify" } }; }) });
  return { s, deps, gh, notifications, started, paths, pair, setNow: (d: Date) => { now = d; }, setMono: (m: number) => { mono = m; } };
}

describe("Scheduler.tick", () => {
  it("claims only as many issues as there are slots, in rank order, and labels the rest of the decisions (AC-1, AC-2, AC-5)", async () => {
    const { s, gh, started, paths } = await setup(routes([issue(2), issue(1), issue(3, ["validated"])]));
    const t = await s.tick();
    expect(t.claimed).toEqual([1]);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([1]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([1]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")?.body).toEqual({ labels: ["in-progress"] });
    const t2 = await s.tick();
    expect(t2.claimed).toEqual([]);
  }, 30_000);

  it("claims two with slots: 2", async () => {
    const { s } = await setup(routes([issue(2), issue(1)]), 2);
    expect((await s.tick()).claimed).toEqual([1, 2]);
  }, 30_000);

  it("labels needs-spec and notifies for an issue whose spec is missing (AC-7)", async () => {
    const bad = { ...issue(4), body: "Spec: specs/999-none/spec.md" };
    const { s, gh, notifications } = await setup(routes([bad]));
    await s.tick();
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/4/labels")?.body).toEqual({ labels: ["needs-spec"] });
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/4/comments")?.body).toMatchObject({ body: expect.stringContaining("not found on main") });
    expect(notifications).toEqual([expect.objectContaining({ issue: 4, label: "needs-spec" })]);
  }, 30_000);

  it("does not claim when the issue list is incomplete (review focus 1)", async () => {
    const rs = routes([issue(1)]);
    rs[1] = { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 3 } } } } }) };
    const { s } = await setup(rs);
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(t.errors[0]).toMatch(/incomplete/);
  }, 30_000);

  it("releases a stale claim whose issue lost in-progress on GitHub (review focus 2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("releases a claim with no run and no activity for the liveness window, saving a patch (AC-15)", async () => {
    const { s, deps, paths, pair, gh, setNow } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "implement" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(readdirSync(paths.patches)).toHaveLength(1);
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/labels/in-progress"))).toBeTruthy();
  }, 30_000);

  it("resumes a claim found on disk after a restart (AC-31)", async () => {
    const { s, deps, paths, pair, started } = await setup(routes([]));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([7]);
  }, 30_000);

  it("flags a restart when tools/scheduler changed on main (AC-17)", async () => {
    const { s, deps, started } = await setup(routes([]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(started).toEqual([-1]);
  }, 30_000);

  it("abandons a chain whose driveChain rejects MAX_CHAIN_FAILURES times instead of holding its slot (ruling 7b)", async () => {
    expect(MAX_CHAIN_FAILURES).toBe(3);
    const errors: Record<string, unknown>[] = [];
    let calls = 0;
    const { s, deps, paths, pair, gh } = await setup(routes([]), 1, async () => { calls++; throw new Error("boom"); });
    deps.log = (rec) => { if (rec.kind === "error") errors.push(rec); };
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    for (let i = 1; i <= 3; i++) {
      const t = await s.tick();
      expect(t.released).toEqual([]);
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toHaveLength(i);
      expect(errors[i - 1]).toMatchObject({ kind: "error", issue: 7, error: "boom" });
    }
    const t4 = await s.tick();
    expect(calls).toBe(3);
    expect(t4.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url === "/repos/o/r/issues/7/labels/in-progress")).toBeTruthy();
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"chain-abandoned"');
  }, 30_000);

  it("records a freshness error and still lists and claims when fast-forward fails (ruling 7c)", async () => {
    const { s, deps } = await setup(routes([issue(1)]));
    deps.fastForward = async () => { throw new Error("not a fast-forward"); };
    const t = await s.tick();
    expect(t.errors[0]).toMatch(/freshness/);
    expect(t.claimed).toEqual([1]);
  }, 30_000);
  it("writes the claim file before the claim label, so a failed claim leaves no orphaned in-progress (review fix 1)", async () => {
    const { s, gh, paths } = await setup(routes([issue(1)]));
    rmSync(paths.worktrees, { recursive: true, force: true });
    writeFileSync(paths.worktrees, "not a directory\n");
    const t = await s.tick();
    expect(t.errors[0]).toMatch(/claim 1/);
    expect(t.claimed).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")).toBeUndefined();
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("claims nothing once a restart is pending and requests the restart from the idle tick (review fix 2, AC-17)", async () => {
    const { s, deps, gh, started } = await setup(routes([issue(1)]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(t.claimed).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")).toBeUndefined();
    expect(started).toContain(-1);
  }, 30_000);

  it("refreshes token.json at the start of a tick when it expires within 5 minutes (I3)", async () => {
    const { s, deps, paths } = await setup(routes([]));
    let refreshes = 0;
    deps.refreshToken = async () => { refreshes++; };
    await writeToken(paths, { token: "ghs_x", expires_at: new Date(deps.now().getTime() + 2 * 60_000).toISOString() });
    await s.tick();
    expect(refreshes).toBe(1);
  }, 30_000);
});

describe("Scheduler.run", () => {
  it("ticks immediately, again after a detected sleep, and writes the stopped trailer on stop (AC-4, AC-31)", async () => {
    const { s, deps, paths, setNow, setMono } = await setup(routes([]));
    let ticks = 0;
    const origTick = s.tick.bind(s);
    s.tick = async () => { ticks++; return origTick(); };
    const sleeps: number[] = [];
    let refreshes = 0;
    deps.refreshToken = async () => { refreshes++; };
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) { setNow(new Date("2026-10-12T13:00:00Z")); setMono(1000); } // wall jumped an hour, monotonic 1 s: slept
      if (sleeps.length === 2) s.stop("SIGTERM");
    };
    await s.run();
    expect(ticks).toBe(2);
    expect(refreshes).toBe(1);
    const log = readFileSync(paths.serviceLog, "utf8");
    expect(log).toContain('"kind":"resumed"');
    expect(log.trim().split("\n").pop()).toContain('"kind":"stopped"');
  }, 30_000);
});
