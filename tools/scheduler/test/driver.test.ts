import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../src/adapters/types.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { driveChain, step, type DriverDeps } from "../src/chain/driver.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { ensureWorktree } from "../src/runner/worktree.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, readClaim, writeClaim, type Claim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, type Route } from "./helpers/mock-github.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl");
const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");

/** One fake adapter that answers per stage from a script of results. */
function scriptedAdapter(results: Record<string, unknown[]>): Adapter & { ran: string[] } {
  const ran: string[] = [];
  return {
    harness: "fake", ran,
    buildCommand(run) {
      ran.push(`${run.stage}:${run.model}`);
      const r = results[run.stage]?.shift();
      const argv = [process.execPath, script, events, run.resultPath, r === undefined ? "1" : "0", "0"];
      if (r !== undefined) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, timedOut) => timedOut ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null }
      : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : { outcome: "failed", reason: `exit ${exit}`, apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

function ghRoutes(sha: string, over: { checks?: unknown[]; mergeable?: boolean; merged?: boolean; issueLabels?: string[]; prHead?: string; headRef?: string } = {}): Route[] {
  const labels = [...["validated", "in-progress", "class:product"], ...(over.issueLabels ?? [])].map((name) => ({ name }));
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: { number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", labels, updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/9$/, reply: () => ({ body: { number: 9, title: "PR", body: "", labels: [], updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: () => ({ status: 201, body: {} }) },
    { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, base: { ref: "main" }, head: { ref: over.headRef ?? "issue-7", sha: over.prHead ?? sha }, html_url: "u", mergeable: over.mergeable ?? true, mergeable_state: "clean", merged: over.merged ?? false, state: over.merged ? "closed" : "open" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: over.checks ?? [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
  ];
}

/** `results` and `routes` take the worktree's real HEAD, which the PR binding (AC-10/AC-11) checks against; `prepare` runs before it is read. */
async function setup(
  results: (sha: string) => Record<string, unknown[]>,
  routes: (sha: string) => Route[] = (sha) => ghRoutes(sha),
  prepare: (pair: ReturnType<typeof repoPair>, worktree: string) => void = () => {},
) {
  const pair = repoPair({ "a.txt": "a\n", "specs/010-thing/spec.md": spec });
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const wt = await ensureWorktree(pair.repo, pair.worktrees, 7);
  prepare(pair, wt.path);
  const sha = git(wt.path, "rev-parse", "HEAD").trim();
  const gh = mockGitHub(routes(sha));
  const notifications: Notification[] = [];
  const adapter = scriptedAdapter(results(sha));
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root };
  const deps: DriverDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: () => {}, fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
  };
  const claim: Claim = { issue: 7, slot: 0, state: initialChainState(7), worktree: wt.path, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null };
  await writeClaim(paths, claim);
  return { deps, claim, gh, notifications, adapter, pair, paths, sha };
}

const plan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
const impl = (sha: string) => ({ pr_number: 9, head_sha: sha, tasks_done: ["T1"] });
const approve = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };

/** A stand-in for systemd-run, written to tmp: drops the scope flags and runs the command after `--`. */
function fakeSystemdRun(dir: string): string {
  const p = join(dir, "fake-systemd-run.mjs");
  writeFileSync(p, [
    `#!${process.execPath}`,
    `import { spawn } from "node:child_process";`,
    `const argv = process.argv.slice(process.argv.indexOf("--") + 1);`,
    `spawn(argv[0], argv.slice(1), { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));`,
  ].join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

/** One commit on the issue branch and a conflicting commit on main, both touching a.txt. */
function conflicting(pair: ReturnType<typeof repoPair>, worktree: string): void {
  writeFileSync(join(worktree, "a.txt"), "worktree\n");
  git(worktree, "commit", "-q", "-am", "worktree change");
  writeFileSync(join(pair.repo, "a.txt"), "main\n");
  git(pair.repo, "commit", "-q", "-am", "main change");
  git(pair.repo, "push", "-q", "origin", "main");
}

describe("driveChain", () => {
  it("runs a full chain to done, applying labels and recording a merge (AC-1, AC-3, AC-14)", async () => {
    const { deps, claim, gh, adapter, paths, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }));
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("done");
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5", "review:claude-fable-5-1"]);
    expect(gh.calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "squash", sha });
    expect(gh.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toContain("/repos/o/r/issues/7/labels/in-progress");
    expect(await listClaims(paths)).toEqual([]);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"cls":"feature"');
    // The review prompt gets the PR head's check conclusions, so it never tries to run the suite itself.
    const reviewRun = readdirSync(paths.runs).find((d) => d.startsWith("7-review-"))!;
    const reviewInput = JSON.parse(readFileSync(join(paths.runs, reviewRun, "input.json"), "utf8"));
    expect(reviewInput.ci).toBe(`All required checks passed for ${sha}.\ntest: success`);
  }, 60_000);

  it("posts questions, labels needs-clarification and releases on spec_gap (AC-9)", async () => {
    const { deps, claim, gh, notifications, paths } = await setup(() => ({ plan: [{ verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which port?"] }] }));
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("released");
    expect(gh.calls.filter((c) => c.url.endsWith("/comments"))).toHaveLength(1);
    expect(gh.calls.find((c) => c.url.endsWith("/comments"))?.body).toMatchObject({ body: expect.stringContaining("Which port?") });
    expect(gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/labels"))?.body).toEqual({ labels: ["needs-clarification"] });
    expect(notifications).toEqual([expect.objectContaining({ issue: 7, gate: "ready", label: "needs-clarification" })]);
    expect(await listClaims(paths)).toEqual([]);
  }, 60_000);

  it("waits on pending checks and starts fix with the failing log (AC-14)", async () => {
    const { deps, claim, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)] }), (sha) => ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] }));
    const r = await driveChain(deps, claim, () => false);
    expect(r.state.stage).toBe("verify");
    deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: mockGitHub(ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }] })).fetch } }), "o/r");
    const s = await step(deps, r);
    expect(s.claim.state.stage).toBe("fix");
    expect(s.claim.state.pendingFixInput).toMatch(/check failed/);
  }, 60_000);

  it("retries a failed plan once, then needs-human with a notification", async () => {
    const { deps, claim, notifications, adapter } = await setup(() => ({ plan: [] }));
    const final = await driveChain(deps, claim, () => false);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(final.state.stage).toBe("needs-human");
    expect(notifications[0]).toMatchObject({ gate: "plan", label: "needs-human" });
  }, 60_000);

  it("stops between stages when asked to stop (AC-31)", async () => {
    const { deps, claim } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }));
    let calls = 0;
    const r = await driveChain(deps, claim, () => ++calls > 2);
    expect(r.state.stage).toBe("implement");
  }, 60_000);

  it("refuses an implement result whose head_sha is not the worktree HEAD and PR head, retrying then needs-human (AC-10, AC-11)", async () => {
    const bad = { pr_number: 9, head_sha: "a".repeat(40), tasks_done: ["T1"] };
    const { deps, claim, gh, adapter, notifications } = await setup(() => ({ plan: [plan], implement: [bad, { ...bad }] }));
    let c = (await step(deps, claim)).claim;
    expect(c.state.stage).toBe("plan");
    c = (await step(deps, c)).claim;
    expect(c.state.stage).toBe("implement");
    c = (await step(deps, c)).claim;
    expect(c.state.stage).toBe("implement");
    expect(c.state.attempt).toBe(2);
    expect(c.state.pr).toBeNull();
    const final = await driveChain(deps, c, () => false);
    expect(final.state.stage).toBe("needs-human");
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5", "implement:claude-sonnet-5-5"]);
    expect(notifications[0]).toMatchObject({ gate: "implement", label: "needs-human", text: expect.stringContaining("result: pr mismatch") });
    expect(gh.calls.find((call) => call.method === "PUT")).toBeUndefined();
  }, 60_000);

  it("refuses to merge while the issue carries security-review, ending in needs-human (AC-11)", async () => {
    const { deps, claim, gh, notifications, paths } = await setup(
      (sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }),
      (sha) => ghRoutes(sha, { issueLabels: ["security-review"] }),
    );
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("needs-human");
    expect(final.state.securityFinding).toBe(true);
    expect(gh.calls.find((c) => c.method === "PUT")).toBeUndefined();
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => c.body)).toContainEqual({ labels: ["security-review", "needs-human"] });
    expect(notifications).toEqual([expect.objectContaining({ gate: "sensitive-path", label: "needs-human" })]);
    expect(await listClaims(paths)).toEqual([]);
  }, 60_000);

  it("persists a cleared run_id when a stage throws, so liveness can still expire the claim (AC-15)", async () => {
    const { deps, claim, paths } = await setup(() => ({}));
    const planning = (await step(deps, claim)).claim;
    expect(planning.state.stage).toBe("plan");
    const broken = scriptedAdapter({});
    deps.adapterFor = () => ({ ...broken, buildCommand: () => { throw new Error("boom"); } });
    await expect(step(deps, planning)).rejects.toThrow("boom");
    expect((await readClaim(paths, 7))?.run_id).toBeNull();
  }, 60_000);

  it("treats an already merged PR as merged without another merge PUT (crash after merge)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, { merged: true }));
    const atMerge: Claim = { ...claim, state: { ...claim.state, stage: "merge", pr: { number: 9, head_sha: sha } } };
    await writeClaim(paths, atMerge);
    const r = await step(deps, atMerge);
    expect(r.claim.state.stage).toBe("done");
    expect(r.status).toBe("ended");
    expect(gh.calls.find((c) => c.method === "PUT")).toBeUndefined();
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"pr":9');
  }, 60_000);

  it("runs one fix after a rebase conflict without rebasing again, and reaches verify (C1, AC-16)", async () => {
    const { deps, claim, adapter, paths, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), undefined, conflicting);
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state.stage).toBe("fix");
    expect(r.claim.state.conflictPending).toBe(true);
    r = await step(deps, r.claim);
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5"]);
    expect(r.claim.state.stage).toBe("verify");
    expect(r.claim.state.conflictPending).toBe(false);
    const fixRun = readdirSync(paths.runs).find((d) => d.startsWith("7-fix-"))!;
    const input = JSON.parse(readFileSync(join(paths.runs, fixRun, "input.json"), "utf8"));
    expect(input.fix_input).toMatch(/^Rebase this branch onto origin\/main and resolve the conflicts before addressing the items below\.\nRebase onto main conflicted:/);
  }, 60_000);

  it("starts plan from origin/main even when the worktree carries a stray commit (C1)", async () => {
    const { deps, claim, adapter, pair } = await setup(() => ({ plan: [plan] }), undefined, (_pair, wt) => {
      writeFileSync(join(wt, "stray.txt"), "stray\n");
      git(wt, "add", "stray.txt");
      git(wt, "commit", "-q", "-m", "stray");
    });
    let c = (await step(deps, claim)).claim;
    c = (await step(deps, c)).claim;
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(c.state.stage).toBe("implement");
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(git(pair.repo, "rev-parse", "origin/main").trim());
  }, 60_000);

  it("goes back to verify with the new head instead of merging when the PR head moved after review (C2)", async () => {
    const moved = "f".repeat(40);
    const { deps, claim, gh, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, { prHead: moved }));
    const atMerge: Claim = { ...claim, state: { ...claim.state, stage: "merge", pr: { number: 9, head_sha: sha } } };
    await writeClaim(paths, atMerge);
    const r = await step(deps, atMerge);
    expect(r.claim.state.stage).toBe("verify");
    expect(r.claim.state.pr).toEqual({ number: 9, head_sha: moved });
    expect(gh.calls.find((c) => c.method === "PUT")).toBeUndefined();
  }, 60_000);

  it("syncs the worktree to the moved PR head before verify, so sensitivity is judged on the pushed diff (R1)", async () => {
    const over: { prHead?: string } = {};
    const { deps, claim, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, over), (pair, worktree) => {
      // The PR branch is on origin; a commit touching a sensitive path is pushed to it from another clone.
      git(worktree, "push", "-q", "-u", "origin", "issue-7");
      const other = join(pair.root, "other");
      git(pair.root, "clone", "-q", "-b", "issue-7", pair.origin, other);
      mkdirSync(join(other, "backend", "api", "auth"), { recursive: true });
      writeFileSync(join(other, "backend", "api", "auth", "token.rs"), "// pushed from elsewhere\n");
      git(other, "add", "-A");
      git(other, "commit", "-q", "-m", "auth change");
      git(other, "push", "-q", "origin", "issue-7");
      over.prHead = git(other, "rev-parse", "HEAD").trim();
    });
    const atMerge: Claim = { ...claim, state: { ...claim.state, stage: "merge", pr: { number: 9, head_sha: sha } } };
    await writeClaim(paths, atMerge);
    const r1 = await step(deps, atMerge);
    expect(r1.claim.state.stage).toBe("verify");
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(sha);
    const r2 = await step(deps, r1.claim);
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(over.prHead);
    expect(r2.claim.state.sensitive).toBe(true);
    expect(r2.claim.state.stage).toBe("review");
  }, 60_000);

  it("refuses an implement result whose PR is not issue-7 into main (I1, AC-10)", async () => {
    const { deps, claim, notifications, gh } = await setup((sha) => ({ plan: [plan], implement: [impl(sha), impl(sha)] }), (sha) => ghRoutes(sha, { headRef: "other" }));
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("needs-human");
    expect(notifications[0]).toMatchObject({ gate: "implement", text: expect.stringContaining("result: pr mismatch") });
    expect(gh.calls.find((c) => c.method === "PUT")).toBeUndefined();
  }, 60_000);

  it("waits without running anything while the claim's stage scope is still active (I2)", async () => {
    const { deps, claim, adapter, paths } = await setup(() => ({ plan: [plan] }));
    const asked: string[] = [];
    const stopped: string[] = [];
    deps.systemdScope = true;
    deps.unitActive = async (u) => { asked.push(u); return true; };
    deps.stopUnit = async (u) => { stopped.push(u); };
    const running: Claim = { ...claim, run_id: "7-plan-1-20261012T120000", state: { ...claim.state, stage: "plan" } };
    await writeClaim(paths, running);
    const r = await step(deps, running);
    expect(r.status).toBe("waiting");
    expect(r.claim.state.stage).toBe("plan");
    expect(asked).toEqual(["panelator-stage-7-plan-1-20261012T120000"]);
    expect(adapter.ran).toEqual([]);
    expect(stopped).toEqual([]);
    expect((await readClaim(paths, 7))?.run_id).toBe("7-plan-1-20261012T120000");
  }, 60_000);

  it("persists the real run id and stops the stage scope after a timeout (I2, AC-23)", async () => {
    const { deps, claim, paths, pair } = await setup(() => ({}));
    const stopped: string[] = [];
    const seenRunIds: (string | null)[] = [];
    deps.systemdScope = true;
    deps.systemdRunBin = fakeSystemdRun(pair.root);
    deps.now = () => new Date("2026-10-12T12:00:00Z");
    deps.stopUnit = async (u) => { stopped.push(u); seenRunIds.push((await readClaim(paths, 7))?.run_id ?? null); };
    deps.stages = { ...deps.stages, plan: { ...deps.stages.plan, bounds: { ...deps.stages.plan.bounds, timeout_min: 1 / 60 } } };
    deps.adapterFor = () => ({
      harness: "fake",
      buildCommand: (run) => ({ argv: [process.execPath, script, events, run.resultPath, "0", "30000"], env: {} }),
      judge: (_e, _x, timedOut) => timedOut ? { outcome: "timeout", reason: "stage timeout", apiErrorStatus: null, finalText: null } : { outcome: "failed", reason: "x", apiErrorStatus: null, finalText: null },
      usage: () => ({ cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0, tool_calls: 0 }),
    });
    const planning = (await step(deps, claim)).claim;
    await step(deps, planning);
    expect(stopped[0]).toBe("panelator-stage-7-plan-1-20261012T120000");
    expect(seenRunIds[0]).toBe("7-plan-1-20261012T120000");
    expect(readdirSync(paths.runs)).toContain("7-plan-1-20261012T120000");
  }, 60_000);

  it("fails a plan whose domain names a profile that does not exist, retrying once then needs-human (I4)", async () => {
    const firmware = { ...plan, domain: "firmware" };
    const { deps, claim, adapter, notifications } = await setup(() => ({ plan: [firmware, { ...firmware }] }));
    const final = await driveChain(deps, claim, () => false);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(final.state.stage).toBe("needs-human");
    expect(notifications[0]).toMatchObject({ gate: "plan", text: expect.stringContaining("profile not available: firmware") });
  }, 60_000);
});
