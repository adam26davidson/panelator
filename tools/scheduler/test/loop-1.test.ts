import { openIndex } from "../src/events/index.ts";
import { record as recordEvent } from "../src/events/store.ts";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { MAX_CHAIN_FAILURES, Scheduler } from "../src/service/loop.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { writeToken } from "../src/state/token.ts";
import { HISTORY_ENTRY_MAX, initialChainState, ledgerOf } from "../src/chain/machine.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { pageLink } from "./helpers/mock-github.ts";
import { git } from "./helpers/repo-pair.ts";
import { issue, routes, setup, claimedPayloads, staleRows } from "./helpers/loop-harness.ts";

describe("Scheduler.tick", () => {
  it("records a completed main check once across two service instances", async () => {
    const { s, deps, paths, gh, watch } = await setup([
      ...routes([]),
      { method: "GET", path: /^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 42, name: "test", status: "completed", conclusion: "success" }] } }) },
    ]);
    const { loadRegistry } = await import("../src/standing/registry.ts");
    const { EVENT_NAMES } = await import("../src/standing/events.ts");
    const { registryActionsCheck } = await import("../src/actions/index.ts");
    deps.registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
    // The main watcher runs while an agent subscribes to `ci_failure_main` (spec 008).
    for (const def of Object.values(deps.registry)) def.trigger = def.name === "action-audit" ? { events: ["ci_failure_main"] } : def.trigger;
    deps.cfg.required_checks = ["test"];
    await s.tick(); s.stop("restart test");
    const restarted = watch(new Scheduler(deps));
    await restarted.tick(); restarted.stop("test done");
    expect(gh.calls.filter(c => c.url.includes("/check-runs"))).toHaveLength(2);
    const db = openIndex(paths);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'ci.check' AND json_extract(payload, '$.check') = 'test'").get()).toEqual({ n: 1 });
    db.close(); expect(gh.unmatched).toEqual([]);
  }, 30000);
  it('a due standing agent takes the free slot before shortlist and never overlaps itself',async()=>{
    const {s,deps,paths}=await setup(routes([issue(1)]));
    const {loadRegistry}=await import('../src/standing/registry.ts');
    const {EVENT_NAMES}=await import('../src/standing/events.ts');
    const {registryActionsCheck}=await import('../src/actions/index.ts');
    const {loadParameterDefinitions}=await import('../src/parameters/definitions.ts');
    const {ParameterStore}=await import('../src/parameters/store.ts');
    const {initializeAgents,readAgentState,writeAgentState}=await import('../src/standing/state.ts');
    const all=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,registryActionsCheck(join(agentsDir,'actions.yaml')));
    deps.registry={'action-audit':all['action-audit']};deps.parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),deps.cfg,deps.registry));
    await initializeAgents(paths,deps.registry,deps.parameters,deps.now());
    const state=(await readAgentState(paths,'action-audit'))!;await writeAgentState(paths,'action-audit',{...state,next_run:deps.now().toISOString()});
    let calls=0,finish!:()=>void;const pending=new Promise<void>(r=>{finish=r;});deps.runStanding=async()=>{calls++;await pending;};
    expect((await s.tick()).claimed).toEqual([]);expect(s.active).toBe(1);expect((await s.tick()).claimed).toEqual([]);expect(calls).toBe(1);
    finish();await new Promise(r=>setTimeout(r,20));expect(s.active).toBe(0);
  },30000);
  it("claims only as many issues as there are slots, in rank order, and labels the rest of the decisions (AC-1, AC-2, AC-5)", async () => {
    const { s, gh, started, paths } = await setup(routes([issue(2), issue(1), issue(3, ["validated"])]));
    const t = await s.tick();
    expect(t.held).toBe(0);
    // No class/spec is system work, preferred at the initial 0.75 work share.
    expect(t.claimed).toEqual([3]);
    for (let w = 0; w < 200 && (started.length === 0 || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25));
    expect(started).toEqual([3]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([3]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/3/labels")?.body).toEqual({ labels: ["in-progress"] });
    const t2 = await s.tick();
    expect(t2.claimed).toEqual([]);
  }, 30_000);

  it("records issue.eligible with stops_pipeline for an issue with and without the label (spec 063 AC-5)", async () => {
    const { s, paths } = await setup(routes([issue(2), issue(1, ["validated", "class:product", "stops-pipeline"])]));
    await s.tick();
    const db = openIndex(paths);
    const rows = db.prepare("SELECT issue, payload FROM events WHERE kind = 'issue.eligible' ORDER BY issue").all() as { issue: number; payload: string }[];
    db.close();
    expect(rows.map((r) => [r.issue, JSON.parse(r.payload)])).toEqual([
      [1, expect.objectContaining({ rank: 0, stops_pipeline: true, created_at: "2026-10-01T00:00:00Z" })],
      [2, expect.objectContaining({ rank: 1, stops_pipeline: false, created_at: "2026-10-02T00:00:00Z" })],
    ]);
  }, 30_000);

  it("writes a new claim with no slot field (spec 034 AC-1)", async () => {
    const { s, paths } = await setup(routes([issue(3, ["validated"])]));
    expect((await s.tick()).claimed).toEqual([3]);
    const parsed = JSON.parse(readFileSync(join(paths.claims, "3.json"), "utf8"));
    expect("slot" in parsed).toBe(false);
    for (const k of ["issue", "state", "worktree", "started_at", "last_activity_at", "run_id"]) expect(k in parsed).toBe(true);
    expect(claimedPayloads(paths, 3)).toStrictEqual([{}]); // spec 095 AC-1
  }, 30_000);

  it("claims two with slots: 2", async () => {
    const { s } = await setup(routes([issue(2), issue(1)]), 2);
    expect((await s.tick()).claimed).toEqual([1, 2]);
  }, 30_000);

  it("claims an issue whose spec is missing, to start at the spec stage, with no label but in-progress (spec 006 AC-19)", async () => {
    const bad = { ...issue(4), body: "Spec: specs/999-none/spec.md" };
    const { s, gh, paths, notifications } = await setup(routes([bad]));
    const t = await s.tick();
    expect(t.claimed).toEqual([4]);
    const [c] = await listClaims(paths);
    expect(c.state.specProblem).toMatch(/not found on main/);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => c.body)).toEqual([{ labels: ["in-progress"] }]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBeUndefined();
    expect(notifications).toEqual([]);
  }, 30_000);

  it("seeds a new claim from the issue's escalation ledger (spec 006 AC-7)", async () => {
    const { s, paths } = await setup(routes([issue(7)]));
    await writeLedger(paths, 7, ledgerOf({ ...initialChainState(7), rescues: 1, history: ["plan failed"] }));
    expect((await s.tick()).claimed).toEqual([7]);
    const [c] = await listClaims(paths);
    expect(c.state.rescues).toBe(1);
    expect(c.state.history).toEqual(["plan failed"]);
  }, 30_000);

  const uiSpec = () => readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8");
  const labelPosts = (gh: { calls: { method: string; url: string; body?: unknown }[] }) => gh.calls.filter((c) => c.method === "POST" && /\/labels$/.test(c.url));

  it("claims a UI issue without design artifacts for the design stage and applies no needs-design-stage label (spec 029 AC-1)", async () => {
    const { s, gh, notifications, paths } = await setup(routes([issue(4)]), 1, undefined, uiSpec());
    const t = await s.tick();
    expect(t.claimed).toEqual([4]);
    const [c] = await listClaims(paths);
    expect(c.state.designProblem).toMatch(/editor-empty\.mobile\.png/);
    expect(labelPosts(gh).map((x) => x.body)).toEqual([{ labels: ["in-progress"] }]);
    expect(notifications).toEqual([]);
  }, 30_000);

  it("removes needs-design-stage from a parked issue once, with one comment, and claims it (spec 029 AC-8)", async () => {
    const parked = issue(4, ["validated", "class:product", "needs-design-stage"]);
    const rs = routes([parked]);
    const { s, gh, paths, deps, watch } = await setup(rs, 1, undefined, uiSpec());
    const t = await s.tick();
    expect(gh.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["/repos/o/r/issues/4/labels/needs-design-stage"]);
    expect(gh.calls.filter((c) => c.url === "/repos/o/r/issues/4/comments" && c.method === "POST")).toHaveLength(1);
    expect(JSON.parse(readFileSync(paths.designRelabelled, "utf8"))).toEqual([4]);
    expect(t.claimed).toEqual([4]);
    expect(labelPosts(gh).map((x) => x.body)).toEqual([{ labels: ["in-progress"] }]);

    // A restart over the same state directory, with the label back on GitHub: nothing is removed or posted again.
    rs[1] = { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: [parked], headers: pageLink(url, 1, 1) }) };
    for (const c of await listClaims(paths)) await rm(join(paths.claims, `${c.issue}.json`), { force: true });
    gh.calls.length = 0;
    const again = watch(new Scheduler(deps, { driveChain: async (_d, claim) => claim }));
    await again.tick();
    expect(gh.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(gh.calls.filter((c) => c.url === "/repos/o/r/issues/4/comments" && c.method === "POST")).toEqual([]);
  }, 30_000);

  it("leaves an issue without the label alone and never creates the design state file (spec 029 AC-8)", async () => {
    const { s, gh, paths } = await setup(routes([issue(4)]), 1, undefined, uiSpec());
    await s.tick();
    expect(gh.calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(existsSync(paths.designRelabelled)).toBe(false);
  }, 30_000);

  it("does not claim when the issue list is incomplete (review focus 1)", async () => {
    const rs = routes([issue(1)]);
    rs[2] = { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 3 } } } } }) };
    const { s, allowErrors } = await setup(rs);
    allowErrors(/^issue list incomplete/);
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(t.errors[0]).toMatch(/incomplete/);
  }, 30_000);

  it("releases a stale claim whose issue lost in-progress on GitHub (review focus 2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await recordEvent(paths, "issue.claimed", deps.now(), {}, { issue: 7 });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    // Spec 096 AC-1: the drop records the release of the claim the store holds open.
    expect(staleRows(paths)).toEqual([
      ["issue.claimed", 7, {}],
      ["issue.released", 7, { reason: "stopped" }],
    ]);
  }, 30_000);

  it("records nothing for a stale claim whose issue.claimed was never recorded (spec 096 AC-2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    expect(staleRows(paths)).toEqual([]);
  }, 30_000);

  it("records nothing for a stale claim already closed by an earlier release (spec 096 AC-2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await recordEvent(paths, "issue.claimed", deps.now(), {}, { issue: 7 });
    await recordEvent(paths, "issue.released", deps.now(), { reason: "done" }, { issue: 7 });
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    expect(staleRows(paths)).toEqual([
      ["issue.claimed", 7, {}],
      ["issue.released", 7, { reason: "done" }],
    ]);
  }, 30_000);

  it("releases a claim with no run and no activity for the liveness window, saving a patch (AC-15)", async () => {
    const { s, deps, paths, pair, gh, setNow } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "implement" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(readdirSync(paths.patches)).toHaveLength(1);
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/labels/in-progress"))).toBeTruthy();
    // Spec 012 AC-2: the expiry bypasses step(), and still records the chain's leaving implement.
    const db = openIndex(paths);
    const rows = db.prepare("SELECT kind, issue, payload FROM events WHERE kind IN ('chain.transition', 'issue.released') ORDER BY at, rowid").all() as { kind: string; issue: number; payload: string }[];
    db.close();
    expect(rows.map((r) => [r.kind, r.issue, JSON.parse(r.payload)])).toEqual([
      ["chain.transition", 7, expect.objectContaining({ from: "implement", to: "released", event: "liveness_expired", track: "issue" })],
      ["issue.released", 7, { reason: "stopped" }],
    ]);
  }, 30_000);

  it("does not expire or start a chain postponed to a quota reset still ahead (spec 013 AC-5)", async () => {
    const { s, paths, pair, setNow, started } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "waiting", resumeStage: "plan", postponedUntil: "2026-10-12T16:10:00Z" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([]);
    expect(started).toEqual([]);
    expect(await listClaims(paths)).toHaveLength(1);
  }, 30_000);

  it("resumes a claim found on disk after a restart (AC-31)", async () => {
    const { s, deps, paths, pair, started } = await setup(routes([]));
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await s.tick();
    for (let w = 0; w < 200 && (started.length === 0 || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25));
    expect(started).toEqual([7]);
  }, 30_000);

  it("flags a restart when tools/scheduler changed on main (AC-17)", async () => {
    const { s, deps, started } = await setup(routes([]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(started).toEqual([-1]);
  }, 30_000);

  it("releases a chain whose driveChain rejects MAX_CHAIN_FAILURES times with a chain_error: the error, a finding, the ledger (ruling 7b, C7)", async () => {
    expect(MAX_CHAIN_FAILURES).toBe(3);
    const errors: Record<string, unknown>[] = [];
    let calls = 0;
    const { s, deps, paths, pair, gh } = await setup(routes([]), 1, async () => { calls++; throw new Error("boom"); });
    deps.log = (rec) => { if (rec.kind === "error") errors.push(rec); };
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    for (let i = 1; i <= 3; i++) {
      const t = await s.tick();
      expect(t.released).toEqual([]);
      // The error is logged before the failure count is written and the chain leaves the active set: wait for both.
      for (let w = 0; w < 200 && (errors.length < i || s.active > 0); w++) await new Promise((r) => setTimeout(r, 25));
      expect(errors).toHaveLength(i);
      expect(errors[i - 1]).toMatchObject({ kind: "error", issue: 7, error: "boom" });
    }
    const t4 = await s.tick();
    expect(calls).toBe(3);
    expect(t4.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url === "/repos/o/r/issues/7/labels/in-progress")).toBeTruthy();
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"chain-error"');
    // C7: the comment carries the real error, a finding is queued, and the ledger counts the release.
    const comment = gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")!.body as { body: string };
    expect(comment.body).toContain("boom");
    expect(readFileSync(paths.findingsQueue, "utf8")).toContain("chain released after repeated scheduler errors");
    const ledger = JSON.parse(readFileSync(join(paths.escalations, "7.json"), "utf8"));
    expect(ledger).toMatchObject({ chainErrors: 1, chainFailures: null });
    expect(ledger.history.at(-1)).toBe("chain error in verify (counted): boom");
  }, 30_000);

  it("keeps the failure count across a restart: a new Scheduler reads it from the claim (C7)", async () => {
    let calls = 0;
    const { deps, paths, pair, watch } = await setup(routes([]), 1, async () => { calls++; throw new Error("boom"); });
    await writeClaim(paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    for (let i = 0; i < 2; i++) {
      await watch(new Scheduler(deps, { driveChain: async () => { calls++; throw new Error(`boom ${i}`); } })).tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await listClaims(paths))[0].state.chainFailures).toEqual({ count: 2, last: "boom 1" });
    expect(JSON.parse(readFileSync(join(paths.escalations, "7.json"), "utf8")).chainFailures).toEqual({ count: 2, last: "boom 1" });
    // A drive that returns resets the count.
    await watch(new Scheduler(deps, { driveChain: async (_d, c) => c })).tick();
    await new Promise((r) => setTimeout(r, 100));
    expect((await listClaims(paths))[0].state.chainFailures).toBeNull();
    expect(calls).toBe(2);
    // Tm6: the error kept is clipped like a history entry.
    await watch(new Scheduler(deps, { driveChain: async () => { throw new Error("x".repeat(HISTORY_ENTRY_MAX + 50)); } })).tick();
    await new Promise((r) => setTimeout(r, 100));
    expect((await listClaims(paths))[0].state.chainFailures?.last).toHaveLength(HISTORY_ENTRY_MAX);
  }, 30_000);

  it("scans for children on the first tick, on a move of main, and only then (spec 031 AC-3)", async () => {
    const { s, deps } = await setup(routes([]));
    let scans = 0;
    deps.scanChildren = async () => { scans++; };
    await s.tick();
    expect(scans).toBe(1); // first tick, main did not move
    await s.tick();
    expect(scans).toBe(1); // not moved, not first
    deps.fastForward = async () => ({ moved: true, changedPaths: ["docs/designs/x.md"] });
    await s.tick();
    expect(scans).toBe(2);
  }, 30_000);

  it("records a failed children scan and still completes the tick (spec 031 AC-3)", async () => {
    const { s, deps, paths, allowErrors } = await setup(routes([issue(1)]));
    allowErrors(/^children scan: /);
    deps.scanChildren = async () => { throw new Error("github down"); };
    const t = await s.tick();
    expect(t.errors).toContain("children scan: github down");
    expect(t.claimed).toEqual([1]);
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"children-scan-failed"');
  }, 30_000);

  it("does not scan when the fast-forward failed (spec 031 AC-3)", async () => {
    const { s, deps, allowErrors } = await setup(routes([]));
    allowErrors(/^freshness: /);
    let scans = 0;
    deps.scanChildren = async () => { scans++; };
    deps.fastForward = async () => { throw new Error("not a fast-forward"); };
    const t = await s.tick();
    expect(t.errors).toEqual([expect.stringMatching(/^freshness: /)]);
    expect(scans).toBe(0);
  }, 30_000);

  it("records a freshness error and still lists and claims when fast-forward fails (ruling 7c)", async () => {
    const { s, deps, allowErrors } = await setup(routes([issue(1)]));
    allowErrors(/^freshness: /);
    deps.fastForward = async () => { throw new Error("not a fast-forward"); };
    const t = await s.tick();
    expect(t.errors[0]).toMatch(/freshness/);
    expect(t.claimed).toEqual([1]);
  }, 30_000);
  it("writes the claim file before the claim label, so a failed claim leaves no orphaned in-progress (review fix 1)", async () => {
    const { s, gh, paths, allowErrors } = await setup(routes([issue(1)]));
    allowErrors(/^claim 1: /);
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
