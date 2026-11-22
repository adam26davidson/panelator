import { OUT_OF_SCOPE_PARAGRAPH, UNCHANGED_WITHOUT_VERDICT_PARAGRAPH, specMoveReason } from "../src/chain/driver.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { transientCause } from "../src/chain/transient.ts";
import { initialChainState, transition } from "../src/chain/machine.ts";
import type { Action, ChainState } from "../src/chain/types.ts";
import { driveChain, step, type DriverDeps } from "../src/chain/driver.ts";
import { GitHubClient } from "../src/github/client.ts";
import { listClaims, readClaim, writeClaim, type Claim } from "../src/state/claims.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { Question } from "../src/types.ts";
import { mockGitHub, type Route } from "./helpers/mock-github.ts";
import { validate } from "../src/schema/validate.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";
import { script, events, spec, type Scripted, scriptedAdapter, type RouteOver, ghRoutes, setup, plan, impl, settled, outside, approve, fakeSystemdRun, conflicting, steps, Q, at, writes, inputOf, commitIn, head, ledgerFile, onSpec7, prBehindMain, rateLimited, dnsFailure, patchFiles, mergeMainResolved, judgedAs, UNREACHABLE } from "./helpers/driver-harness.ts";

describe("driveChain", () => {
  it("runs a full chain to done, applying labels and recording a merge (AC-1, AC-3, AC-14)", async () => {
    const { deps, claim, gh, adapter, paths, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)], review: [approve] }));
    const final = await driveChain(deps, claim, () => false);
    expect(final.state.stage).toBe("done");
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "implement:claude-sonnet-5-5", "review:claude-fable-5-2"]);
    expect(gh.calls.find((c) => c.method === "PUT")?.body).toEqual({ merge_method: "squash", sha });
    expect(gh.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toContain("/repos/o/r/issues/7/labels/in-progress");
    expect(await listClaims(paths)).toEqual([]);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"cls":"feature"');
    // The review prompt gets the PR head's check conclusions, so it never tries to run the suite itself.
    const reviewRun = readdirSync(paths.runs).find((d) => d.startsWith("7-review-"))!;
    const reviewInput = JSON.parse(readFileSync(join(paths.runs, reviewRun, "input.json"), "utf8"));
    expect(reviewInput.ci).toBe(`All required checks passed for ${sha}.\ntest: success`);
  }, 60_000);

  it("gives the review run the pull request's description, and does not start it when the read fails (spec 080 AC-3, AC-4)", async () => {
    const withBody = (sha: string) => ghRoutes(sha, { prs: { 9: { headRef: "issue-7", head: sha, body: "Closes #7\n\nran `pnpm test` {{spec}}" } } });
    const a = await setup(() => ({ review: [approve] }), withBody);
    const atReview = (c: Claim): Claim => ({ ...c, state: { ...c.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: a.sha } } });
    await writeClaim(a.paths, atReview(a.claim));
    await step(a.deps, atReview(a.claim));
    const run = readdirSync(a.paths.runs).find((d) => d.startsWith("7-review-"))!;
    expect(JSON.parse(readFileSync(join(a.paths.runs, run, "input.json"), "utf8")).pr.body).toBe("Closes #7\n\nran `pnpm test` {{spec}}");
    expect(readFileSync(join(a.paths.runs, run, "prompt.md"), "utf8")).toContain("Closes #7\n\nran `pnpm test` {{spec}}");

    const b = await setup(() => ({ review: [approve] }), (sha) => ghRoutes(sha).map((r) =>
      r.method === "GET" && String(r.path) === String(/^\/repos\/o\/r\/pulls\/(\d+)$/) ? { ...r, reply: () => ({ status: 500, body: { message: "boom" } }) } : r));
    b.deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: b.gh.fetch }, retry: { enabled: false } }), "o/r");
    const c = atReview(b.claim);
    await writeClaim(b.paths, c);
    const r = await step(b.deps, c);
    expect(b.adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "review", attempt: c.state.attempt });
  }, 60_000);

  it("a pending verify carries the downtime inside its window, so a long gap does not spend a fix (spec 100 AC-7)", async () => {
    const run = async (host: DriverDeps["host"]) => {
      const { deps, claim, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)] }), (sha) => ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] }));
      deps.host = host;
      const r = await driveChain(deps, claim, () => false);
      expect(r.state.stage).toBe("verify");
      const since = new Date(Date.now() - 7 * 3_600_000).toISOString();
      const c: Claim = { ...r, state: { ...r.state, pendingSince: since } };
      return (await step(deps, c)).claim.state;
    };
    const seen: [string, number][] = [];
    const host = { downtimeMs: (from: string, to: number) => { seen.push([from, to]); return 6 * 3_600_000; } } as unknown as DriverDeps["host"];
    expect(await run(host)).toMatchObject({ stage: "verify" });
    expect(seen).toHaveLength(1);
    expect(await run(undefined)).toMatchObject({ stage: "fix", checksRerun: true });
  }, 60_000);

  it("waits on pending checks and starts fix with the failing log (AC-14)", async () => {
    const { deps, claim, sha } = await setup((sha) => ({ plan: [plan], implement: [impl(sha)] }), (sha) => ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] }));
    const r = await driveChain(deps, claim, () => false);
    expect(r.state.stage).toBe("verify");
    deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: mockGitHub(ghRoutes(sha, { checks: [{ id: 1, name: "test", status: "completed", conclusion: "failure" }] })).fetch } }), "o/r");
    const s = await step(deps, r);
    expect(s.claim.state.stage).toBe("fix");
    expect(s.claim.state.pendingFixInput).toMatch(/check failed/);
  }, 60_000);

  it("retries a failed plan once, then escalates to a rescue plan with no label or notification (spec 006 AC-1)", async () => {
    const { deps, claim, notifications, adapter, gh } = await setup(() => ({ plan: [] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-fable-5-2"]);
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
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "implement:claude-sonnet-5-5", "implement:claude-sonnet-5-5"]);
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
    // The fix resolves the conflict by merging main; the next review runs on that head without a rebase (spec 024).
    let wtPath = "";
    const resolve = (run: StageRun) => { mergeMainResolved(run.worktree); return { head_sha: head(run.worktree), addressed: [] }; };
    const { deps, claim, adapter, paths, sha } = await setup(() => ({ fix: [resolve], review: [approve] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wtPath) } } }), (pair, wt) => { wtPath = wt; conflicting(pair, wt); });
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state.stage).toBe("fix");
    expect(r.claim.state.conflictPending).toBe(true);
    r = await step(deps, r.claim);
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5"]);
    expect(r.claim.state.stage).toBe("verify");
    expect(r.claim.state.conflictPending).toBe(false);
    expect(r.claim.state.fixes).toBe(1);
    const fixed = head(claim.worktree);
    expect(r.claim.state.pr?.head_sha).toBe(fixed);
    expect((await steps(deps, r.claim, 2)).state.stage).toBe("merge");
    expect(head(claim.worktree)).toBe(fixed);
    const fixRun = readdirSync(paths.runs).find((d) => d.startsWith("7-fix-"))!;
    const input = JSON.parse(readFileSync(join(paths.runs, fixRun, "input.json"), "utf8"));
    expect(input.fix_input).toMatch(/^Bring this branch up to date with origin\/main and resolve the conflicts before addressing the items below\.\norigin\/main conflicts with this branch:/);
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
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2"]);
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
    expect(logs).toContainEqual({ kind: "worktree-synced", issue: 7, pr: 9, dropped: local, patch: patchPath, rebased: false });
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

  it("fails a plain review run returning the conversation shape as a run, not a chain failure, then continues on approve (spec 044 AC-2, spec 091 AC-2)", async () => {
    const { deps, claim, gh, adapter, sha } = await setup(() => ({ review: [settled, approve] }), undefined);
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c: Claim = { ...claim, state: { ...claim.state, stage: "review", attempt: 1, plan: plan as never, pr: { number: 9, head_sha: sha } } };
    const r = await step(deps, c);
    expect(r.claim.state.history).toContain(`review attempt 1 failed: result: invalid: ${outside}`);
    expect(r.claim.state).toMatchObject({ stage: "review", attempt: 2, chainFailures: null, chainErrors: 0 });
    expect(logs.filter((l) => l.kind === "chain-error" || l.kind === "pending-work-failing")).toEqual([]);
    expect(gh.calls.some((x) => /\/pulls\/9\/(reviews|merge)/.test(x.url))).toBe(false);
    const r2 = await step(deps, r.claim);
    expect(adapter.ran.filter((x: string) => x.startsWith("review:"))).toHaveLength(2);
    expect(r2.claim.state.history.some((h: string) => h.startsWith("review attempt 2 failed"))).toBe(false);
    expect(r2.claim.state).toMatchObject({ stage: "merge", chainFailures: null, chainErrors: 0 });
  }, 60_000);

  it("fails an implement run returning the conversation shape with the same reason, not pr mismatch (spec 044 AC-3)", async () => {
    const { deps, claim, gh } = await setup(() => ({ plan: [plan], implement: [settled] }));
    let c2 = claim;
    let before = 0;
    for (let i = 0; i < 6 && !c2.state.history.some((h: string) => h.startsWith("implement attempt 1 failed")); i++) {
      before = gh.calls.length;
      c2 = (await step(deps, c2)).claim;
    }
    expect(c2.state.history).toContain(`implement attempt 1 failed: result: invalid: ${outside}`);
    expect(c2.state.history.some((h: string) => h.endsWith("result: pr mismatch"))).toBe(false);
    expect(gh.calls.slice(before).some((x) => x.url.includes("/pulls/"))).toBe(false);
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
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-fable-5-2"]);
    expect(c.state).toMatchObject({ stage: "plan", rescues: 1, rescueRun: true });
    expect(c.state.history.at(-1)).toContain("profile not available: firmware (implementation profiles: backend, web-ui)");
    expect(notifications).toEqual([]);
  }, 60_000);

  it("fails a plan whose domain names a stage profile (spec 077 AC-2)", async () => {
    const spec = { ...plan, domain: "spec" };
    const { deps, claim, adapter } = await setup(() => ({ plan: [spec, { ...spec }] }));
    const c = await steps(deps, claim, 3);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-fable-5-2"]);
    // plan-result.json's domain enum already refuses "spec" before the I4 check runs, so the plan fails as an invalid result.
    expect(c.state.history.at(-1)).toMatch(/profile not available: spec|result: invalid/);
    expect(c.state).toMatchObject({ stage: "plan", rescues: 1, rescueRun: true });
  }, 60_000);
});
describe("driver: escalation (spec 006 AC-1 to AC-5, AC-7)", () => {
  it("runs the rescue on the rescue model with the history in its prompt, and mirrors the counts to the ledger (AC-1, AC-7)", async () => {
    const { deps, claim, adapter, paths } = await setup(() => ({ plan: [] }));
    // The plan stage's own model is the configured rescue model, so a distinct id shows which one ran.
    deps.cfg = { ...deps.cfg, rescue_model: "claude-rescue-test" };
    const c = await steps(deps, claim, 4);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "plan:claude-fable-5-2", "plan:claude-rescue-test"]);
    expect(c.state.rescues).toBe(1);
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).rescues).toBe(1);
    const rescue = readdirSync(paths.runs).find((d) => d.startsWith("7-plan-1-") && d.includes("-rescue"))!;
    expect(readFileSync(join(paths.runs, rescue, "prompt.md"), "utf8")).toContain("plan: failed twice");
  }, 60_000);

  it("runs a rescued implement on the rescue model, not the stage's own (AC-1)", async () => {
    const { deps, claim, adapter } = await setup(() => ({ plan: [plan], implement: [] }));
    await steps(deps, claim, 5);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2", "implement:claude-sonnet-5-5", "implement:claude-sonnet-5-5", "implement:claude-fable-5-2"]);
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

  it("saves the last run's uncommitted work and unpushed commits before an abandonment removes the worktree (spec 005)", async () => {
    const lastRun = (run: StageRun) => {
      commitIn(run.worktree, { "work.txt": "w\n" });
      writeFileSync(join(run.worktree, "dirty.txt"), "d\n");
      return undefined; // the run fails
    };
    const { deps, claim, paths } = await setup(() => ({ plan: [lastRun] }));
    const c = at(claim, { stage: "plan", rescueRun: true, rescues: 1, replans: 1, specRevisions: 1 });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.status).toBe("ended");
    expect(existsSync(claim.worktree)).toBe(false);
    const saved = (kind: string) => readdirSync(paths.patches).filter((f) => f.includes(kind)).map((f) => readFileSync(join(paths.patches, f), "utf8"));
    expect(saved("abandoned-uncommitted")).toEqual([expect.stringContaining("dirty.txt")]);
    expect(saved("abandoned-commits")).toEqual([expect.stringContaining("work.txt")]);
  }, 60_000);

  it("applies a resumed issue's answered event as a transition: the fix bound re-plans, closing PR 9, recording the answer first (AC-15, T4)", async () => {
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
    expect(stored.state).toMatchObject({ stage: "spec", specMode: "record", track: "spec", answerQuestionIds: [555] });
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).pendingAnswer).toEqual({ ids: [555], kind: "technical", text: "Question #555: use a" });
    expect(r.claim.pendingEvent).toBeUndefined();
  }, 60_000);
});
describe("driver: PR binding (spec 006)", () => {
  it("does not bind a result to a closed PR (a crash after a re-plan's close_pr)", async () => {
    const { deps, claim, paths, sha } = await setup((sha) => ({ implement: [impl(sha)] }), (sha) => ghRoutes(sha, { prs: { 9: { headRef: "issue-7", head: sha, state: "closed" } } }));
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    expect((await step(deps, c)).claim.state.history).toContain("implement attempt 1 failed: result: pr mismatch");
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
    expect(ran).toEqual(["question-check:openai/gpt-6.1-sol", "question-check:claude-fable-5-2"]);
    const usage = readdirSync(paths.usage).map((f) => JSON.parse(readFileSync(join(paths.usage, f), "utf8")));
    expect(usage.map((u) => [u.stage, u.model]).sort()).toEqual([["question-check", "claude-fable-5-2"], ["question-check", "openai/gpt-6.1-sol"]]);
  }, 60_000);
});
let addedWt = "";
describe("driver: recorded answers in a fix (spec 006 AC-18)", () => {
  const recording = {
    recordAnswer: true, answerQuestionId: 555, answerQuestionIds: [555], answerKind: "technical" as const, recordIds: [555], recordKind: "technical" as const,
    answer: "Question #555: use a", pendingFixInput: "Record the decision.",
  };
  const adr = (wt: string) => ({ head_sha: commitIn(wt, { "docs/decisions/0001-store.md": "Use a. (maintainer answer, question #555)\n" }), addressed: [] });

  it("accepts a recording fix whose ADR carries the mark of each answer still to record, not of every answer of the chain (T3, TI1)", async () => {
    let wt = "";
    const { deps, claim, paths, sha } = await setup(() => ({ fix: [(run: StageRun) => adr(run.worktree)] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wt) } } }), (_p, w) => { wt = w; });
    const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, ...recording, answerQuestionId: 556, answerQuestionIds: [554, 555, 556], recordIds: [555] });
    await writeClaim(paths, c);
    expect((await step(deps, c)).claim.state.stage).toBe("verify");
  }, 60_000);

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

  it("an ADR the PR adds is in scope (C6); an edit to an ADR on main is in scope only while its mark is verified for this issue (Task 6 ruling)", async () => {
    const added = await setup(() => ({ fix: [(run: StageRun) => ({ head_sha: commitIn(run.worktree, { "docs/decisions/0002-own-call.md": "We chose b: one clearly right answer.\n" }), addressed: [] })] }),
      (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(addedWt) } } }), (_p, w) => { addedWt = w; });
    const ca = at(added.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: added.sha }, pendingFixInput: "Address the review." });
    await writeClaim(added.paths, ca);
    expect((await step(added.deps, ca)).claim.state.stage).toBe("verify");

    const files = withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec, "docs/decisions/0001-store.md": "Use b.\n" }, "specs/010-thing/spec.md");
    for (const logged of [7, 8, null]) {
      let wt = "";
      const { deps, claim, paths, sha } = await setup(() => ({ fix: [(run: StageRun) => adr(run.worktree)] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wt) } } }), (_p, w) => { wt = w; }, files);
      if (logged) await appendQuestionLog(paths, { issue: logged, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "review", question_comment_id: 555, reply_comment_id: 600, answer: "use a" });
      const c = at(claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, pendingFixInput: "Address the review." });
      await writeClaim(paths, c);
      const r = await step(deps, c);
      if (logged === 7) expect(r.claim.state.stage).toBe("verify");
      else {
        expect(r.claim.state.stage).toBe("fix");
        expect(r.claim.state.pendingFixInput).toContain("docs/decisions/0001-store.md: outside plan file scope");
      }
    }
  }, 60_000);
});
describe("driver: the chain keeps its work (spec 015)", () => {
  it("undoes its rebase after a postponed run, so three postponed retries write no dropped patch (AC-1, AC-2; issue #35)", async () => {
    const { deps, claim, pair, paths, sha } = await setup(() => ({}), undefined, prBehindMain);
    const adapter = rateLimited({ review: [undefined, undefined, undefined, approve] });
    deps.adapterFor = () => adapter;
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    let c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    for (let i = 0; i < 3; i++) {
      const r = await step(deps, c);
      expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "review" });
      // The worktree is back where the preparation found it: the PR's remote head.
      expect(head(claim.worktree)).toBe(sha);
      // The wait is over: the next step starts the review again.
      c = (await step(deps, at(r.claim, { postponedUntil: null }))).claim;
      expect(c.state.stage).toBe("review");
    }
    const r = await step(deps, c);
    expect(adapter.ran).toHaveLength(4);
    expect(r.claim.state.stage).toBe("merge");
    expect(logs.filter((l) => l.kind === "rebase-undone")).toHaveLength(3);
    expect(logs.find((l) => l.kind === "rebase-undone")).toMatchObject({ issue: 7, stage: "review", to: sha });
    expect(logs.filter((l) => l.kind === "worktree-synced" && l.dropped)).toEqual([]);
    expect(patchFiles(paths)).toEqual([]);
    // The review that ran saw the rebased head: main's commit is in it.
    expect(git(claim.worktree, "merge-base", "--is-ancestor", git(pair.repo, "rev-parse", "origin/main").trim(), "HEAD")).toBe("");
  }, 120_000);

  it("keeps a run's own commits: no rebase is undone when the run moved HEAD (AC-1)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({}), undefined, prBehindMain);
    const adapter = rateLimited({ review: [(run: StageRun) => { commitIn(run.worktree, { "notes.txt": "x\n" }, "run's own commit"); return undefined; }] });
    deps.adapterFor = () => adapter;
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state.stage).toBe("waiting");
    expect(logs.find((l) => l.kind === "rebase-undone")).toBeUndefined();
    expect(git(claim.worktree, "log", "-1", "--format=%s").trim()).toBe("run's own commit");
  }, 60_000);

  it("drops a rebased head left by a review without saving it as a patch (AC-3)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({ review: [approve] }), undefined, prBehindMain);
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const r1 = await step(deps, c);
    const rebased = head(claim.worktree);
    expect(rebased).not.toBe(sha);
    // Verify syncs the worktree to the PR's remote head, which the review did not move.
    await step(deps, at(r1.claim, { stage: "verify" }));
    expect(head(claim.worktree)).toBe(sha);
    expect(logs).toContainEqual({ kind: "worktree-synced", issue: 7, pr: 9, dropped: rebased, patch: null, rebased: true });
    expect(patchFiles(paths)).toEqual([]);
  }, 60_000);

  it("checks a finished run's result again after the step threw, without running the stage again (AC-10)", async () => {
    let pushed = "";
    let failures = 1;
    const routes = (sha: string) => ghRoutes(sha, { prs: { 9: { headRef: "issue-7", head: () => pushed } } }).map((r) =>
      r.method === "GET" && String(r.path) === String(/^\/repos\/o\/r\/pulls\/(\d+)$/) ? { ...r, reply: (m: RegExpExecArray, b: unknown, u: URL) => { if (failures-- > 0) throw dnsFailure(); return r.reply(m, b, u); } } : r);
    const { deps, claim, paths, adapter, gh } = await setup(() => ({
      implement: [(run: StageRun) => { pushed = commitIn(run.worktree, { "a.txt": "done\n" }, "implement"); git(run.worktree, "push", "-q", "-u", "origin", "issue-7"); return impl(pushed); }],
    }), routes);
    // Octokit's retry plugin would retry the failed request; the outage outlasts it.
    deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch }, retry: { enabled: false } }), "o/r");
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    await expect(step(deps, c)).rejects.toThrow(/EAI_AGAIN/);
    const kept = (await readClaim(paths, 7))!;
    expect(kept.stageRun).toMatchObject({ stage: "implement", attempt: 1, result: impl(pushed) });
    const r = await step(deps, kept);
    expect(adapter.ran).toEqual(["implement:claude-sonnet-5-5"]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "stage-result-kept", issue: 7, stage: "implement" }));
    expect(logs.find((l) => l.kind === "stale-branch-dropped" || l.kind === "recovered-commits")).toBeUndefined();
    expect(r.claim.state.pr).toEqual({ number: 9, head_sha: pushed });
    expect(r.claim.stageRun).toBeUndefined();
    expect((await readClaim(paths, 7))!.stageRun).toBeUndefined();
  }, 60_000);

  it("ignores and clears a recorded run of another stage or attempt (AC-10)", async () => {
    const { deps, claim, paths, adapter } = await setup(() => ({ plan: [plan] }));
    const c: Claim = { ...at(claim, { stage: "plan" }), stageRun: { stage: "plan", attempt: 2, run_id: "7-plan-2-x", result: plan, start: "0".repeat(40), security: false, sensitive: false } };
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-2"]);
    expect(r.claim.state.stage).toBe("implement");
    expect(r.claim.stageRun).toBeUndefined();
  }, 60_000);

  it("leaves the rebase alone when a postponed run left uncommitted changes (AC-1)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({}), undefined, prBehindMain);
    const adapter = rateLimited({ review: [(run: StageRun) => { writeFileSync(join(run.worktree, "scratch.txt"), "half done\n"); return undefined; }] });
    deps.adapterFor = () => adapter;
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state.stage).toBe("waiting");
    expect(logs.find((l) => l.kind === "rebase-undone")).toBeUndefined();
    expect(head(claim.worktree)).not.toBe(sha);
    expect(readFileSync(join(claim.worktree, "scratch.txt"), "utf8")).toBe("half done\n");
  }, 60_000);

  it("undoes the rebase after a failed (not postponed) run too, and the retry drops nothing (AC-1)", async () => {
    const { deps, claim, paths, sha, adapter } = await setup(() => ({ review: [undefined, approve] }), undefined, prBehindMain);
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    const r1 = await step(deps, c);
    expect(r1.claim.state).toMatchObject({ stage: "review", attempt: 2 });
    expect(head(claim.worktree)).toBe(sha);
    expect(logs.filter((l) => l.kind === "rebase-undone")).toHaveLength(1);
    await step(deps, r1.claim);
    expect(adapter.ran).toHaveLength(2);
    expect(logs.filter((l) => l.kind === "worktree-synced" && l.dropped)).toEqual([]);
    expect(patchFiles(paths)).toEqual([]);
  }, 60_000);

  it("re-applies the recorded run's event when an action after the transition threw, without running the stage again (AC-10)", async () => {
    let failures = 1;
    const routes = (sha: string) => ghRoutes(sha).map((r) =>
      r.method === "POST" && String(r.path) === String(/^\/repos\/o\/r\/issues\/\d+\/comments$/)
        ? { ...r, reply: (m: RegExpExecArray, b: unknown, u: URL) => { if (u.pathname.endsWith("/issues/9/comments") && failures-- > 0) throw dnsFailure(); return r.reply(m, b, u); } } : r);
    const { deps, claim, paths, adapter, gh, sha } = await setup(() => ({ review: [{ verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.txt", line: 1, scenario: "z" }], declined_to_judge: [] }] }), routes);
    deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch }, retry: { enabled: false } }), "o/r");
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    // The fix loop is spent and so is the rescue: changes requested re-plan, closing PR 9 (its comment fails the first time).
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha }, fixes: 2, rescues: 1 });
    await writeClaim(paths, c);
    await expect(step(deps, c)).rejects.toThrow(/EAI_AGAIN/);
    const kept = (await readClaim(paths, 7))!;
    expect(kept.state.stage).toBe("review");
    expect(kept.stageRun?.stage).toBe("review");
    const r = await step(deps, kept);
    expect(adapter.ran).toEqual(["review:claude-fable-5-2"]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "stage-result-kept", stage: "review" }));
    expect(logs).toContainEqual(expect.objectContaining({ kind: "pr-closed", pr: 9 }));
    expect(r.claim.state).toMatchObject({ stage: "plan", replans: 1, pr: null });
    expect(gh.calls.filter((x) => x.method === "POST" && x.url === "/repos/o/r/issues/9/comments")).toHaveLength(2);
  }, 60_000);
});
describe("driver: a full volume postpones runs (spec 059)", () => {
  it("refuses the launch before the worktree is synced: no run, no claim run_id, ENOSPC with the exact message (AC-3)", async () => {
    const { deps, claim, paths, pair } = await setup(() => ({}));
    const planning = (await step(deps, claim)).claim;
    expect(planning.state.stage).toBe("plan");
    // A marker commit on origin that syncWorktree would fetch and reset to.
    git(pair.repo, "commit", "--allow-empty", "-q", "-m", "marker");
    git(pair.repo, "push", "-q", "origin", "HEAD:main");
    const before = head(claim.worktree);
    const adapter = scriptedAdapter({});
    deps.adapterFor = () => adapter;
    deps.freeSpace = async (path) => ({ bytes: path === paths.root ? 100 * 2 ** 20 : 20 * 2 ** 30, inodes: 5000 });
    await expect(step(deps, planning)).rejects.toMatchObject({
      code: "ENOSPC",
      message: `host space low: ${paths.root} has 100 MiB free and 5000 free inodes (floor 512 MiB, 1000 inodes)`,
    });
    expect(adapter.ran).toEqual([]);
    expect(readdirSync(paths.runs)).toEqual([]);
    expect(head(claim.worktree)).toBe(before);
    expect((await readClaim(paths, 7))?.run_id).toBeNull();
  }, 60_000);

  it("rejects a host-refused run that ended ok: no stageRun, no result applied, the rebase undone (AC-4)", async () => {
    const { deps, claim, paths, sha } = await setup(() => ({}), undefined, prBehindMain);
    const base = rateLimited({ review: [approve] });
    const adapter = { ...base, hostRefusal: () => "ENOSPC" };
    deps.adapterFor = () => adapter;
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    await expect(step(deps, c)).rejects.toMatchObject({ code: "ENOSPC", message: expect.stringMatching(/^host refused every shell command in run 7-review-1-/) });
    expect(logs.find((l) => l.kind === "stage-host-refused")).toMatchObject({ issue: 7, stage: "review", attempt: 1, cause: "ENOSPC" });
    expect(logs.find((l) => l.kind === "rebase-undone")).toMatchObject({ stage: "review", to: sha });
    expect(head(claim.worktree)).toBe(sha);
    const saved = await readClaim(paths, 7);
    expect(saved?.stageRun).toBeUndefined();
    expect(saved?.run_id).toBeNull();
    expect(adapter.ran).toHaveLength(1);
    // The usage record was written: the tokens were spent.
    expect(readdirSync(paths.usage)).toHaveLength(1);
  }, 60_000);
});
describe("driver: a run that cannot reach the API waits out the outage (spec 092)", () => {
  async function run(adapter: ReturnType<typeof scriptedAdapter>, patch: Partial<ChainState> = { stage: "review" }, prepare = prBehindMain) {
    const w = await setup(() => ({}), undefined, prepare);
    w.deps.adapterFor = () => adapter;
    const logs: Record<string, unknown>[] = [];
    w.deps.log = (r) => { logs.push(r); };
    const c = at(w.claim, { plan: plan as never, pr: { number: 9, head_sha: w.sha }, ...patch });
    await writeClaim(w.paths, c);
    return { ...w, logs, c };
  }

  it("rejects the step with the cause, undoes the rebase, records no result and keeps resumeSession (AC-1)", async () => {
    const adapter = judgedAs({ review: [undefined] }, null, UNREACHABLE);
    const { deps, c, logs, paths, sha, claim } = await run(adapter, { stage: "review" });
    const error = await step(deps, c).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`run ${(logs.find((l) => l.kind === "stage-transient") as { run_id: string }).run_id} could not reach the model API: ${UNREACHABLE}`);
    expect(transientCause(error)).toBe("EAI_AGAIN");
    expect(logs.find((l) => l.kind === "stage-transient")).toMatchObject({ issue: 7, stage: "review", attempt: 1, cause: "EAI_AGAIN" });
    expect(logs.find((l) => l.kind === "rebase-undone")).toMatchObject({ to: sha });
    expect(head(claim.worktree)).toBe(sha);
    const saved = await readClaim(paths, 7);
    expect(saved?.stageRun).toBeUndefined();
    expect(saved?.run_id).toBeNull();
    expect(saved?.state.history).toEqual([]);
    expect(adapter.ran).toHaveLength(1);
    expect(readdirSync(paths.usage)).toHaveLength(1);
  }, 60_000);

  it("leaves resumeSession on the claim as it was, so the retry resumes the same session (AC-1)", async () => {
    const adapter = judgedAs({ review: [undefined] }, null, UNREACHABLE);
    const resumeSession = { harness: "fake", model: "m", session_id: "s1", worktree: "/tmp/wt" } as never;
    const { deps, c, paths } = await run(adapter, { stage: "review", resumeSession });
    await expect(step(deps, c)).rejects.toThrow(/could not reach the model API/);
    expect((await readClaim(paths, 7))?.state.resumeSession).toEqual(resumeSession);
  }, 60_000);

  it("a 5xx run carries its status; no fallback runs on an independent stage (AC-1)", async () => {
    const adapter = judgedAs({ review: [undefined, approve] }, 503, "overloaded");
    const { deps, c } = await run(adapter);
    const error = await step(deps, c).catch((e: unknown) => e as Error & { status?: number });
    expect((error as { status?: number }).status).toBe(503);
    expect(transientCause(error)).not.toBeNull();
    expect(adapter.ran).toHaveLength(1);
  }, 60_000);

  it("a rescue run rejects too, and a host-refused run still throws ENOSPC first (AC-1, AC-2)", async () => {
    const adapter = judgedAs({ review: [undefined] }, null, UNREACHABLE);
    const { deps, c } = await run(adapter, { stage: "review", rescueRun: true });
    await expect(step(deps, c)).rejects.toMatchObject({ message: expect.stringMatching(/could not reach the model API/) });
    const refused = { ...judgedAs({ review: [approve] }, null, UNREACHABLE), hostRefusal: () => "ENOSPC" };
    const w = await run(refused);
    await expect(step(w.deps, w.c)).rejects.toMatchObject({ code: "ENOSPC" });
  }, 60_000);

  it("a 429 still takes the rate-limit rules; genuine runs still fail the stage (AC-2, AC-4)", async () => {
    const cases: [number | null, string, "failed" | "timeout" | "bounds"][] = [
      [401, "ECONNRESET on login", "failed"], [null, "exit 1", "failed"], [null, UNREACHABLE, "timeout"], [null, UNREACHABLE, "bounds"],
    ];
    for (const [status, reason, outcome] of cases) {
      const adapter = judgedAs({ review: [undefined] }, status, reason, outcome);
      const { deps, c, logs } = await run(adapter);
      const r = await step(deps, c);
      expect(r.claim.state.history.some((h) => /^review attempt 1 failed/.test(h)) || r.claim.state.stage !== "review").toBe(true);
      expect(logs.some((l) => l.kind === "stage-transient")).toBe(false);
    }
    const limited = rateLimited({ review: [undefined] });
    const w = await run(limited);
    const r = await step(w.deps, w.c);
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "review" });
    expect(w.logs.some((l) => l.kind === "stage-transient")).toBe(false);
  }, 120_000);

  it("a transient implement run keeps the commits it left as held work, and nothing without commits (AC-3)", async () => {
    const withCommit = judgedAs({ implement: [(run: StageRun) => { commitIn(run.worktree, { "w.txt": "w\n" }); return undefined; }] }, null, UNREACHABLE);
    const a = await run(withCommit, { stage: "implement", pr: null });
    await expect(step(a.deps, a.c)).rejects.toThrow(/could not reach the model API/);
    const kept = (await readClaim(a.paths, 7))!;
    expect(kept.state.heldWork).toEqual([{ branch: "issue-7", head: head(a.claim.worktree), carried: UNREACHABLE }]);
    expect(a.logs.find((l) => l.kind === "held-work")).toMatchObject({ stage: "implement", carried: UNREACHABLE });

    const bare = judgedAs({ implement: [undefined] }, null, UNREACHABLE);
    const b = await run(bare, { stage: "implement", pr: null });
    await expect(step(b.deps, b.c)).rejects.toThrow(/could not reach the model API/);
    expect((await readClaim(b.paths, 7))!.state.heldWork).toEqual([]);
    expect(b.logs.some((l) => l.kind === "held-work")).toBe(false);
  }, 120_000);

  describe("a conversation turn (AC-2)", () => {
    const q: Question = { kind: "product", question: "Which layout?", options: [{ label: "second", cost: "none" }], recommendation: "second" };
    async function turn(script: Scripted) {
      const w = await run(judgedAs({ plan: [script] }, null, UNREACHABLE));
      const paused = { ...w.c.state, stage: "paused" as const, question: q, askingStage: "plan" as const, resumeSession: { harness: "fake" as const, model: "m", session_id: "s", worktree: w.claim.worktree } };
      w.c.state = transition(paused, { type: "answered", answer: "second", questionId: 1 }).state;
      return w;
    }

    it("a transient turn that changed the worktree is restored and fails with the worktree reason", async () => {
      const w = await turn((r: StageRun) => { writeFileSync(join(r.worktree, "a.txt"), "forbidden\n"); return undefined; });
      writeFileSync(join(w.claim.worktree, "a.txt"), "kept\n");
      const r = await step(w.deps, w.c);
      expect(readFileSync(join(w.claim.worktree, "a.txt"), "utf8")).toBe("kept\n");
      expect(r.claim.state.conversation?.retried).toBe(true);
      expect(w.logs.some((l) => l.kind === "stage-transient")).toBe(false);
    }, 60_000);

    it("a transient turn that changed nothing rejects the step and does not spend the retry", async () => {
      const w = await turn(() => undefined);
      await expect(step(w.deps, w.c)).rejects.toThrow(/could not reach the model API/);
      expect(w.logs.some((l) => l.kind === "stage-transient")).toBe(true);
      expect((await readClaim(w.paths, 7))?.state.conversation?.retried).toBeFalsy();
    }, 60_000);
  });
});
describe("driver: a check failing outside the PR's scope (spec 060)", () => {
  const failedRun: Record<string, unknown> = { id: 41, name: "test", status: "completed", conclusion: "failure", details_url: "https://github.com/o/r/actions/runs/500/job/600" };
  const logRoute: Route = { method: "GET", path: /^\/repos\/o\/r\/actions\/jobs\/\d+\/logs$/, reply: () => ({ body: "FAIL tools/design-stage/test/render.test.ts\n" }) };
  /** ghRoutes for spec-7 whose check-runs answer per sha: `byRef(sha)` returns the runs or a status to fail with. */
  const routesFor = (sha: string, byRef: (ref: string) => unknown[] | number, rerequest = 201): Route[] => [
    ...ghRoutes(sha, { headRef: "spec-7", prs: { 9: { headRef: "spec-7" } } }).filter((r) => !/check-runs|rerequest/.test(String(r.path))),
    {
      method: "GET", path: /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/check-runs$/,
      reply: (m) => { const r = byRef(m[1]); return typeof r === "number" ? { status: r, body: { message: "boom" } } : { body: { total_count: r.length, check_runs: r } }; },
    },
    { method: "POST", path: /^\/repos\/o\/r\/actions\/runs\/(\d+)\/rerun-failed-jobs$/, reply: () => ({ status: rerequest, body: rerequest === 201 ? {} : { message: "no" } }) },
    logRoute,
  ];
  const verifyingSpec = (claim: Claim, sha: string, over: Partial<ChainState> = {}): Claim => ({ ...claim, state: { ...claim.state, stage: "verify", track: "spec", pr: { number: 9, head_sha: sha }, ...over } });
  const mainSha = (pair: ReturnType<typeof repoPair>) => git(pair.repo, "rev-parse", "origin/main").trim();

  it("reads main's checks with the PR's failure; a failure there too blocks with a record, no claim, the worktree and the label kept (AC-1, AC-2, AC-4)", async () => {
    const { deps, claim, gh, paths, sha, pair } = await setup(() => ({}), (sha) => routesFor(sha, () => [failedRun]), onSpec7);
    const base = mainSha(pair);
    const r = await step(deps, verifyingSpec(claim, git(claim.worktree, "rev-parse", "HEAD").trim()));
    expect(r.status).toBe("ended");
    expect(gh.calls.some((c) => c.url.startsWith(`/repos/o/r/commits/${base}/check-runs`))).toBe(true);
    expect(await listClaims(paths)).toEqual([]);
    const rec = JSON.parse(readFileSync(join(paths.blocked, "7.json"), "utf8"));
    expect(rec).toMatchObject({ issue: 7, worktree: claim.worktree, condition: { kind: "main_green", check: "test", main_sha: base }, state: { stage: "blocked" } });
    expect(validate("blocked", rec)).toEqual({ ok: true });
    expect(existsSync(claim.worktree)).toBe(true);
    expect(gh.calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/labels/in-progress"))).toEqual([]);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toHaveLength(1);
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(sha).toHaveLength(40);
  }, 60_000);

  it("a main read that fails is logged and blocks nothing; the first failure is re-run once, a refusal is logged (AC-1, AC-3)", async () => {
    const { deps, claim, gh, pair } = await setup(() => ({}), (sha) => routesFor(sha, (ref) => (ref === mainSha(pair) ? 422 : [failedRun]), 422), onSpec7);
    const logs: Record<string, unknown>[] = [];
    deps.log = (rec) => { logs.push(rec); };
    deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [0, 0, 0] });
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    const r = await step(deps, verifyingSpec(claim, head));
    expect(logs.find((l) => l.kind === "main-checks-unknown")).toMatchObject({ issue: 7, error: expect.any(String) });
    expect(logs.find((l) => l.kind === "rerun-check-refused")).toMatchObject({ issue: 7, id: 41, run_id: 500, reason: "not re-runnable" });
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "verify", checkRerun: head, fixes: 0 });
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/rerun-failed-jobs"))).toHaveLength(1);
  }, 60_000);

  const rerunWorld = async (runs: unknown[], status = 201) => {
    const { deps, claim, gh, pair } = await setup(() => ({}), (sha) => routesFor(sha, (ref) => (ref === mainSha(pair) ? 422 : runs), status), onSpec7);
    const logs: Record<string, unknown>[] = [];
    deps.log = (rec) => { logs.push(rec); };
    deps.gh = new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [0, 0, 0] });
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    const r = await step(deps, verifyingSpec(claim, head));
    return { logs, r, gh, head };
  };

  it("AC-2 (spec 101): the re-run posts rerun-failed-jobs for the run id in details_url and never the check-run rerequest", async () => {
    const { logs, r, gh, head } = await rerunWorld([failedRun]);
    expect(logs.find((l) => l.kind === "rerun-check")).toMatchObject({ issue: 7, sha: head, id: 41, run_id: 500 });
    expect(gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/actions/runs/500/rerun-failed-jobs")).toHaveLength(1);
    expect(gh.calls.some((c) => c.url.endsWith("/rerequest"))).toBe(false);
    expect(r.status).toBe("waiting");
  }, 60_000);

  it("AC-2 (spec 101): a check run without a workflow run in details_url is refused with its reason and the step still waits", async () => {
    const { logs, r, gh } = await rerunWorld([{ ...failedRun, details_url: null }]);
    expect(logs.find((l) => l.kind === "rerun-check-refused")).toMatchObject({ issue: 7, id: 41, reason: "no workflow run in details_url" });
    expect(gh.calls.some((c) => c.url.endsWith("/rerun-failed-jobs"))).toBe(false);
    expect(r.status).toBe("waiting");
  }, 60_000);

  it("AC-2 (spec 101): any other error is logged rerun-check-error and is not thrown", async () => {
    const { logs, r } = await rerunWorld([failedRun], 500);
    expect(logs.find((l) => l.kind === "rerun-check-error")).toMatchObject({ issue: 7, id: 41, error: expect.any(String) });
    expect(r.status).toBe("waiting");
  }, 60_000);

  it("AC-4 (spec 101): a fix after an unchanged head without a verdict starts with the paragraph", async () => {
    const { deps, claim, paths } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), (sha) => routesFor(sha, () => [failedRun]), onSpec7);
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    const base = verifyingSpec(claim, head);
    const atFix: Claim = { ...base, state: { ...base.state, stage: "fix", pendingFixInput: `A required check failed:\ntest\nFAIL x`, checkRerun: head, unchangedWithoutVerdict: true } };
    await step({ ...deps, gh: deps.gh }, atFix).catch(() => {});
    const fixRun = readdirSync(paths.runs).find((d) => d.startsWith("7-fix-"))!;
    const input = JSON.parse(readFileSync(join(paths.runs, fixRun, "input.json"), "utf8"));
    expect(input.fix_input.startsWith(`${UNCHANGED_WITHOUT_VERDICT_PARAGRAPH}\n\nA required check failed:\ntest\nFAIL x`)).toBe(true);
    expect(input.fix_input.endsWith(OUT_OF_SCOPE_PARAGRAPH)).toBe(true);
    expect(UNCHANGED_WITHOUT_VERDICT_PARAGRAPH.startsWith("The previous fix run returned the head unchanged and no `out_of_scope` verdict.")).toBe(true);
  }, 60_000);

  it("the fix input of a failed check on a spec PR ends with the out-of-scope paragraph (AC-5)", async () => {
    const { deps, claim, paths, pair } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), (sha) => routesFor(sha, () => [failedRun]), onSpec7);
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    const atFix: Claim = { ...verifyingSpec(claim, head), state: { ...verifyingSpec(claim, head).state, stage: "fix", pendingFixInput: `A required check failed:\ntest\nFAIL x`, checkRerun: head } };
    await step({ ...deps, gh: deps.gh }, atFix).catch(() => {});
    const fixRun = readdirSync(paths.runs).find((d) => d.startsWith("7-fix-"))!;
    const input = JSON.parse(readFileSync(join(paths.runs, fixRun, "input.json"), "utf8"));
    expect(input.fix_input.startsWith("A required check failed:\ntest\nFAIL x")).toBe(true);
    expect(input.fix_input).toContain(OUT_OF_SCOPE_PARAGRAPH);
    expect(pair.root).toBeTruthy();
  }, 60_000);

  const unblocked = (claim: Claim, head: string): Claim => ({
    ...claim, pendingEvent: { type: "unblocked", main_sha: "0".repeat(40) },
    state: { ...claim.state, stage: "blocked", track: "spec", pr: { number: 9, head_sha: head }, blocked: { on: null, since: null, check: "test", main_sha: null, blocks: 1 } },
  });

  it("rebase_push pushes a rebased head with a lease and binds it; an unchanged head pushes nothing (AC-8)", async () => {
    const { deps, claim, pair } = await setup(() => ({}), (sha) => routesFor(sha, () => [{ id: 41, name: "test", status: "completed", conclusion: "success" }]), onSpec7);
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    // Nothing moved: no push, the same head.
    const same = await step(deps, unblocked(claim, head));
    expect(same.claim.state).toMatchObject({ stage: "verify", pr: { head_sha: head } });
    expect(git(pair.origin, "rev-parse", "spec-7").trim()).toBe(head);
    // Main moves with an unrelated file: the PR is rebased and pushed.
    writeFileSync(join(pair.repo, "other.txt"), "other\n");
    git(pair.repo, "add", "-A");
    git(pair.repo, "commit", "-q", "-m", "main moves");
    git(pair.repo, "push", "-q", "origin", "main");
    const moved = await step(deps, unblocked(claim, head));
    const pushed = git(pair.origin, "rev-parse", "spec-7").trim();
    expect(pushed).not.toBe(head);
    expect(moved.claim.state.pr?.head_sha).toBe(pushed);
    expect(git(pair.origin, "merge-base", "--is-ancestor", git(pair.origin, "rev-parse", "main").trim(), "spec-7")).toBe("");
  }, 60_000);

  it("a conflict on resume goes to the fix as spec 024's rebase_conflict (AC-8)", async () => {
    const { deps, claim, pair } = await setup(() => ({}), (sha) => routesFor(sha, () => [{ id: 41, name: "test", status: "completed", conclusion: "success" }]), onSpec7);
    const head = git(claim.worktree, "rev-parse", "HEAD").trim();
    writeFileSync(join(claim.worktree, "a.txt"), "pr\n");
    git(claim.worktree, "commit", "-q", "-am", "pr change");
    git(claim.worktree, "push", "-q", "origin", "spec-7");
    const prHead = git(claim.worktree, "rev-parse", "HEAD").trim();
    writeFileSync(join(pair.repo, "a.txt"), "main\n");
    git(pair.repo, "commit", "-q", "-am", "main change");
    git(pair.repo, "push", "-q", "origin", "main");
    const r = await step(deps, unblocked(claim, prHead));
    expect(r.claim.pendingEvent).toMatchObject({ type: "rebase_conflict" });
    expect(r.claim.state.pr?.head_sha).toBe(prHead);
    const next = await step(deps, r.claim);
    expect(next.claim.state).toMatchObject({ stage: "fix", conflictPending: true });
    expect(head).toHaveLength(40);
  }, 60_000);
});
describe("driver: verify does not wait on a PR that conflicts with main (spec 097)", () => {
  /** spec-7 with the given check runs on every sha; PR #9's `mergeable` as GitHub reports it (null: still computing). */
  const routesFor = (sha: string, mergeable: boolean | null, checks: unknown[] = []): Route[] => [
    {
      method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/,
      reply: () => ({ body: { number: 9, base: { ref: "main" }, head: { ref: "spec-7", sha }, html_url: "u", body: "", mergeable, mergeable_state: mergeable === false ? "dirty" : "unknown", merged: false, state: "open" } }),
    },
    ...ghRoutes(sha, { headRef: "spec-7", checks, prs: { 9: { headRef: "spec-7" } } }),
  ];
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const verifying = (claim: Claim, sha: string, pendingSince: string | null = hoursAgo(1)): Claim => ({
    ...claim, state: { ...claim.state, stage: "verify", track: "spec", pr: { number: 9, head_sha: sha }, pendingSince },
  });
  const prReads = (gh: ReturnType<typeof mockGitHub>) => gh.calls.filter((c) => c.method === "GET" && c.url === "/repos/o/r/pulls/9").length;
  const mainMoves = (pair: ReturnType<typeof repoPair>, file: string, text: string) => {
    writeFileSync(join(pair.repo, file), text);
    git(pair.repo, "add", "-A");
    git(pair.repo, "commit", "-q", "-m", "main moves");
    git(pair.repo, "push", "-q", "origin", "main");
  };

  it("a conflicting PR with no check run is rebased and pushed at once; verify goes on with the new head and a new window (AC-1, AC-2)", async () => {
    const { deps, claim, gh, pair } = await setup(() => ({}), (sha) => routesFor(sha, false), onSpec7);
    const logs: Record<string, unknown>[] = [];
    deps.log = (rec) => { logs.push(rec); };
    const before = head(claim.worktree);
    mainMoves(pair, "other.txt", "other\n");
    const r = await step(deps, verifying(claim, before));
    const pushed = git(pair.origin, "rev-parse", "spec-7").trim();
    expect(pushed).not.toBe(before);
    expect(git(pair.origin, "merge-base", "--is-ancestor", git(pair.origin, "rev-parse", "main").trim(), "spec-7")).toBe("");
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "verify", pr: { number: 9, head_sha: pushed }, pendingSince: null, fixes: 0, checksRerun: false });
    expect(r.claim.pendingEvent).toBeUndefined();
    expect(prReads(gh)).toBe(1);
    expect(logs.find((l) => l.kind === "verify-not-mergeable")).toMatchObject({ issue: 7, pr: 9, sha: before });
  }, 60_000);

  it("a conflicting PR whose rebase conflicts goes to the fix told the conflict and its paths, before the bound (AC-1)", async () => {
    const { deps, claim, pair } = await setup(() => ({}), (sha) => routesFor(sha, false), onSpec7);
    writeFileSync(join(claim.worktree, "a.txt"), "pr\n");
    git(claim.worktree, "commit", "-q", "-am", "pr change");
    git(claim.worktree, "push", "-q", "origin", "spec-7");
    const prHead = head(claim.worktree);
    mainMoves(pair, "a.txt", "main\n");
    const r = await step(deps, verifying(claim, prHead));
    expect(r.status).toBe("waiting");
    expect(r.claim.pendingEvent).toMatchObject({ type: "rebase_conflict", detail: expect.stringContaining("a.txt") });
    expect(r.claim.state).toMatchObject({ stage: "verify", pr: { head_sha: prHead } });
    expect(git(pair.origin, "rev-parse", "spec-7").trim()).toBe(prHead);
    const next = await step(deps, r.claim);
    expect(next.claim.state).toMatchObject({ stage: "fix", conflictPending: true, checksRerun: false, pendingSince: null });
    expect(next.claim.state.pendingFixInput).toMatch(/^origin\/main conflicts with this branch:\n[\s\S]*CONFLICT[\s\S]*a\.txt/);
    expect(next.claim.state.history.at(-1)).toMatch(/^origin\/main conflicted before verify/);
  }, 60_000);

  it("mergeable null (GitHub still computing) keeps waiting, with nothing rebased (AC-1)", async () => {
    const { deps, claim, gh, pair } = await setup(() => ({}), (sha) => routesFor(sha, null), onSpec7);
    const before = head(claim.worktree);
    const since = hoursAgo(1);
    mainMoves(pair, "other.txt", "other\n");
    const r = await step(deps, verifying(claim, before, since));
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "verify", pr: { head_sha: before }, pendingSince: since });
    expect(r.claim.pendingEvent).toBeUndefined();
    expect(git(pair.origin, "rev-parse", "spec-7").trim()).toBe(before);
    expect(prReads(gh)).toBe(1);
  }, 60_000);

  it("a mergeable PR whose checks never report still takes the six-hour path (AC-3)", async () => {
    const { deps, claim, pair } = await setup(() => ({}), (sha) => routesFor(sha, true), onSpec7);
    const before = head(claim.worktree);
    mainMoves(pair, "other.txt", "other\n");
    const r = await step(deps, verifying(claim, before, hoursAgo(6.1)));
    expect(r.claim.state).toMatchObject({ stage: "fix", checksRerun: true, pendingSince: null, conflictPending: false, pr: { head_sha: before } });
    expect(r.claim.state.pendingFixInput).toMatch(/^Required checks test have been pending for 6 hours/);
    expect(git(pair.origin, "rev-parse", "spec-7").trim()).toBe(before);
  }, 60_000);

  it("a required check that has a run reads no PR (AC-4)", async () => {
    const running = [{ id: 1, name: "test", status: "in_progress", conclusion: null }];
    const { deps, claim, gh } = await setup(() => ({}), (sha) => routesFor(sha, false, running), onSpec7);
    const r = await step(deps, verifying(claim, head(claim.worktree)));
    expect(r.claim.state).toMatchObject({ stage: "verify" });
    expect(r.claim.pendingEvent).toBeUndefined();
    expect(prReads(gh)).toBe(0);
  }, 60_000);
});
describe("driver: spec and ADR numbers are reserved by the scheduler (spec 065)", () => {
  const otherClaim = (issue: number, reserved: { spec: number | null; adr: number | null }, wt: string): Claim =>
    ({ issue, state: { ...initialChainState(issue), reserved }, worktree: wt, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null });
  const specAt = (n: string, extra: Record<string, string> = {}) => (run: StageRun) =>
    ({ verdict: "revised", spec_path: `specs/${n}-thing/spec.md`, pr_number: 12, head_sha: commitIn(run.worktree, { [`specs/${n}-thing/spec.md`]: spec, ...extra }) });

  async function env(results: Record<string, Scripted[]>, over: RouteOver = {}) {
    let wt = "";
    const files = withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec, "docs/decisions/0005-x.md": "x\n" }, "specs/010-thing/spec.md");
    const prs = { 9: { headRef: "issue-7", head: () => head(wt) }, 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } };
    const t = await setup(() => results, (sha) => ghRoutes(sha, { issueBody: "Do the thing.", prs, ...over }), (_p, w) => { wt = w; }, files);
    const logs: Record<string, unknown>[] = [];
    t.deps.log = (rec) => { logs.push(rec); };
    const reserved = (rec: Record<string, unknown>) => logs.filter((l) => l.kind === "number-reserved" && Object.keys(rec).every((k) => l[k] === rec[k]));
    const specClaim = at(t.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(t.paths, specClaim);
    return { ...t, logs, reserved, specClaim };
  }
  const issuePatched = (gh: { calls: { method: string; url: string }[] }) => gh.calls.some((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7");

  it("reserves the next spec and ADR number past main and the other claims, logs it, and gives it again on the retry (AC-1, AC-2)", async () => {
    const t = await env({ spec: [undefined, undefined] });
    await writeClaim(t.paths, otherClaim(8, { spec: 11, adr: 6 }, "/w8"));
    const r = await step(t.deps, t.specClaim);
    expect(inputOf(t.paths, "7-spec-1-")).toMatchObject({ spec_number: "012", adr_number: "0007" });
    expect(validate("stage-input", inputOf(t.paths, "7-spec-1-")).ok).toBe(true);
    expect(t.reserved({ issue: 7, spec: "012", adr: "0007" })).toHaveLength(1);
    // The failed run frees the ADR number and keeps the spec number.
    expect(r.claim.state.reserved).toEqual({ spec: 12, adr: null });
    expect((await readClaim(t.paths, 7))!.state.reserved.spec).toBe(12);
    await step(t.deps, r.claim);
    expect(inputOf(t.paths, "7-spec-2-")).toMatchObject({ spec_number: "012" });
    expect(t.reserved({ spec: "012" })).toHaveLength(1);
  }, 60_000);

  it("counts the specs an open pull request adds, however it was made (AC-1)", async () => {
    const t = await env({ spec: [undefined] }, { openPrs: [{ number: 30, added: ["specs/011-hand/spec.md", "docs/decisions/0008-hand.md"] }] });
    await step(t.deps, t.specClaim);
    expect(inputOf(t.paths, "7-spec-1-")).toMatchObject({ spec_number: "012", adr_number: "0009" });
  }, 60_000);

  it("reserves no spec number when the issue has a Spec: line, and the spec_number is (none) (AC-1)", async () => {
    const t = await env({ spec: [undefined] }, { issueBody: "Spec: specs/010-thing/spec.md" });
    const r = await step(t.deps, t.specClaim);
    expect(inputOf(t.paths, "7-spec-1-").spec_number).toBeUndefined();
    expect(inputOf(t.paths, "7-spec-1-").adr_number).toBe("0006");
    expect(r.claim.state.reserved.spec).toBeNull();
  }, 60_000);

  it("postpones the run, reserving nothing, when the open pull requests cannot be read (AC-1)", async () => {
    const t = await env({ spec: [specAt("011")] });
    t.gh.routes.unshift({ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ status: 500, body: { message: "down" } }) });
    const r = await step(t.deps, t.specClaim);
    expect(t.adapter.ran).toEqual([]);
    expect(t.reserved({})).toEqual([]);
    expect(r.claim.state.reserved).toEqual({ spec: null, adr: null });
    expect(r.claim.state.history.join()).not.toMatch(/spec attempt 1 failed/);
  }, 60_000);

  it("appends the Spec: line for the reserved number and clears the reservation (AC-3)", async () => {
    const t = await env({ spec: [specAt("011", { "docs/decisions/0006-mine.md": "adr\n" })] });
    const r = await step(t.deps, t.specClaim);
    expect(t.gh.calls.find((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")?.body).toEqual({ body: "Do the thing.\n\nSpec: specs/011-thing/spec.md" });
    expect(r.claim.state.reserved).toEqual({ spec: null, adr: null });
  }, 60_000);

  it("fails a spec result with another number before the Spec: line is written, and the retry is given the reserved one (AC-3)", async () => {
    const t = await env({ spec: [specAt("012"), undefined] });
    const r = await step(t.deps, t.specClaim);
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: spec number 012 is not the reserved 011");
    expect(issuePatched(t.gh)).toBe(false);
    await step(t.deps, r.claim);
    expect(inputOf(t.paths, "7-spec-2-").spec_number).toBe("011");
  }, 60_000);

  it("names the holder of a spec or ADR number the branch adds: another PR, main or another claim's reservation (AC-3)", async () => {
    const cases: [string, Record<string, string>, string, { number: number; added: string[] }[]][] = [
      ["PR", { "docs/decisions/0006-mine.md": "a\n" }, "result: ADR 0006 is held by PR #30", [{ number: 30, added: ["docs/decisions/0006-other.md"] }]],
      ["main", { "docs/decisions/0005-mine.md": "a\n" }, "result: ADR 0005 is held by docs/decisions/0005-x.md", []],
      ["claim", { "docs/decisions/0009-mine.md": "a\n" }, "result: ADR 0009 is held by issue #8's reservation", []],
    ];
    for (const [name, extra, reason, openPrs] of cases) {
      const t = await env({ spec: [specAt("011", extra)] }, { openPrs });
      await writeClaim(t.paths, otherClaim(8, { spec: null, adr: 9 }, "/w8"));
      const r = await step(t.deps, t.specClaim);
      expect(r.claim.state.history, name).toContain(`spec attempt 1 failed: ${reason}`);
      expect(issuePatched(t.gh), name).toBe(false);
    }
  }, 120_000);

  it("fails a spec directory another open PR holds, naming the PR (AC-3)", async () => {
    // The hand-made PR is not visible when the number is reserved: it opens while the stage runs.
    let open: { number: number; added: string[] }[] = [];
    const t = await env({ spec: [(run: StageRun) => { open.push({ number: 31, added: ["specs/011-hand/spec.md"] }); return specAt("011")(run); }] });
    t.gh.routes.unshift({ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: open.map((p) => ({ number: p.number })) }) },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/31\/files$/, reply: () => ({ body: [{ filename: "specs/011-hand/spec.md", status: "added" }] }) });
    const r = await step(t.deps, t.specClaim);
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: spec number 011 is held by PR #31");
    expect(issuePatched(t.gh)).toBe(false);
  }, 60_000);

  const implPlan = { ...plan, tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
  it("passes an implement result adding its reserved ADR and frees the number; fails one adding a held ADR (AC-2, AC-4)", async () => {
    const adr = (name: string) => (run: StageRun) => { commitIn(run.worktree, { [`docs/decisions/${name}`]: "adr\n" }); return impl(head(run.worktree)); };
    const ok = await env({ implement: [adr("0006-mine.md")] }, { issueBody: "Spec: specs/010-thing/spec.md" });
    const okClaim = at(ok.claim, { stage: "implement", plan: implPlan as never });
    const done = await step(ok.deps, okClaim);
    expect(inputOf(ok.paths, "7-implement-1-").adr_number).toBe("0006");
    expect(done.claim.state).toMatchObject({ stage: "verify", reserved: { spec: null, adr: null } });

    const held = await env({ implement: [adr("0006-mine.md")] }, { issueBody: "Spec: specs/010-thing/spec.md" });
    held.gh.routes.unshift({ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.has("head") ? [] : [{ number: 30 }] }) },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/30\/files$/, reply: () => ({ body: [{ filename: "docs/decisions/0006-other.md", status: "added" }] }) });
    // Reserved 0007 past the other PR, so the 0006 the run takes is held.
    const failed = await step(held.deps, at(held.claim, { stage: "implement", plan: implPlan as never }));
    expect(inputOf(held.paths, "7-implement-1-").adr_number).toBe("0007");
    expect(failed.claim.state.history.join("\n")).toContain("result: ADR 0006 is held by PR #30");
    expect(failed.claim.state.reserved.adr).toBeNull();
  }, 120_000);

  it("counts the chain's own PR's added ADR when reserving for the fix stage (AC-2)", async () => {
    const t = await env({ fix: [(run: StageRun) => ({ head_sha: head(run.worktree), addressed: [] })] }, { issueBody: "Spec: specs/010-thing/spec.md" });
    t.gh.routes.unshift({ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.has("head") ? [] : [{ number: 9 }] }) },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9\/files$/, reply: () => ({ body: [{ filename: "docs/decisions/0006-mine.md", status: "added" }] }) });
    await step(t.deps, at(t.claim, { stage: "fix", plan: implPlan as never, pr: { number: 9, head_sha: t.sha }, pendingFixInput: "fix it" }));
    expect(inputOf(t.paths, "7-fix-1-").adr_number).toBe("0007");
  }, 60_000);

  it("fails a fix result adding a held ADR (AC-4)", async () => {
    const t = await env({ fix: [(run: StageRun) => { commitIn(run.worktree, { "docs/decisions/0005-again.md": "adr\n" }); return { head_sha: head(run.worktree), addressed: [] }; }] }, { issueBody: "Spec: specs/010-thing/spec.md" });
    const c = at(t.claim, { stage: "fix", plan: implPlan as never, pr: { number: 9, head_sha: t.sha }, pendingFixInput: "fix it" });
    const r = await step(t.deps, c);
    expect(r.claim.state.history.join("\n")).toContain("result: ADR 0005 is held by docs/decisions/0005-x.md");
  }, 60_000);
});
describe("driver: a spec PR moves its spec (spec 071)", () => {
  const body = (line: string) => `Do the thing.\n\nSpec: ${line}\n\nTrailer`;
  const topWith = (...specs: string[]) => `# Top design\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n${specs.map((s) => `- \`${s}\`\n`).join("")}`;
  const bodyPatch = (gh: { calls: { method: string; url: string; body?: unknown }[] }) => gh.calls.find((x) => x.method === "PATCH" && x.url === "/repos/o/r/issues/7")?.body as { body: string } | undefined;

  /** The spec PR holds `line`; main holds `mainHas` (a spec directory) when given. */
  async function env(results: (sha: string) => Record<string, Scripted[]>, line: string, opts: { mainHas?: string; openPrs?: { number: number; added: string[] }[]; others?: Claim[]; track?: "spec" | "issue" } = {}) {
    let wt = "";
    const files = withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec, ...(opts.mainHas ? { [`${opts.mainHas}/spec.md`]: spec } : {}) }, "specs/010-thing/spec.md");
    const prs = { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } };
    const t = await setup(results, (sha) => ghRoutes(sha, { issueBody: body(line), prs, openPrs: opts.openPrs }), (_p, w) => {
      wt = w;
      git(w, "checkout", "-q", "-b", "spec-7");
      commitIn(w, { [line]: spec, "docs/top.md": topWith(line) }, "spec work");
      git(w, "push", "-q", "-u", "origin", "spec-7");
    }, files);
    const logs: Record<string, unknown>[] = [];
    t.deps.log = (rec) => { logs.push(rec); };
    for (const o of opts.others ?? []) await writeClaim(t.paths, o);
    const c = at(t.claim, { stage: "fix", track: "spec", pr: { number: 12, head_sha: t.sha }, pendingFixInput: "Fix it." });
    await writeClaim(t.paths, c);
    return { ...t, logs, c, of: (k: string) => logs.filter((l) => l.kind === k) };
  }
  /** The fix: `git mv` the old directory to the new one (or copy it), fix the parent's bullet, and report `spec_path`. */
  const moveFix = (from: string, to: string, o: { copy?: boolean; report?: string | null } = {}) => (run: StageRun) => {
    const wt = run.worktree;
    if (o.copy) execFileSync("cp", ["-r", join(wt, from), join(wt, to)]);
    else git(wt, "mv", from, to);
    const sha = commitIn(wt, { "docs/top.md": topWith(`${to}/spec.md`) }, "move");
    const report = o.report === undefined ? `${to}/spec.md` : o.report;
    return { head_sha: sha, addressed: [], ...(report === null ? {} : { spec_path: report }) };
  };
  const other = (issue: number, spec_: number | null): Claim =>
    ({ issue, state: { ...initialChainState(issue), reserved: { spec: spec_, adr: null } }, worktree: `/w${issue}`, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null });

  it("replays issue #41: the rename without spec_path fails with the three violations; with it the scope is ok, the line is rewritten and the reservation spent (AC-1, AC-5, AC-7)", async () => {
    const bad = await env(() => ({ fix: [moveFix("specs/030-x", "specs/031-x", { report: null })] }), "specs/030-x/spec.md", { mainHas: "specs/030-other" });
    const r0 = await step(bad.deps, bad.c);
    expect(inputOf(bad.paths, "7-fix-1-").spec_number).toBe("031");
    expect(r0.claim.state.pendingFixInput).toContain("specs/030-x/spec.md: no Parent line");
    expect(r0.claim.state.pendingFixInput).toContain("docs/top.md: outside spec PR scope");
    expect(r0.claim.state.pendingFixInput).toContain("specs/031-x/spec.md: another spec; specs/030-x/spec.md does not link to it");
    expect(bodyPatch(bad.gh)).toBeUndefined();

    const t = await env(() => ({ fix: [moveFix("specs/030-x", "specs/031-x")] }), "specs/030-x/spec.md", { mainHas: "specs/030-other" });
    const r = await step(t.deps, t.c);
    expect(inputOf(t.paths, "7-fix-1-").spec_number).toBe("031");
    expect(t.of("number-reserved").map((l) => l.spec)).toEqual(["031"]);
    expect(r.claim.state.history.join()).not.toMatch(/failed/);
    expect(r.claim.state.pendingFixInput ?? "").not.toContain("outside spec PR scope");
    expect(bodyPatch(t.gh)).toEqual({ body: body("specs/031-x/spec.md") });
    expect(t.of("spec-moved")).toEqual([{ kind: "spec-moved", issue: 7, from: "specs/030-x/spec.md", to: "specs/031-x/spec.md" }]);
    expect(r.claim.state.reserved.spec).toBeNull();
  }, 60_000);

  it("moves to a new slug on a free number with no reservation (AC-1, AC-5)", async () => {
    const t = await env(() => ({ fix: [moveFix("specs/072-a", "specs/072-b")] }), "specs/072-a/spec.md");
    const r = await step(t.deps, t.c);
    expect(inputOf(t.paths, "7-fix-1-").spec_number).toBeUndefined();
    expect(t.of("number-reserved").filter((l) => l.spec !== undefined)).toEqual([]);
    expect(bodyPatch(t.gh)).toEqual({ body: body("specs/072-b/spec.md") });
    expect(r.claim.state.history.join()).not.toMatch(/failed/);
  }, 60_000);

  it("reserves a number held by an open PR or another claim, gives a set reservation again, and does not count the chain's own PR (AC-1)", async () => {
    const pr = await env(() => ({ fix: [undefined] }), "specs/030-x/spec.md", { openPrs: [{ number: 30, added: ["specs/030-hand/spec.md"] }] });
    await step(pr.deps, pr.c);
    expect(inputOf(pr.paths, "7-fix-1-").spec_number).toBe("031");
    const cl = await env(() => ({ fix: [undefined] }), "specs/030-x/spec.md", { others: [other(8, 30)] });
    await step(cl.deps, cl.c);
    expect(inputOf(cl.paths, "7-fix-1-").spec_number).toBe("031");
    const set = await env(() => ({ fix: [undefined] }), "specs/030-x/spec.md");
    await writeClaim(set.paths, at(set.c, {}, {}));
    const c2 = at(set.c, { reserved: { spec: 44, adr: null } });
    await writeClaim(set.paths, c2);
    await step(set.deps, c2);
    expect(inputOf(set.paths, "7-fix-1-").spec_number).toBe("044");
    const own = await env(() => ({ fix: [undefined] }), "specs/030-x/spec.md", { openPrs: [{ number: 12, added: ["specs/030-x/spec.md"] }] });
    await step(own.deps, own.c);
    expect(inputOf(own.paths, "7-fix-1-").spec_number).toBeUndefined();
  }, 120_000);

  it("reserves nothing for a spec on main (AC-1)", async () => {
    const t = await env(() => ({ fix: [undefined] }), "specs/010-thing/spec.md", { openPrs: [{ number: 30, added: ["specs/010-hand/spec.md"] }] });
    await step(t.deps, t.c);
    expect(inputOf(t.paths, "7-fix-1-").spec_number).toBeUndefined();
  }, 60_000);

  const failures: [string, string, string, Parameters<typeof moveFix>[2], string][] = [
    ["a rename to a number that is not the reservation (item 5)", "specs/033-x", "specs/030-x", {}, "result: spec number 033 is not the issue's 030 or the reserved 031"],
    ["a copy (item 3)", "specs/031-x", "specs/030-x", { copy: true }, "result: spec moved to specs/031-x/spec.md but specs/030-x/ still holds files"],
  ];
  for (const [name, to, from, o, reason] of failures) {
    it(`fails ${name} and leaves the issue body alone (AC-2)`, async () => {
      const t = await env(() => ({ fix: [moveFix(from, to, o)] }), "specs/030-x/spec.md", { mainHas: "specs/030-other" });
      const r = await step(t.deps, t.c);
      expect(r.claim.state.history).toContain(`fix attempt 1 failed: ${reason}`);
      expect(bodyPatch(t.gh)).toBeUndefined();
    }, 60_000);
  }

  it("fails a move onto a spec directory on main, even with the line path's number (AC-2 item 6)", async () => {
    const t = await env(() => ({ fix: [(run: StageRun) => { git(run.worktree, "rm", "-q", "-r", "specs/030-x"); return { head_sha: commitIn(run.worktree, { "specs/030-other/spec.md": "changed\n" }), addressed: [], spec_path: "specs/030-other/spec.md" }; }] }), "specs/030-x/spec.md", { mainHas: "specs/030-other" });
    const r = await step(t.deps, t.c);
    expect(r.claim.state.history.join()).toContain("result: spec number 030 is held by origin/main");
    expect(bodyPatch(t.gh)).toBeUndefined();
  }, 60_000);

  it("fails a move with no spec at the new path, an issue-track move, and a move of a spec on main (AC-2 items 4, 1, 2)", async () => {
    const none = await env(() => ({ fix: [(run: StageRun) => { git(run.worktree, "rm", "-q", "-r", "specs/072-a"); return { head_sha: commitIn(run.worktree, { "b.txt": "b\n" }), addressed: [], spec_path: "specs/031-x/spec.md" }; }] }), "specs/072-a/spec.md");
    const r1 = await step(none.deps, none.c);
    expect(r1.claim.state.history.join()).toContain("result: no spec at specs/031-x/spec.md");
    const issueTrack = await specMoveReason({} as DriverDeps, { state: { track: "issue" } } as Claim, "specs/072-a/spec.md", "specs/072-b/spec.md");
    expect(issueTrack).toBe("result: spec_path differs from the issue's Spec: line");
    const onMain = await env(() => ({ fix: [(run: StageRun) => ({ head_sha: head(run.worktree), addressed: [], spec_path: "specs/011-y/spec.md" })] }), "specs/010-thing/spec.md");
    const r3 = await step(onMain.deps, onMain.c);
    expect(r3.claim.state.history.join()).toContain("result: the spec at specs/010-thing/spec.md is on main and cannot move");
    for (const t of [none, onMain]) expect(bodyPatch(t.gh)).toBeUndefined();
  }, 120_000);

  describe("the spec stage (AC-3)", () => {
    const specClaim = async (t: Awaited<ReturnType<typeof env>>) => {
      const c = at(t.c, { stage: "spec", track: "spec", specMode: "write" });
      await writeClaim(t.paths, c);
      return c;
    };
    const revised = (from: string, to: string) => (run: StageRun) => {
      git(run.worktree, "mv", from, to);
      return { verdict: "revised", spec_path: `${to}/spec.md`, pr_number: 12, head_sha: commitIn(run.worktree, { "docs/top.md": topWith(`${to}/spec.md`) }, "move") };
    };
    it("rewrites the line for a revised result that moves the spec, and refuses one that moves a spec on main", async () => {
      const t = await env(() => ({ spec: [revised("specs/072-a", "specs/072-b")] }), "specs/072-a/spec.md");
      const r = await step(t.deps, await specClaim(t));
      expect(r.claim.state.history.join()).not.toMatch(/failed/);
      expect(bodyPatch(t.gh)).toEqual({ body: body("specs/072-b/spec.md") });
      expect(t.of("spec-moved")).toHaveLength(1);
      const m = await env(() => ({ spec: [(run: StageRun) => ({ verdict: "revised", spec_path: "specs/011-y/spec.md", pr_number: 12, head_sha: head(run.worktree) })] }), "specs/010-thing/spec.md");
      const r2 = await step(m.deps, await specClaim(m));
      expect(r2.claim.state.history.join()).toContain("result: the spec at specs/010-thing/spec.md is on main and cannot move");
      expect(bodyPatch(m.gh)).toBeUndefined();
    }, 120_000);
  });
});
