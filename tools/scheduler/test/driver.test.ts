import { readFileSync } from "node:fs";
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

function ghRoutes(sha: string, over: { checks?: unknown[]; mergeable?: boolean; merged?: boolean; issueLabels?: string[] } = {}): Route[] {
  const labels = [...["validated", "in-progress", "class:product"], ...(over.issueLabels ?? [])].map((name) => ({ name }));
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: { number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", labels, updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/9$/, reply: () => ({ body: { number: 9, title: "PR", body: "", labels: [], updated_at: "2026-10-12T00:00:00Z" } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: () => ({ status: 201, body: {} }) },
    { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, head: { sha }, html_url: "u", mergeable: over.mergeable ?? true, mergeable_state: "clean", merged: over.merged ?? false, state: over.merged ? "closed" : "open" } }) },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: over.checks ?? [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
  ];
}

/** `results` and `routes` take the worktree's real HEAD, which the PR binding (AC-10/AC-11) checks against. */
async function setup(results: (sha: string) => Record<string, unknown[]>, routes: (sha: string) => Route[] = (sha) => ghRoutes(sha)) {
  const pair = repoPair({ "a.txt": "a\n", "specs/010-thing/spec.md": spec });
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const wt = await ensureWorktree(pair.repo, pair.worktrees, 7);
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
  };
  const claim: Claim = { issue: 7, slot: 0, state: initialChainState(7), worktree: wt.path, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null };
  await writeClaim(paths, claim);
  return { deps, claim, gh, notifications, adapter, pair, paths, sha };
}

const plan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
const impl = (sha: string) => ({ pr_number: 9, head_sha: sha, tasks_done: ["T1"] });
const approve = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };

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
});
