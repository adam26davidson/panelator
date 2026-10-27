import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { Adapter, StageRun } from "../src/adapters/types.ts";
import { initialChainState, ledgerOf, transition } from "../src/chain/machine.ts";
import type { Action, ChainState } from "../src/chain/types.ts";
import { applyActions, CHARTER_REVERT_LINE, CLOSING_KEYWORD, driveChain, step, type DriverDeps } from "../src/chain/driver.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { ensureWorktree } from "../src/runner/worktree.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, readClaim, writeClaim, type Claim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { Question } from "../src/types.ts";
import { mockGitHub, type Route } from "./helpers/mock-github.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const events = join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl");
const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");

/** A scripted result: a value, or a function of the run that may do the agent's git work first and returns the result. */
type Scripted = unknown | ((run: StageRun) => unknown);

/** One fake adapter that answers per stage from a script of results; `heads` records the branch each run started on. */
function scriptedAdapter(results: Record<string, Scripted[]>): Adapter & { ran: string[]; heads: string[] } {
  const ran: string[] = [];
  const heads: string[] = [];
  return {
    harness: "fake", ran, heads,
    buildCommand(run) {
      ran.push(`${run.stage}:${run.model}`);
      heads.push(git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim());
      const next = results[run.stage]?.shift();
      const r = typeof next === "function" ? (next as (run: StageRun) => unknown)(run) : next;
      const argv = [process.execPath, script, events, run.resultPath, r === undefined ? "1" : "0", "0"];
      if (r !== undefined) argv.push(JSON.stringify(r));
      return { argv, env: {} };
    },
    judge: (_e, exit, timedOut) => timedOut ? { outcome: "timeout", reason: "t", apiErrorStatus: null, finalText: null }
      : exit === 0 ? { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" } : { outcome: "failed", reason: `exit ${exit}`, apiErrorStatus: null, finalText: null },
    usage: () => ({ cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
  };
}

interface PrOver { headRef?: string; head?: string | (() => string); body?: string; merged?: boolean; mergeable?: boolean }
interface RouteOver { checks?: unknown[]; mergeable?: boolean; merged?: boolean; issueLabels?: string[]; prHead?: string; headRef?: string; issueBody?: string; prs?: Record<number, PrOver> }

function ghRoutes(sha: string, over: RouteOver = {}): Route[] {
  const labels = [...["validated", "in-progress", "class:product"], ...(over.issueLabels ?? [])].map((name) => ({ name }));
  const prs: Record<number, PrOver> = { 9: { headRef: over.headRef ?? "issue-7", head: over.prHead ?? sha, merged: over.merged, mergeable: over.mergeable }, ...(over.prs ?? {}) };
  const checks = over.checks ?? [{ id: 1, name: "test", status: "completed", conclusion: "success" }];
  let commentId = 5000;
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: { number: 7, title: "Thing", body: over.issueBody ?? "Spec: specs/010-thing/spec.md", labels, updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/9$/, reply: () => ({ body: { number: 9, title: "PR", body: "", labels: [], updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "PATCH", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/\d+\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: { id: ++commentId, created_at: "2026-10-20T10:00:00Z" } }) },
    {
      method: "GET", path: /^\/repos\/o\/r\/pulls\/(\d+)$/, reply: (m) => {
        const pr = prs[Number(m[1])] ?? {};
        const head = typeof pr.head === "function" ? pr.head() : pr.head ?? sha;
        return { body: { number: Number(m[1]), base: { ref: "main" }, head: { ref: pr.headRef ?? "issue-7", sha: head }, html_url: "u", body: pr.body ?? "", mergeable: pr.mergeable ?? true, mergeable_state: "clean", merged: pr.merged ?? false, state: pr.merged ? "closed" : "open" } };
      },
    },
    { method: "PATCH", path: /^\/repos\/o\/r\/pulls\/\d+$/, reply: () => ({ body: {} }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/.+$/, reply: () => ({ status: 204, body: null }) },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: checks.length, check_runs: checks } }) },
    { method: "POST", path: /^\/repos\/o\/r\/check-runs\/\d+\/rerequest$/, reply: () => ({ status: 201, body: {} }) },
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/\d+\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
  ];
}

/** `results` and `routes` take the worktree's real HEAD, which the PR binding (AC-10/AC-11) checks against; `prepare` runs before it is read. */
async function setup(
  results: (sha: string) => Record<string, Scripted[]>,
  routes: (sha: string) => Route[] = (sha) => ghRoutes(sha),
  prepare: (pair: ReturnType<typeof repoPair>, worktree: string) => void = () => {},
  files: Record<string, string> = withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec }, "specs/010-thing/spec.md"),
) {
  const pair = repoPair(files);
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

async function steps(deps: DriverDeps, claim: Claim, n: number): Promise<Claim> {
  let c = claim;
  for (let i = 0; i < n; i++) c = (await step(deps, c)).claim;
  return c;
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

  it("waits on pending checks and starts fix with the failing log (AC-14)", async () => {
    const { deps, claim, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)] }), (sha) => ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] }));
    const r = await driveChain(deps, claim, () => false);
    expect(r.state.stage).toBe("verify");
    deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: mockGitHub(ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }] })).fetch } }), "o/r");
    const s = await step(deps, r);
    expect(s.claim.state.stage).toBe("fix");
    expect(s.claim.state.pendingFixInput).toMatch(/check failed/);
  }, 60_000);

  it("retries a failed plan once, then escalates to a rescue plan with no label or notification (spec 006 AC-1)", async () => {
    const { deps, claim, notifications, adapter, gh } = await setup(() => ({ plan: [] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(c.state).toMatchObject({ stage: "plan", attempt: 1, rescues: 1, rescueRun: true });
    expect(c.state.history.at(-1)).toMatch(/^plan: failed twice/);
    expect(notifications).toEqual([]);
    expect(gh.calls.some((call) => call.method === "POST" && call.url.endsWith("/labels"))).toBe(false);
  }, 60_000);

  it("stops between stages when asked to stop (AC-31)", async () => {
    const { deps, claim } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }));
    let calls = 0;
    const r = await driveChain(deps, claim, () => ++calls > 2);
    expect(r.state.stage).toBe("implement");
  }, 60_000);

  it("refuses an implement result whose head_sha is not the worktree HEAD and PR head, retrying then escalating (AC-10, AC-11; spec 006 AC-1)", async () => {
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
    c = (await step(deps, c)).claim;
    expect(c.state).toMatchObject({ stage: "implement", rescues: 1, rescueRun: true, pr: null });
    expect(c.state.history).toContain("implement attempt 2 failed: result: pr mismatch");
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5", "implement:claude-sonnet-5-5"]);
    expect(notifications).toEqual([]);
    expect(gh.calls.find((call) => call.method === "PUT")).toBeUndefined();
  }, 60_000);

  it("merges although the issue carries security-review: no label refuses a merge (spec 006 AC-9)", async () => {
    const { deps, claim, gh, notifications, paths, sha } = await setup(
      (sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }),
      (sha) => ghRoutes(sha, { issueLabels: ["security-review"] }),
    );
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("done");
    expect(gh.calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "squash", sha });
    expect(gh.calls.some((c) => c.method === "GET" && c.url.endsWith("/issues/9"))).toBe(false);
    expect(notifications).toEqual([]);
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
    const { deps, claim, adapter, pair, paths } = await setup(() => ({ plan: [plan] }), undefined, (_pair, wt) => {
      writeFileSync(join(wt, "stray.txt"), "stray\n");
      git(wt, "add", "stray.txt");
      git(wt, "commit", "-q", "-m", "stray");
    });
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    let c = (await step(deps, claim)).claim;
    c = (await step(deps, c)).claim;
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(c.state.stage).toBe("implement");
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(git(pair.repo, "rev-parse", "origin/main").trim());
    // Spec 005, AC-2: the stray commit was saved as a patch before the reset.
    const saved = readdirSync(paths.patches).filter((f) => /^7-.*\.patch$/.test(f));
    expect(saved).toHaveLength(1);
    const patchPath = join(paths.patches, saved[0]);
    const text = readFileSync(patchPath, "utf8");
    expect(text.startsWith("From ")).toBe(true);
    expect(text).toContain("stray.txt");
    expect(logs).toContainEqual({ kind: "recovered-commits", issue: 7, patch: patchPath, base: "origin/main" });
  }, 60_000);

  it("writes no patch and no recovered-commits record when the reset has nothing to discard (spec 005, AC-4)", async () => {
    const { deps, claim, paths } = await setup(() => ({ plan: [plan] }));
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    let c = (await step(deps, claim)).claim;
    c = (await step(deps, c)).claim;
    expect(readdirSync(paths.patches)).toEqual([]);
    expect(logs.find((r) => r.kind === "recovered-commits")).toBeUndefined();
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
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const r1 = await step(deps, atMerge);
    expect(r1.claim.state.stage).toBe("verify");
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(sha);
    const r2 = await step(deps, r1.claim);
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(over.prHead);
    expect(r2.claim.state.sensitive).toBe(true);
    expect(r2.claim.state.stage).toBe("review");
    // A fast-forward drops nothing (spec 005, AC-4).
    expect(logs).toContainEqual({ kind: "worktree-synced", issue: 7, pr: 9, dropped: null, patch: null });
    expect(readdirSync(paths.patches)).toEqual([]);
  }, 60_000);

  it("saves the local commits it drops when the worktree diverged from the PR head (spec 005, AC-3)", async () => {
    const over: { prHead?: string } = {};
    let other = "";
    let local = "";
    const { deps, claim, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, over), (pair, worktree) => {
      git(worktree, "push", "-q", "-u", "origin", "issue-7");
      other = join(pair.root, "other");
      git(pair.root, "clone", "-q", "-b", "issue-7", pair.origin, other);
      writeFileSync(join(other, "remote.txt"), "pushed from elsewhere\n");
      git(other, "add", "-A");
      git(other, "commit", "-q", "-m", "remote change");
      git(other, "push", "-q", "origin", "issue-7");
      over.prHead = git(other, "rev-parse", "HEAD").trim();
      writeFileSync(join(worktree, "local.txt"), "local only\n");
      git(worktree, "add", "local.txt");
      git(worktree, "commit", "-q", "-m", "local change");
      local = git(worktree, "rev-parse", "HEAD").trim();
    });
    const atMerge: Claim = { ...claim, state: { ...claim.state, stage: "merge", pr: { number: 9, head_sha: sha } } };
    await writeClaim(paths, atMerge);
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const r1 = await step(deps, atMerge);
    expect(r1.claim.state.stage).toBe("verify");
    await step(deps, r1.claim);
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(over.prHead);
    const saved = readdirSync(paths.patches).filter((f) => /^7-.*\.patch$/.test(f));
    expect(saved).toHaveLength(1);
    const patchPath = join(paths.patches, saved[0]);
    const text = readFileSync(patchPath, "utf8");
    expect(text).toContain("local.txt");
    expect(text).not.toContain("remote.txt");
    expect(logs).toContainEqual({ kind: "worktree-synced", issue: 7, pr: 9, dropped: local, patch: patchPath });
    expect(logs.find((r) => r.kind === "recovered-commits")).toBeUndefined();
    // The patch applies onto the remote head it was cut against.
    git(other, "am", patchPath);
    expect(readFileSync(join(other, "local.txt"), "utf8")).toBe("local only\n");
  }, 60_000);

  it("refuses an implement result whose PR is not issue-7 into main (I1, AC-10; spec 006 AC-1)", async () => {
    const { deps, claim, gh } = await setup((sha) => ({ plan: [plan], implement: [impl(sha), impl(sha)] }), (sha) => ghRoutes(sha, { headRef: "other" }));
    const c = await steps(deps, claim, 4);
    expect(c.state).toMatchObject({ stage: "implement", rescues: 1, rescueRun: true, pr: null });
    expect(c.state.history).toContain("implement attempt 1 failed: result: pr mismatch");
    expect(gh.calls.find((call) => call.method === "PUT")).toBeUndefined();
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

  it("fails a plan whose domain names a profile that does not exist, retrying once then escalating (I4; spec 006 AC-1)", async () => {
    const firmware = { ...plan, domain: "firmware" };
    const { deps, claim, adapter, notifications } = await setup(() => ({ plan: [firmware, { ...firmware }] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(c.state).toMatchObject({ stage: "plan", rescues: 1, rescueRun: true });
    expect(c.state.history.at(-1)).toContain("profile not available: firmware");
    expect(notifications).toEqual([]);
  }, 60_000);
});

const Q: Question = { kind: "technical", question: "Which store?\nIt decides the schema.", options: [{ label: "a", cost: "cheap" }, { label: "b", cost: "dear" }], recommendation: "a" };

function at(claim: Claim, patch: Partial<ChainState>, extra: Partial<Claim> = {}): Claim {
  return { ...claim, ...extra, state: { ...claim.state, ...patch } };
}
/** Every call that changes something on GitHub, in order. */
const writes = (gh: { calls: { method: string; url: string }[] }) => gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
/** The input.json of the newest run whose id starts with `prefix`. */
function inputOf(paths: ReturnType<typeof statePaths>, prefix: string): StageInputJson {
  const dir = readdirSync(paths.runs).filter((d) => d.startsWith(prefix)).sort().at(-1)!;
  return JSON.parse(readFileSync(join(paths.runs, dir, "input.json"), "utf8"));
}
type StageInputJson = Record<string, string | undefined>;
function commitIn(wt: string, files: Record<string, string>, msg = "work"): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(wt, p, ".."), { recursive: true });
    writeFileSync(join(wt, p), c);
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", msg);
  return git(wt, "rev-parse", "HEAD").trim();
}
const head = (wt: string) => git(wt, "rev-parse", "HEAD").trim();
const branchIn = (wt: string) => git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim();
const ledgerFile = (paths: ReturnType<typeof statePaths>) => join(paths.escalations, "7.json");
const logEvents = (paths: ReturnType<typeof statePaths>) => readFileSync(paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const onSpec7 = (_pair: ReturnType<typeof repoPair>, wt: string) => {
  git(wt, "checkout", "-q", "-b", "spec-7");
  commitIn(wt, { "specs/010-thing/notes.md": "notes\n" }, "spec work");
  git(wt, "push", "-q", "-u", "origin", "spec-7");
};

describe("driver: escalation (spec 006 AC-1 to AC-5, AC-7)", () => {
  it("runs the rescue on the rescue model with the history in its prompt, and mirrors the counts to the ledger (AC-1, AC-7)", async () => {
    const { deps, claim, adapter, paths } = await setup(() => ({ plan: [] }));
    const c = await steps(deps, claim, 4);
    expect(adapter.ran).toHaveLength(3);
    expect(adapter.ran.at(-1)).toBe("plan:claude-fable-5-1");
    expect(c.state.rescues).toBe(1);
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).rescues).toBe(1);
    const rescue = readdirSync(paths.runs).find((d) => d.startsWith("7-plan-1-") && d.includes("-rescue"))!;
    expect(readFileSync(join(paths.runs, rescue, "prompt.md"), "utf8")).toContain("plan: failed twice");
  }, 60_000);

  it("runs a rescued implement on the rescue model, not the stage's own (AC-1)", async () => {
    const { deps, claim, adapter } = await setup(() => ({ plan: [plan], implement: [] }));
    await steps(deps, claim, 5);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5", "implement:claude-sonnet-5-5", "implement:claude-fable-5-1"]);
  }, 60_000);

  it("re-plans with PR 9 open: comments on it, closes it and deletes issue-7 from the action, saving its branch as a patch (AC-2, review focus 6, C10)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({ fix: [] }), undefined, (_pair, wt) => {
      commitIn(wt, { "feature.txt": "f\n" });
      git(wt, "push", "-q", "-u", "origin", "issue-7");
    });
    const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, rescues: 1, pendingFixInput: "Fix it." });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toEqual(["POST /repos/o/r/issues/9/comments", "PATCH /repos/o/r/pulls/9", "DELETE /repos/o/r/git/refs/heads/issue-7"]);
    expect(gh.calls.find((x) => x.method === "PATCH")?.body).toEqual({ state: "closed" });
    expect(r.claim.state).toMatchObject({ stage: "plan", pr: null, replans: 1, fixes: 0 });
    expect((await readClaim(paths, 7))?.state.pr).toBeNull();
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).replans).toBe(1);
    const saved = readdirSync(paths.patches).filter((f) => f.includes("closed-pr"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(paths.patches, saved[0]), "utf8")).toContain("feature.txt");
  }, 60_000);

  it("abandons in order: both PRs closed from their own branches, a comment with no @, abandoned before -in-progress, one finding, one notification, ledger archived (AC-5, C10, C11)", async () => {
    let issueSha = "";
    const { deps, claim, gh, paths, notifications, sha } = await setup(() => ({ fix: [] }), undefined, (_pair, wt) => {
      issueSha = commitIn(wt, { "issue.txt": "i\n" });
      git(wt, "push", "-q", "-u", "origin", "issue-7");
      git(wt, "checkout", "-q", "-b", "spec-7", "origin/main");
      commitIn(wt, { "specs/010-thing/notes.md": "notes\n" });
      git(wt, "push", "-q", "-u", "origin", "spec-7");
    });
    const c = at(claim, {
      stage: "fix", track: "spec", plan: plan as never, pr: { number: 12, head_sha: sha }, parkedPr: { number: 9, head_sha: issueSha },
      rescues: 1, replans: 1, specRevisions: 1, specRescues: 1, pendingFixInput: "Fix the spec PR.", history: ["review: @someone asked for x"],
    });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.status).toBe("ended");
    expect(writes(gh)).toEqual([
      "POST /repos/o/r/issues/12/comments", "PATCH /repos/o/r/pulls/12", "DELETE /repos/o/r/git/refs/heads/spec-7",
      "POST /repos/o/r/issues/9/comments", "PATCH /repos/o/r/pulls/9", "DELETE /repos/o/r/git/refs/heads/issue-7",
      "POST /repos/o/r/issues/7/comments", "POST /repos/o/r/issues/7/labels", "DELETE /repos/o/r/issues/7/labels/in-progress",
    ]);
    const comment = String((gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments")?.body as { body: string }).body);
    expect(comment).not.toContain("@");
    expect(comment).toContain("(at)someone");
    expect(comment).toMatch(/`runs\/7-fix-1-\d{8}T\d{6}`/);
    expect(gh.calls.find((x) => x.url === "/repos/o/r/issues/7/labels")?.body).toEqual({ labels: ["abandoned"] });
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(notifications.map((n) => n.gate)).toEqual(["abandoned"]);
    expect(existsSync(ledgerFile(paths))).toBe(false);
    expect(readdirSync(paths.escalations).some((f) => f.startsWith("7.abandoned-"))).toBe(true);
    expect(await listClaims(paths)).toEqual([]);
    const patches = readdirSync(paths.patches).filter((f) => f.includes("closed-pr")).map((f) => readFileSync(join(paths.patches, f), "utf8"));
    expect(patches).toHaveLength(2);
    expect(patches.filter((p) => p.includes("issue.txt") && !p.includes("notes.md"))).toHaveLength(1);
    expect(patches.filter((p) => p.includes("notes.md") && !p.includes("issue.txt"))).toHaveLength(1);
  }, 60_000);

  it("finishes an abandonment from its pending actions after a crash, repeating none that were done (AC-5, review focus 11, D11)", async () => {
    const { deps, claim, gh, paths, notifications } = await setup(() => ({}));
    const pendingActions: Action[] = [
      { type: "label", add: ["abandoned"], remove: ["in-progress"] },
      { type: "finding", stage: "plan", finding: { what: "issue abandoned after the escalation path", where: "issue #7", evidence: "e", noticed_how: "scheduler escalation" } },
      { type: "notify", gate: "abandoned", label: "abandoned", text: "Issue #7 abandoned." },
      { type: "done" },
    ];
    const c = at(claim, { stage: "abandoned" }, { pendingActions });
    await writeClaim(paths, c);
    // The first try dies at the notification: the claim keeps only what was not done.
    let fail = true;
    deps.notifier = { notify: async (n) => { if (fail) { fail = false; throw new Error("crash"); } notifications.push(n); } };
    await expect(step(deps, c)).rejects.toThrow("crash");
    const left = (await readClaim(paths, 7))!;
    expect(left.pendingActions?.map((a) => a.type)).toEqual(["notify", "done"]);
    const r = await step(deps, left);
    expect(r.status).toBe("ended");
    expect(writes(gh)).toEqual(["POST /repos/o/r/issues/7/labels", "DELETE /repos/o/r/issues/7/labels/in-progress"]);
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(await readClaim(paths, 7)).toBeNull();
  }, 60_000);

  it("applies a resumed issue's answered event as a transition: the fix bound re-plans, closing PR 9 (AC-15)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({}));
    const c = at(claim, { stage: "paused", askingStage: "review", question: Q, fixes: 2, rescues: 1, pr: { number: 9, head_sha: sha }, plan: plan as never }, {
      pendingEvent: { type: "answered", answer: "use a", questionId: 555 },
    });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("PATCH /repos/o/r/pulls/9");
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/issue-7");
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).replans).toBe(1);
    const stored = (await readClaim(paths, 7))!;
    expect(stored.pendingEvent).toBeUndefined();
    expect(stored.state.stage).toBe("plan");
    expect(r.claim.pendingEvent).toBeUndefined();
  }, 60_000);
});

describe("driver: rate limits (spec 006 AC-26)", () => {
  it("postpones a question check whose primary and fallback runs both hit a 429, with a usage record for each", async () => {
    const { deps, claim, paths } = await setup(() => ({}));
    const ran: string[] = [];
    deps.adapterFor = () => ({
      harness: "fake",
      buildCommand: (run) => { ran.push(`${run.stage}:${run.model}`); return { argv: [process.execPath, script, events, run.resultPath, "1", "0"], env: {} }; },
      judge: () => ({ outcome: "failed", reason: "rate limited (429)", apiErrorStatus: 429, finalText: null }),
      usage: () => ({ cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
    });
    const c = at(claim, { stage: "question-check", question: Q, askingStage: "plan" });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "question-check" });
    expect(ran).toEqual(["question-check:openai/gpt-6.1-sol", "question-check:claude-fable-5-1"]);
    const usage = readdirSync(paths.usage).map((f) => JSON.parse(readFileSync(join(paths.usage, f), "utf8")));
    expect(usage.map((u) => [u.stage, u.model]).sort()).toEqual([["question-check", "claude-fable-5-1"], ["question-check", "openai/gpt-6.1-sol"]]);
  }, 60_000);
});

describe("driver: questions (spec 006 AC-12, AC-13, AC-17)", () => {
  it("sends a plan escalation to the question check even when its domain has no profile (review focus 9)", async () => {
    const { deps, claim, paths } = await setup(() => ({ plan: [{ ...plan, domain: "firmware", escalation: Q }] }));
    const c = await steps(deps, claim, 2);
    expect(c.state).toMatchObject({ stage: "question-check", askingStage: "plan", question: Q });
    expect(logEvents(paths)).toEqual(["asked"]);
  }, 60_000);

  it("pauses on send: the paused record, the question comment with its nonce, labels, one notification, no claim, worktree kept, log asked/checked/sent (AC-13, AC-18)", async () => {
    const { deps, claim, gh, paths, notifications } = await setup(() => ({ plan: [plan], implement: [{ escalation: Q }], "question-check": [{ verdict: "send", reasoning: "a real choice" }] }));
    const r = await (async () => { let c = claim; let res; for (let i = 0; i < 4; i++) { res = await step(deps, c); c = res.claim; if (res.status !== "continue") break; } return res!; })();
    expect(r.status).toBe("ended");
    const rec = JSON.parse(readFileSync(join(paths.paused, "7.json"), "utf8"));
    expect(rec).toMatchObject({ phase: "paused", question_comment_id: 5001, asked_at: "2026-10-20T10:00:00Z", asking_stage: "implement", question: Q, reminded: false });
    const body = String((gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments")?.body as { body: string }).body);
    expect(body.split("\n").at(-1)).toBe(`<!-- panelator-question:${rec.nonce} -->`);
    expect(body.startsWith("### Question for the maintainer\n@adam26davidson")).toBe(true);
    expect(writes(gh).filter((w) => w.includes("/labels"))).toEqual(["POST /repos/o/r/issues/7/labels", "DELETE /repos/o/r/issues/7/labels/in-progress"]);
    expect(gh.calls.find((x) => x.url === "/repos/o/r/issues/7/labels")?.body).toEqual({ labels: ["needs-decision"] });
    expect(notifications.map((n) => n.gate)).toEqual(["question"]);
    expect(existsSync(join(paths.claims, "7.json"))).toBe(false);
    expect(existsSync(claim.worktree)).toBe(true);
    expect(logEvents(paths)).toEqual(["asked", "checked", "sent"]);
  }, 60_000);

  it("re-runs a check pending six hours, then runs a fix whose input names it (AC-17)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({ fix: [] }), (sha) => ghRoutes(sha, { checks: [{ id: 42, name: "test", status: "queued", conclusion: null }] }));
    const c = at(claim, { stage: "verify", plan: plan as never, pr: { number: 9, head_sha: sha }, pendingSince: new Date(Date.now() - 7 * 3_600_000).toISOString() });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("POST /repos/o/r/check-runs/42/rerequest");
    expect(r.claim.state).toMatchObject({ stage: "fix", checksRerun: true });
    await step(deps, r.claim);
    expect(inputOf(paths, "7-fix-").fix_input).toMatch(/Required checks test have been pending for 6 hours/);
  }, 60_000);

  it("lists the review's cited answers, verified only from the questions log (AC-10, C7)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({ review: [approve] }), undefined, (_pair, wt) => {
      commitIn(wt, { "notes.md": "per (maintainer answer, question #101)\nsee question #102\nand question #103\n" });
    });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 101, reply_comment_id: 111, answer: "use a\nplease", question: Q });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 102 });
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-review-").answered_questions).toBe([
      "#101: verified. Question: Which store?. Answer: use a please",
      "#102: NOT verified; treat as no citation",
      "#103: NOT verified; treat as no citation",
    ].join("\n"));
  }, 60_000);
});

describe("driver: recorded answers in a fix (spec 006 AC-18)", () => {
  const recording = { recordAnswer: true, answerQuestionId: 555, answerKind: "technical" as const, answer: "use a", pendingFixInput: "Record the decision." };
  const adr = (wt: string) => ({ head_sha: commitIn(wt, { "docs/decisions/0001-store.md": "Use a. (maintainer answer, question #555)\n" }), addressed: [] });

  it("fails a recording fix whose diff adds no marked file under docs/decisions/", async () => {
    const { deps, claim, paths, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }));
    const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, ...recording });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state.history).toContain("fix attempt 1 failed: result: answer not recorded under docs/decisions/");
  }, 60_000);

  it("accepts a recording fix that adds the marked ADR, and needs none after a capability answer", async () => {
    let wt = "";
    const { deps, claim, paths, sha } = await setup(() => ({ fix: [(run: StageRun) => adr(run.worktree)] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wt) } } }), (_p, w) => { wt = w; });
    const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, ...recording });
    await writeClaim(paths, c);
    expect((await step(deps, c)).claim.state.stage).toBe("verify");

    const cap = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }));
    const c2 = at(cap.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: cap.sha }, answer: "fixed the runner", answerQuestionId: 556, answerKind: "capability" });
    await writeClaim(cap.paths, c2);
    expect((await step(cap.deps, c2)).claim.state.stage).toBe("verify");
  }, 60_000);

  it("keeps an earlier ADR in scope on a later fix only while its mark is verified in the log (Task 6 ruling)", async () => {
    for (const logged of [true, false]) {
      let wt = "";
      const { deps, claim, paths, sha } = await setup(() => ({ fix: [(run: StageRun) => adr(run.worktree)] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wt) } } }), (_p, w) => { wt = w; });
      if (logged) await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "review", question_comment_id: 555, reply_comment_id: 600, answer: "use a" });
      const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, pendingFixInput: "Address the review." });
      await writeClaim(paths, c);
      const r = await step(deps, c);
      if (logged) expect(r.claim.state.stage).toBe("verify");
      else {
        expect(r.claim.state.stage).toBe("fix");
        expect(r.claim.state.pendingFixInput).toContain("docs/decisions/0001-store.md: outside plan file scope");
      }
    }
  }, 60_000);
});

describe("driver: spec track (spec 006 AC-4, AC-19, AC-21, AC-22)", () => {
  it("runs the spec stage on spec-7 for a claim with a missing spec (review focus 12)", async () => {
    const { deps, claim, adapter, paths } = await setup(() => ({ spec: [] }));
    const c = { ...claim, state: initialChainState(7, "specs/010-thing/spec.md has no Parent: line") };
    await writeClaim(paths, c);
    const r = await steps(deps, c, 2);
    expect(adapter.heads).toEqual(["spec-7"]);
    expect(r.state).toMatchObject({ stage: "spec", track: "spec", specMode: "write", attempt: 2 });
    expect(inputOf(paths, "7-spec-")).toMatchObject({ mode: "write", spec_problem: "specs/010-thing/spec.md has no Parent: line" });
  }, 60_000);

  it("sends a spec_gap to the spec stage in answer mode on spec-7, with no needs-clarification label (AC-19, review focus 12)", async () => {
    const gap = { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which store?"] };
    const { deps, claim, adapter, gh, paths } = await setup(() => ({ plan: [gap], spec: [] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.heads).toEqual(["issue-7", "spec-7"]);
    expect(c.state).toMatchObject({ track: "spec", specMode: "answer", specAnswers: 1 });
    expect(inputOf(paths, "7-spec-").mode).toBe("answer");
    expect(gh.calls.some((x) => x.method === "POST" && x.url.endsWith("/labels"))).toBe(false);
  }, 60_000);

  it("after a spec-track merge deletes spec-7 locally and on GitHub, records no merge, and implements on issue-7 (AC-4, review focus 7)", async () => {
    const { deps, claim, adapter, gh, paths, sha } = await setup(() => ({ plan: [plan], implement: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("PUT /repos/o/r/pulls/12/merge");
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(r.claim.state).toMatchObject({ stage: "plan", track: "issue", pr: null });
    expect(branchIn(claim.worktree)).toBe("issue-7");
    expect(git(claim.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    expect(existsSync(join(paths.root, "merges.jsonl"))).toBe(false);
    await steps(deps, r.claim, 2);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "implement:claude-sonnet-5-5"]);
    expect(adapter.heads).toEqual(["issue-7", "issue-7"]);
  }, 60_000);

  it("runs the spec stage again on the rescue model in write mode when spec-present fails on main after the merge (AC-4)", async () => {
    const { deps, claim, adapter, paths, sha } = await setup(() => ({ spec: [] }), (sha) => ghRoutes(sha, { issueBody: "Spec: specs/011-gone/spec.md", prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    deps.cfg = { ...deps.cfg, rescue_model: "claude-rescue-test" };
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state).toMatchObject({ stage: "spec", track: "spec", specMode: "write", rescueRun: true, specRescues: 1 });
    await step(deps, r.claim);
    expect(adapter.ran).toEqual(["spec:claude-rescue-test"]);
    expect(adapter.heads).toEqual(["spec-7"]);
    expect(inputOf(paths, "7-spec-")).toMatchObject({ mode: "write", spec_problem: "specs/011-gone/spec.md not found on main" });
  }, 60_000);

  it("parks a UI issue for the design stage when the UI-design gate fails after the merge, keeping the ledger (AC-4, AC-20)", async () => {
    const ui = "specs/011-ui/spec.md";
    const files = {
      "a.txt": "a\n", "specs/010-thing/spec.md": spec, [ui]: readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8"),
      "docs/top.md": `# Top design\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n- \`${ui}\`\n`,
    };
    const { deps, claim, gh, paths, sha } = await setup(() => ({}), (sha) => ghRoutes(sha, { issueBody: `Spec: ${ui}`, prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7, files);
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha }, specRescues: 1 });
    await writeClaim(paths, c);
    await writeLedger(paths, 7, ledgerOf(c.state));
    const r = await step(deps, c);
    expect(r.status).toBe("ended");
    expect(gh.calls.find((x) => x.url === "/repos/o/r/issues/7/labels")?.body).toEqual({ labels: ["needs-design-stage"] });
    expect(writes(gh)).toContain("DELETE /repos/o/r/issues/7/labels/in-progress");
    expect(await readClaim(paths, 7)).toBeNull();
    expect(existsSync(ledgerFile(paths))).toBe(true);
  }, 60_000);

  async function specRun(result: Scripted, over: RouteOver = {}, prepare?: (pair: ReturnType<typeof repoPair>, wt: string) => void) {
    const env = await setup(() => ({ spec: [result], fix: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } }, ...over }), prepare);
    const c = at(env.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(env.paths, c);
    return { ...env, r: await step(env.deps, c) };
  }
  const revised = (sha: string, extra: Record<string, unknown> = {}) => ({ verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 12, head_sha: sha, ...extra });

  it("fails a revised result whose spec_path leaves specs/ on the schema, without touching the issue body (review focus 4, D5)", async () => {
    const { r, gh, paths } = await specRun(revised("a".repeat(40), { spec_path: "specs/../docs/charter.md" }));
    expect(r.claim.state).toMatchObject({ stage: "spec", attempt: 2 });
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: invalid");
    const run = readdirSync(paths.runs).find((d) => d.startsWith("7-spec-1-"))!;
    expect(JSON.parse(readFileSync(join(paths.runs, run, "outcome.json"), "utf8")).resultErrors.join(" ")).toMatch(/spec_path.*pattern/);
    expect(gh.calls.some((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")).toBe(false);
  }, 60_000);

  it("fails a revised result whose spec_path differs from the issue's Spec: line (AC-21)", async () => {
    const { r } = await specRun((run: StageRun) => revised(head(run.worktree), { spec_path: "specs/011-other/spec.md" }));
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: spec_path differs from the issue's Spec: line");
  }, 60_000);

  it("fails a spec PR whose body closes an issue, by number, owner/repo#N or URL (AC-21, D8)", async () => {
    // A PR from issue-7 is not the spec PR (the spec stage binds to spec-7).
    const { r } = await specRun((run: StageRun) => revised(head(run.worktree)), { prs: { 12: { headRef: "issue-7" } } });
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: pr mismatch");
    let wt = "";
    const closes = await specRun((run: StageRun) => revised(head(run.worktree)), { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Closes #7" } } }, (_p, w) => { wt = w; });
    expect(closes.r.claim.state.history).toContain("spec attempt 1 failed: result: spec PR body closes an issue");
    for (const body of ["Fixes o/r#7", "resolves https://github.com/o/r/issues/7", "Closed: #3"]) expect(CLOSING_KEYWORD.test(body)).toBe(true);
    for (const body of ["Refs #7", "Fixed the parser for #7's spec? no: refs only"]) expect(CLOSING_KEYWORD.test(body)).toBe(false);
  }, 60_000);

  it("hands a spec PR that touches the charter to the machine as a scope violation, and the fix is told to revert it (AC-22, AC-10)", async () => {
    let wt = "";
    const edit = (run: StageRun) => revised(commitIn(run.worktree, { "docs/charter.md": "changed\n", "specs/010-thing/notes.md": "n\n" }));
    const { r, deps, paths } = await specRun(edit, { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }, (_p, w) => { wt = w; });
    expect(r.claim.state).toMatchObject({ stage: "fix", scopeViolations: 1 });
    expect(r.claim.state.pendingFixInput).toContain("docs/charter.md: the charter is never changed by a spec PR");
    await step(deps, r.claim);
    expect(inputOf(paths, "7-fix-").fix_input?.startsWith(`${CHARTER_REVERT_LINE}\n`)).toBe(true);
  }, 60_000);

  it("appends the Spec: line to an issue body that has none (AC-21)", async () => {
    let wt = "";
    const { gh } = await specRun((run: StageRun) => revised(head(run.worktree)), { issueBody: "Do the thing.", prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }, (_p, w) => { wt = w; });
    expect(gh.calls.find((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")?.body).toEqual({ body: "Do the thing.\n\nSpec: specs/010-thing/spec.md" });
  }, 60_000);

  it("fails a spec PR recording a technical answer without its mark, and accepts it with the mark (AC-18)", async () => {
    let wt = "";
    const routes = { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } };
    const unmarked = await setup(() => ({ spec: [(run: StageRun) => revised(commitIn(run.worktree, { "specs/010-thing/spec.md": spec + "\nUse a.\n" })), (run: StageRun) => revised(commitIn(run.worktree, { "specs/010-thing/spec.md": spec + "\nUse a. (maintainer answer, question #555)\n" }))] }), (sha) => ghRoutes(sha, routes), (_p, w) => { wt = w; });
    const c = at(unmarked.claim, { stage: "spec", track: "spec", specMode: "write", answer: "use a", answerQuestionId: 555, answerKind: "technical" });
    await writeClaim(unmarked.paths, c);
    const r = await step(unmarked.deps, c);
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: answer not marked");
    const r2 = await step(unmarked.deps, r.claim);
    expect(r2.claim.state.history.some((h) => h.includes("answer not marked") && h.startsWith("spec attempt 2"))).toBe(false);
    expect(r2.claim.state.stage).not.toBe("spec");
  }, 60_000);

  it("reviews a spec PR under the security profile when it touches a top design, else under the spec profile (AC-4, AC-21)", async () => {
    const sensitive = await setup(() => ({ review: [approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), (_p, wt) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, { "docs/delivery-system-design.md": "# Design\n" });
      git(wt, "push", "-q", "-u", "origin", "spec-7");
    });
    const c = at(sensitive.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: sensitive.sha } });
    await writeClaim(sensitive.paths, c);
    await step(sensitive.deps, c);
    expect(inputOf(sensitive.paths, "7-review-").profile_instructions).toMatch(/^Security review profile\./);

    const plain = await setup(() => ({ review: [approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c2 = at(plain.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: plain.sha } });
    await writeClaim(plain.paths, c2);
    await step(plain.deps, c2);
    expect(inputOf(plain.paths, "7-review-").profile_instructions).toMatch(/^Spec profile\./);
  }, 60_000);

  it("a liveness release on the spec track closes spec PR 12 and deletes spec-7, and closes the parked issue PR too (AC-21)", async () => {
    const { deps, claim, gh, paths, sha } = await setup(() => ({}));
    const c = at(claim, { stage: "verify", track: "spec", pr: { number: 12, head_sha: sha }, parkedPr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const { state, actions } = transition(c.state, { type: "liveness_expired" });
    expect(await applyActions(deps, { ...c, state }, actions)).toBe("ended");
    expect(writes(gh)).toEqual(expect.arrayContaining(["PATCH /repos/o/r/pulls/12", "DELETE /repos/o/r/git/refs/heads/spec-7", "PATCH /repos/o/r/pulls/9", "DELETE /repos/o/r/git/refs/heads/issue-7"]));
    expect(await readClaim(paths, 7)).toBeNull();
  }, 60_000);
});
