import {TelegramClient} from '../src/telegram/client.ts';
import {telegramChannel} from '../src/telegram/channel.ts';
import {fakeTelegram} from './helpers/fake-telegram.ts';
import {emptyTelegram,listPaused,type PausedRecord} from '../src/state/paused.ts';
import {completePause} from '../src/chain/driver.ts';
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
import { ParameterStore } from "../src/parameters/store.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { observeRun } from "../src/quota/book.ts";
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

interface PrOver { headRef?: string; head?: string | (() => string); body?: string; merged?: boolean; mergeable?: boolean; state?: "open" | "closed" }
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
        return { body: { number: Number(m[1]), base: { ref: "main" }, head: { ref: pr.headRef ?? "issue-7", sha: head }, html_url: "u", body: pr.body ?? "", mergeable: pr.mergeable ?? true, mergeable_state: "clean", merged: pr.merged ?? false, state: pr.state ?? (pr.merged ? "closed" : "open") } };
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

describe('Telegram pause and conversation protection',()=>{
 const q:Question={kind:'product',question:'Which layout?',options:[{label:'second',cost:'none'}],recommendation:'second'};
 function pausing():PausedRecord{return {issue:7,phase:'pausing',nonce:'nonce',state:initialChainState(7),question:q,asking_stage:'plan',question_comment_id:null,asked_at:null,reminded:false,answer:null,reply_comment_id:null,telegram:emptyTelegram()};}
 it('posts the record then sends once, and a pausing record with a message id is not resent',async()=>{
  const {deps,paths,gh}=await setup(()=>({}));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));try{
   await completePause(deps,pausing());const [r]=await listPaused(paths);expect(r.telegram?.message_id).toBe(1);expect(r.telegram?.sent).toBe(true);expect(gh.calls.find(c=>c.method==='POST'&&c.url.endsWith('/comments'))?.body).toEqual({body:expect.stringContaining('asked on Telegram')});await completePause(deps,{...r,phase:'pausing'});expect(server.sent).toHaveLength(1);
  }finally{await server.close();}
 },30000);
 it('completes a pause even when Telegram fails, retaining the retry state',async()=>{
  const {deps,paths}=await setup(()=>({}));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));try{server.fail('sendMessage',500);await completePause(deps,pausing());const [r]=await listPaused(paths);expect(r.phase).toBe('paused');expect(r.telegram?.send_failures).toBe(1);expect(r.telegram?.sent).toBe(false);}finally{await server.close();}
 },30000);
 it('reverts a conversation write while preserving the work already present when it asked',async()=>{
  const {deps,claim}=await setup(()=>({plan:[(run:StageRun)=>{writeFileSync(join(run.worktree,'a.txt'),'forbidden\n');return {conversation:'settled',decision:'second'};}]}));
  writeFileSync(join(claim.worktree,'a.txt'),'kept\n');writeFileSync(join(claim.worktree,'untracked.txt'),'kept untracked\n');
  const paused={...claim.state,stage:'paused' as const,question:q,askingStage:'plan' as const,resumeSession:{harness:'fake' as const,model:'m',session_id:'s',worktree:claim.worktree}};
  claim.state=transition(paused,{type:'answered',answer:'second',questionId:1}).state;
  const r=await step(deps,claim);expect(r.claim.state.conversation?.retried).toBe(true);expect(r.claim.state.rescues).toBe(0);expect(readFileSync(join(claim.worktree,'a.txt'),'utf8')).toBe('kept\n');expect(readFileSync(join(claim.worktree,'untracked.txt'),'utf8')).toBe('kept untracked\n');
 },30000);
});

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
    // The plan stage's own model is the configured rescue model, so a distinct id shows which one ran.
    deps.cfg = { ...deps.cfg, rescue_model: "claude-rescue-test" };
    const c = await steps(deps, claim, 4);
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1", "plan:claude-rescue-test"]);
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

describe("driver: final review cycle 2", () => {
  it("a spec-PR fix recording answer #556 fails when only #555's mark, from an earlier commit, is on the PR; its own #556 mark passes (TI1)", async () => {
    for (const [mark, ok] of [[555, false], [556, true]] as const) {
      let wt = "";
      const t = await setup(() => ({ fix: [(run: StageRun) => ({ head_sha: commitIn(run.worktree, { "specs/010-thing/spec.md": `${spec}\nUse lru (maintainer answer, question #${mark}).\n` }, "fix"), addressed: [] })] }),
        (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: () => head(wt) } } }), (_p, w) => {
          wt = w;
          git(w, "checkout", "-q", "-b", "spec-7");
          commitIn(w, { "docs/product-spec.md": "# Product\n\nLocal only (maintainer answer, question #555).\n" }, "record 555");
          git(w, "push", "-q", "-u", "origin", "spec-7");
        });
      const c = at(t.claim, {
        stage: "fix", track: "spec", pr: { number: 12, head_sha: t.sha }, answerQuestionId: 556, answerQuestionIds: [555, 556], answerKind: "product", recordIds: [556], recordKind: "technical",
        pendingFixInput: "Record the decision.",
      });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      // Past the mark check (the fixture's parent design then fails the spec-PR scope, which is not under test here).
      if (ok) {
        expect(r.claim.state.history.some((h) => h.includes("answer not marked"))).toBe(false);
        expect(r.claim.state).toMatchObject({ recordIds: [], answerKind: "product" });
      }
      else expect(r.claim.state.history).toContain("fix attempt 1 failed: result: answer not marked");
    }
  }, 60_000);

  it("a spec stage with two answers to record must mark both (TI1)", async () => {
    for (const [text, ok] of [["Use a (maintainer answer, question #555).", false], ["Use a (maintainer answer, question #555); local (maintainer answer, question #556).", true]] as const) {
      let wt = "";
      const t = await setup(() => ({ spec: [(run: StageRun) => ({ verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 12, head_sha: commitIn(run.worktree, { "specs/010-thing/spec.md": `${spec}\n${text}\n` }) })] }),
        (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: () => head(wt), body: "Refs #7" } } }), (_p, w) => { wt = w; });
      const c = at(t.claim, { stage: "spec", track: "spec", specMode: "write", answer: "Question #555: a\n\nQuestion #556: local", answerQuestionId: 556, answerQuestionIds: [555, 556], answerKind: "product", recordIds: [555, 556], recordKind: "product" });
      await writeClaim(t.paths, c);
      const r = await step(t.deps, c);
      if (ok) expect(r.claim.state.recordIds).toEqual([]);
      else expect(r.claim.state.history).toContain("spec attempt 1 failed: result: answer not marked");
    }
  }, 60_000);

  it("the question check of a decide-mode new blocker gets the question sent back and its reasoning (CM2)", async () => {
    const { deps, claim, paths } = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "same question" }] }));
    const c = at(claim, { stage: "question-check", question: { ...Q, question: "Which index?", new_blocker: true }, askingStage: "plan", decideInput: "pick a", decidedQuestion: Q, decideReturns: 1 });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-question-check-").decide_input).toBe("Sent back earlier for the asking stage to decide: Which store?\nIt decides the schema.\nThe reasoning given: pick a");
  }, 60_000);

  it("a transition that goes through resets the chain-failure count (Tm3)", async () => {
    const { deps, claim, paths } = await setup(() => ({ plan: [plan] }));
    const c = at(claim, { stage: "plan", chainFailures: { count: 2, last: "boom" } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.claim.state).toMatchObject({ stage: "implement", chainFailures: null });
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8")).chainFailures).toBeNull();
  }, 60_000);

  it("an abandonment carries an unrecorded answer into the fresh ledger (Tm4)", async () => {
    const pending = { ids: [555], kind: "product" as const, text: "Question #555: yes" };
    const { deps, claim, paths } = await setup(() => ({ fix: [] }));
    const c = at(claim, { stage: "fix", track: "spec", pr: null, rescues: 1, replans: 1, specRevisions: 1, specRescues: 1, pendingFixInput: "x", pendingAnswer: pending });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(readdirSync(paths.escalations).some((f) => f.startsWith("7.abandoned-"))).toBe(true);
    expect(JSON.parse(readFileSync(ledgerFile(paths), "utf8"))).toMatchObject({ rescues: 0, replans: 0, history: [], pendingAnswer: pending });
  }, 60_000);
});

describe("driver: a branch left on origin by a failed attempt (final review T2)", () => {
  /** Pushes a commit to issue-7 on origin from a scratch clone, as an implement that failed after its push would. */
  function leaveStaleBranch(pair: ReturnType<typeof repoPair>): void {
    const scratch = join(pair.root, "stale-clone");
    git(pair.root, "clone", "-q", pair.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    writeFileSync(join(scratch, "stale.txt"), "stale attempt\n");
    git(scratch, "add", "stale.txt");
    git(scratch, "commit", "-q", "-m", "stale attempt");
    git(scratch, "push", "-q", "origin", "issue-7");
  }
  const originHas = (pair: ReturnType<typeof repoPair>, branch: string) => git(pair.origin, "branch", "--list", branch).trim() !== "";

  it("saves the stale branch as a patch, closes its open PR with a comment and deletes it before a stage with no PR runs", async () => {
    let pair!: ReturnType<typeof repoPair>;
    const routes = (sha: string): Route[] => [
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.get("head") === "o:issue-7" && url.searchParams.get("state") === "open" ? [{ number: 9 }] : [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(pair.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
      ...ghRoutes(sha),
    ];
    const t = await setup(() => ({ implement: [] }), routes, (p) => { pair = p; leaveStaleBranch(p); });
    const { deps, claim, gh, paths, adapter } = t;
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(adapter.heads).toEqual(["issue-7"]);
    expect(git(claim.worktree, "rev-parse", "HEAD").trim()).toBe(git(pair.repo, "rev-parse", "origin/main").trim());
    expect(originHas(pair, "issue-7")).toBe(false);
    const writes = gh.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url}`);
    const close = writes.indexOf("PATCH /repos/o/r/pulls/9");
    expect(writes.indexOf("POST /repos/o/r/issues/9/comments")).toBeLessThan(close);
    expect(close).toBeLessThan(writes.indexOf("DELETE /repos/o/r/git/refs/heads/issue-7"));
    expect(gh.calls.find((call) => call.method === "PATCH" && call.url === "/repos/o/r/pulls/9")?.body).toEqual({ state: "closed" });
    const saved = readdirSync(paths.patches).filter((f) => f.includes("stale-branch"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(paths.patches, saved[0]), "utf8")).toContain("stale attempt");
  }, 60_000);

  it("asks GitHub nothing when origin has no such branch", async () => {
    const { deps, claim, gh, paths } = await setup(() => ({ implement: [] }));
    const c = at(claim, { stage: "implement", plan: plan as never });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(gh.calls.some((call) => call.url.startsWith("/repos/o/r/pulls?") || call.url.includes("/git/refs/heads/"))).toBe(false);
  }, 60_000);

  it("drops a stale spec-7 the same way before the spec stage runs (re-claim after a release)", async () => {
    let pair!: ReturnType<typeof repoPair>;
    const routes = (sha: string): Route[] => [
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(pair.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
      ...ghRoutes(sha),
    ];
    const t = await setup(() => ({ spec: [] }), routes, (p) => {
      pair = p;
      const scratch = join(p.root, "stale-spec");
      git(p.root, "clone", "-q", p.origin, scratch);
      git(scratch, "push", "-q", "origin", "HEAD:refs/heads/spec-7");
    });
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(t.adapter.heads).toEqual(["spec-7"]);
    expect(originHas(pair, "spec-7")).toBe(false);
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

describe("driver: quota (spec 013)", () => {
  const SESSION = "You've hit your session limit · resets 8:10am (Europe/Berlin)";
  const FABLE = "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.";
  /** Each model answers from its own list: a string is a 429 with that message, an object a result. */
  function quotaAdapter(answers: Record<string, unknown[]>): Adapter & { ran: string[] } {
    const ran: string[] = [];
    let last: unknown;
    return {
      harness: "fake", quotaHarness: "claude", ran,
      buildCommand: (run) => {
        ran.push(`${run.stage}:${run.model}`);
        last = answers[run.model]?.shift();
        const argv = [process.execPath, script, events, run.resultPath, typeof last === "string" ? "2" : "0", "0"];
        if (typeof last !== "string" && last !== undefined) argv.push(JSON.stringify(last));
        return { argv, env: {} };
      },
      judge: (_e, exit) => exit === 2 ? { outcome: "failed", reason: String(last), apiErrorStatus: 429, finalText: null } : { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" },
      usage: () => ({ cost_usd: 0.5, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 }),
    };
  }
  async function world(answers: Record<string, unknown[]>, now: string) {
    const t = await setup(() => ({}));
    const adapter = quotaAdapter(answers);
    let clock = new Date(now);
    const logs: Record<string, unknown>[] = [];
    t.deps.adapterFor = () => adapter;
    t.deps.now = () => clock;
    t.deps.log = (r) => { logs.push(r); };
    t.deps.parameters = new ParameterStore(t.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), t.deps.cfg, {}));
    return { ...t, adapter, logs, setNow: (v: string) => { clock = new Date(v); } };
  }

  it("postpones a strong stage to the stated reset and starts no run before it (AC-4, AC-5, AC-6)", async () => {
    const w = await world({ "claude-fable-5-1": [SESSION, plan] }, "2026-10-29T02:58:53Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(r.status).toBe("waiting");
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "plan", postponedUntil: "2026-10-29T07:10:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-limit")).toMatchObject({ key: "claude", scope: "session", resets_at: "2026-10-29T07:10:00.000Z", source: "stated" });
    // Before the reset nothing runs; at the reset a fresh plan run would be blocked no more.
    w.setNow("2026-10-29T05:00:00Z");
    r = await step(w.deps, r.claim);
    expect(r.status).toBe("waiting");
    // Even when the wait is bypassed (a restart, a manual start), the launch decision runs no blocked stage.
    const again = at(r.claim, { stage: "plan", postponedUntil: null });
    r = await step(w.deps, again);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T07:10:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-wait")).toMatchObject({ issue: 7, stage: "plan", key: "claude" });
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(readdirSync(w.paths.usage)).toHaveLength(1);
    w.setNow("2026-10-29T07:11:00Z");
    r = await step(w.deps, r.claim);
    r = await step(w.deps, r.claim);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-fable-5-1"]);
    expect(r.claim.state.stage).toBe("implement");
  }, 60_000);

  it("moves a strong stage to the next-best Claude model on a model-only limit, then launches there directly (AC-9)", async () => {
    const w = await world({ "claude-fable-5-1": [FABLE], "claude-opus-5-5": [plan, plan] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-opus-5-5"]);
    expect(r.claim.state.stage).toBe("implement");
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([{ kind: "quota-fallback", issue: 7, stage: "plan", from: "claude-fable-5-1", to: "claude-opus-5-5", key: "claude:fable" }]);
    const again = at(r.claim, { stage: "plan" });
    await step(w.deps, again);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1", "plan:claude-opus-5-5", "plan:claude-opus-5-5"]);
    const usage = readdirSync(w.paths.usage).map((f) => JSON.parse(readFileSync(join(w.paths.usage, f), "utf8")).model).sort();
    expect(usage).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5-5"]);
  }, 60_000);

  it("never moves a rescue to the fallback model: it postpones under a Fable limit (AC-9, spec 006 AC-27)", async () => {
    const w = await world({ "claude-fable-5-1": [FABLE] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan", rescueRun: true, rescues: 1 });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", resumeStage: "plan", rescueRun: true, rescues: 1, postponedUntil: "2026-10-29T07:30:00.000Z" });
    // Started again while the Fable limit holds, the rescue waits rather than run on Opus.
    r = await step(w.deps, at(r.claim, { stage: "plan", postponedUntil: null }));
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", rescueRun: true });
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([]);
  }, 60_000);

  it("caps a session wait at quota.session_window as set in the parameter store (AC-1, AC-8)", async () => {
    // 8:10 Berlin read an hour after it passed would be tomorrow; with a 2h window the wait is 2h.
    const w = await world({ "claude-fable-5-1": ["You've hit your session limit · resets 8:10am (Europe/Berlin)"] }, "2026-10-29T08:10:00Z");
    await w.deps.parameters!.setParameter("quota.session_window", "2h", "maintainer");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T10:10:00.000Z" });
    const book = JSON.parse(readFileSync(w.paths.quota, "utf8"));
    expect(book.window).toMatchObject({ start: "2026-10-29T08:10:00.000Z" });
    expect(book.limits.claude.resets_at).toBe("2026-10-29T10:10:00.000Z");
  }, 60_000);

  it("never moves a strong stage to another Claude model on a weekly limit (AC-9)", async () => {
    const w = await world({ "claude-fable-5-1": ["You've hit your weekly limit · resets Nov 3, 9am (Europe/Berlin)"] }, "2026-10-29T07:15:00Z");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-11-03T08:00:00.000Z" });
    expect(w.logs.filter((l) => l.kind === "quota-fallback")).toEqual([]);
  }, 60_000);

  it("defers a strong stage to the window's end once, then runs it (AC-8)", async () => {
    const w = await world({ "claude-fable-5-1": [plan] }, "2026-10-29T03:00:00Z");
    const u = (over: Record<string, unknown>) => ({
      run_id: `u${Math.random()}`, issue: 1, stage: "plan", attempt: 1, outcome: "ok" as const, harness: "claude" as const, model: "claude-fable-5-1", cost_usd: 4, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0, wall_seconds: 1, started_at: "", ended_at: "", events_path: "", ...over,
    });
    const okJ = { outcome: "ok" as const, reason: null, apiErrorStatus: null, finalText: null };
    for (const [start, reset] of [["2026-10-28T12:00:00Z", "6pm"], ["2026-10-28T18:00:00Z", "12am"]]) {
      for (let i = 0; i < 5; i++) await observeRun(w.paths, u({ started_at: start }), okJ, new Date(start));
      await observeRun(w.paths, u({ outcome: "failed", cost_usd: 0, started_at: start }), { outcome: "failed", reason: `You've hit your session limit · resets ${reset} (UTC)`, apiErrorStatus: 429, finalText: null }, new Date(start));
    }
    for (let i = 0; i < 5; i++) await observeRun(w.paths, u({ started_at: "2026-10-29T00:01:00Z" }), okJ, new Date("2026-10-29T00:01:00Z"));
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    let r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T05:01:00.000Z" });
    expect(w.logs.find((l) => l.kind === "quota-defer")).toMatchObject({ issue: 7, stage: "plan", estimate: 4, spent: 20, capacity: 20, until: "2026-10-29T05:01:00.000Z" });
    // Started again before the end (a restart), it is not deferred a second time in the same window.
    r = await step(w.deps, at(r.claim, { stage: "plan", postponedUntil: null }));
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(r.claim.state.stage).toBe("implement");
  }, 60_000);

  it("waits instead when the model-limit fallback parameter is off (AC-9)", async () => {
    const w = await world({ "claude-fable-5-1": [FABLE] }, "2026-10-29T07:15:00Z");
    await w.deps.parameters!.setParameter("quota.model_limit_fallback", false, "maintainer");
    const c = at(w.claim, { stage: "plan" });
    await writeClaim(w.paths, c);
    const r = await step(w.deps, c);
    expect(w.adapter.ran).toEqual(["plan:claude-fable-5-1"]);
    expect(r.claim.state).toMatchObject({ stage: "waiting", postponedUntil: "2026-10-29T07:30:00.000Z" });
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

  it("gives the question check the issue's answered questions and posts the check's wording (C8, C10)", async () => {
    const worded = { kind: "technical", question: "Store a or b? The schema follows.", options: [{ label: "a", cost: "cheap" }], recommendation: "a" };
    const { deps, claim, gh, paths } = await setup(() => ({ "question-check": [{ verdict: "send", reasoning: "real choice", question: worded }] }));
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 501, reply_comment_id: 502, answer: "keep it\nlocal", question: { ...Q, question: "Where does data live?" } });
    await appendQuestionLog(paths, { issue: 8, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 601, reply_comment_id: 602, answer: "other issue" });
    const c = at(claim, { stage: "question-check", question: Q, askingStage: "plan" });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-question-check-").answered_questions).toBe("#501: Question: Where does data live? Answer: keep it local");
    expect(readFileSync(join(paths.runs, readdirSync(paths.runs).find((d) => d.startsWith("7-question-check-"))!, "prompt.md"), "utf8")).toContain("#501: Question: Where does data live?");
    const body = String((gh.calls.find((x) => x.url === "/repos/o/r/issues/7/comments")?.body as { body: string }).body);
    expect(body).toContain("Store a or b? The schema follows.");
    expect(body).not.toContain("Which store?");
    expect(JSON.parse(readFileSync(join(paths.paused, "7.json"), "utf8")).question).toEqual(worded);
  }, 60_000);

  it("logs a follow-up as asked when it pauses without the check (T-minor 5)", async () => {
    const fu = { ...Q, follow_up: true, reply_quote: "Which store do you mean?" };
    const { deps, claim, paths } = await setup(() => ({ plan: [{ escalation: fu }] }));
    const c = at(claim, { stage: "plan", answer: "Question #555: Which store do you mean?", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "capability" });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(r.status).toBe("ended");
    expect(logEvents(paths)).toEqual(["asked", "sent"]);
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
      commitIn(wt, { "notes.md": "per (maintainer answer, question #101)\nsee question #102\nand question #103\nand question #104\n" });
    });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 101, reply_comment_id: 111, answer: "use a\nplease", question: Q });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-20T00:00:00Z", event: "sent", asking_stage: "plan", question_comment_id: 102 });
    // An answer to another issue's question verifies nothing here.
    await appendQuestionLog(paths, { issue: 8, at: "2026-10-20T00:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 104, reply_comment_id: 114, answer: "other", question: Q });
    const c = at(claim, { stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } });
    await writeClaim(paths, c);
    await step(deps, c);
    expect(inputOf(paths, "7-review-").answered_questions).toBe([
      "#101: verified. Question: Which store?. Answer: use a please",
      "#102: NOT verified; treat as no citation",
      "#103: NOT verified; treat as no citation",
      "#104: NOT verified; treat as no citation",
    ].join("\n"));
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

describe("driver: spec track (spec 006 AC-4, AC-19, AC-21, AC-22)", () => {
  it("fails a spec-PR fix that records a product answer without its mark (AC-18)", async () => {
    const { deps, claim, paths, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c = at(claim, { stage: "fix", track: "spec", pr: { number: 12, head_sha: sha }, answer: "keep it local", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "product", recordIds: [555], recordKind: "product", pendingFixInput: "Record the decision." });
    await writeClaim(paths, c);
    expect((await step(deps, c)).claim.state.history).toContain("fix attempt 1 failed: result: answer not marked");
  }, 60_000);

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
    const { deps, claim, adapter, gh, paths, sha } = await setup(() => ({ plan: [plan], implement: [] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), (pair, wt) => {
      onSpec7(pair, wt);
      // The squash merge: the spec PR's content lands on main as a new commit.
      commitIn(pair.repo, { "specs/010-thing/notes.md": "notes\n" }, "spec PR (squash)");
      git(pair.repo, "push", "-q", "origin", "main");
    });
    const c = at(claim, { stage: "merge", track: "spec", pr: { number: 12, head_sha: sha } });
    await writeClaim(paths, c);
    const r = await step(deps, c);
    expect(writes(gh)).toContain("PUT /repos/o/r/pulls/12/merge");
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(r.claim.state).toMatchObject({ stage: "plan", track: "issue", pr: null });
    expect(branchIn(claim.worktree)).toBe("issue-7");
    expect(git(claim.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    expect(existsSync(join(paths.root, "merges.jsonl"))).toBe(false);
    expect(readdirSync(paths.patches).filter((f) => f.includes("deleted-branch"))).toEqual([]);
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
    const c = at(unmarked.claim, { stage: "spec", track: "spec", specMode: "write", answer: "use a", answerQuestionId: 555, answerQuestionIds: [555], answerKind: "technical", recordIds: [555], recordKind: "technical" });
    await writeClaim(unmarked.paths, c);
    const r = await step(unmarked.deps, c);
    expect(r.claim.state.history).toContain("spec attempt 1 failed: result: answer not marked");
    const r2 = await step(unmarked.deps, r.claim);
    expect(r2.claim.state.history.some((h) => h.includes("answer not marked") && h.startsWith("spec attempt 2"))).toBe(false);
    expect(r2.claim.state.stage).not.toBe("spec");
  }, 60_000);

  it("reviews a spec PR that touches a top design under the spec profile, then under the security profile; else under the spec profile only (AC-4, AC-21, C5)", async () => {
    const sensitive = await setup(() => ({ review: [approve, approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), (_p, wt) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, { "docs/delivery-system-design.md": "# Design\n" });
      git(wt, "push", "-q", "-u", "origin", "spec-7");
    });
    const c = at(sensitive.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: sensitive.sha } });
    await writeClaim(sensitive.paths, c);
    const first = await step(sensitive.deps, c);
    expect(inputOf(sensitive.paths, "7-review-").profile_instructions).toMatch(/^Spec profile\./);
    expect(first.claim.state).toMatchObject({ stage: "review", securityPass: true });
    const second = await step(sensitive.deps, first.claim);
    const reviews = readdirSync(sensitive.paths.runs).filter((d) => d.startsWith("7-review-")).sort();
    expect(reviews).toHaveLength(2);
    const profiles = reviews.map((d) => JSON.parse(readFileSync(join(sensitive.paths.runs, d, "input.json"), "utf8")).profile_instructions as string);
    expect(profiles.some((p) => p.startsWith("Security review profile."))).toBe(true);
    expect(profiles.some((p) => p.startsWith("Spec profile."))).toBe(true);
    expect(second.claim.state.stage).toBe("merge");

    const plain = await setup(() => ({ review: [approve] }), (sha) => ghRoutes(sha, { prs: { 12: { headRef: "spec-7", head: sha } } }), onSpec7);
    const c2 = at(plain.claim, { stage: "review", track: "spec", pr: { number: 12, head_sha: plain.sha } });
    await writeClaim(plain.paths, c2);
    await step(plain.deps, c2);
    expect(inputOf(plain.paths, "7-review-").profile_instructions).toMatch(/^Spec profile\./);
  }, 60_000);

  it("saves spec-7's unpushed commits before a release without a spec PR deletes the branch (spec 005, AC-21)", async () => {
    const { deps, claim, gh, paths } = await setup(() => ({}), undefined, (_p, wt) => {
      git(wt, "checkout", "-q", "-b", "spec-7");
      commitIn(wt, { "specs/010-thing/draft.md": "draft\n" });
    });
    const c = at(claim, { stage: "spec", track: "spec", specMode: "write" });
    await writeClaim(paths, c);
    const { state, actions } = transition(c.state, { type: "liveness_expired" });
    await applyActions(deps, { ...c, state }, actions);
    expect(writes(gh)).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(git(claim.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    const saved = readdirSync(paths.patches).filter((f) => f.includes("deleted-branch"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(paths.patches, saved[0]), "utf8")).toContain("draft.md");
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

describe("driver: a stage that asks a question keeps its work (spec 011)", () => {
  const prRoutes = (state: { pair?: ReturnType<typeof repoPair> }) => (sha: string): Route[] => [
    { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: (_m, _b, url) => ({ body: url.searchParams.get("head") === "o:issue-7" && url.searchParams.get("state") === "open" ? [{ number: 9 }] : [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/, reply: (m) => { git(state.pair!.origin, "update-ref", "-d", `refs/heads/${decodeURIComponent(m[1])}`); return { status: 204, body: null }; } },
    ...ghRoutes(sha),
  ];
  const originHas = (pair: ReturnType<typeof repoPair>, branch: string) => git(pair.origin, "branch", "--list", branch).trim() !== "";
  const capability: Question = { ...Q, kind: "capability" };
  const logsOf = (deps: DriverDeps) => {
    const logs: Record<string, unknown>[] = [];
    deps.log = (r) => { logs.push(r); };
    return logs;
  };

  it("saves a held patch, logs held-work and puts the head on the question-check state when implement asks after pushing (AC-1)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let pushed = "";
    const t = await setup(() => ({
      implement: [(run: StageRun) => { pushed = commitIn(run.worktree, { "work.txt": "w\n" }); git(run.worktree, "push", "-q", "origin", "issue-7"); return { escalation: capability }; }],
    }), prRoutes(state), (p) => { state.pair = p; });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(r.claim.state).toMatchObject({ stage: "question-check", askingStage: "implement", heldWork: { branch: "issue-7", head: pushed } });
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(t.paths.patches, saved[0]), "utf8")).toContain("work.txt");
    expect(logs).toContainEqual({ kind: "held-work", issue: 7, stage: "implement", branch: "issue-7", head: pushed, pushed: true, prs: [9], patch: join(t.paths.patches, saved[0]) });
  }, 60_000);

  it("writes no held patch when the asking stage committed nothing (AC-1)", async () => {
    const t = await setup(() => ({ plan: [{ escalation: capability }] }));
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "plan" });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(r.claim.state.heldWork).toEqual({ branch: "issue-7", head: head(t.claim.worktree) });
    expect(readdirSync(t.paths.patches)).toEqual([]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "held-work", stage: "plan", pushed: false, patch: null }));
  }, 60_000);

  it("leaves the pushed branch, its open PR and HEAD alone when the question check is prepared (AC-2)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "r" }] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "question-check", question: capability, askingStage: "implement", heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(originHas(state.pair!, "issue-7")).toBe(true);
    expect(writes(t.gh).filter((w) => w.startsWith("PATCH") || w.startsWith("DELETE"))).toEqual([]);
    expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
    expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
    expect(readdirSync(t.paths.patches)).toEqual([]);
  }, 60_000);

  it("tells the resumed implement about the work, and not the question check (AC-4)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ "question-check": [{ verdict: "decide_yourself", reasoning: "r" }], implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const heldWork = () => ({ branch: "issue-7", head: held });
    const qc = at(t.claim, { stage: "question-check", question: capability, askingStage: "implement", heldWork: heldWork(), plan: plan as never });
    await writeClaim(t.paths, qc);
    await step(t.deps, qc);
    expect(inputOf(t.paths, "7-question-check-").held_work).toBeUndefined();
    const im = at(t.claim, { stage: "implement", plan: plan as never, heldWork: heldWork() });
    await writeClaim(t.paths, im);
    await step(t.deps, im);
    const text = inputOf(t.paths, "7-implement-").held_work!;
    expect(text).toContain("issue-7");
    expect(text).toContain(held);
    expect(text).toContain("on origin");
    expect(text).toContain("#9");
    expect(t.adapter.heads).toEqual(["issue-7", "issue-7"]);
    expect(head(t.claim.worktree)).toBe(held);
  }, 60_000);

  it("puts a lost worktree back at the held head from the object store, or from origin (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "reset", "-q", "--hard", "origin/main");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(logs).toContainEqual({ kind: "held-work-restored", issue: 7, branch: "issue-7", head: held, source: "local", patch: null });

    // The commit exists nowhere in this repository, but the branch is on origin.
    const lost = "1".repeat(40);
    const scratch = join(state.pair!.root, "scratch");
    git(state.pair!.root, "clone", "-q", state.pair!.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    const remoteHead = commitIn(scratch, { "other.txt": "o\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    git(t.claim.worktree, "checkout", "-q", "--detach", "origin/main");
    git(t.claim.worktree, "branch", "-D", "issue-7");
    const again = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: lost } });
    await writeClaim(t.paths, again);
    const r = await step(t.deps, again);
    expect(head(t.claim.worktree)).toBe(remoteHead);
    expect(logs).toContainEqual({ kind: "held-work-restored", issue: 7, branch: "issue-7", head: remoteHead, source: "origin" });
    expect(r.claim.state.heldWork).toEqual({ branch: "issue-7", head: remoteHead });
  }, 60_000);

  it("logs held-work-lost, clears the held work and prepares as without it when the commit is nowhere (AC-5)", async () => {
    const t = await setup(() => ({ implement: [] }));
    const logs = logsOf(t.deps);
    const lost = "1".repeat(40);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: lost } });
    await writeClaim(t.paths, c);
    const r = await step(t.deps, c);
    expect(logs).toContainEqual({ kind: "held-work-lost", issue: 7, branch: "issue-7", head: lost });
    expect(r.claim.state.heldWork).toBeNull();
    expect(head(t.claim.worktree)).toBe(git(t.pair.repo, "rev-parse", "origin/main").trim());
  }, 60_000);

  it("keeps commits the resumed stage added on top of the held head, and advances the held head to them (AC-2)", async () => {
    let held = "";
    let added = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (_p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      added = commitIn(wt, { "more.txt": "m\n" });
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(added);
    expect(logs).toContainEqual({ kind: "held-work-advanced", issue: 7, branch: "issue-7", from: held, to: added });
    expect(inputOf(t.paths, "7-implement-").held_work).toContain(added);
    expect(readdirSync(t.paths.patches)).toEqual([]);
  }, 60_000);

  it("leaves main's commits out of the held-diverged patch when the diverged branch sits on a moved main (AC-5)", async () => {
    let held = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      writeFileSync(join(p.repo, "main.txt"), "main moved\n");
      git(p.repo, "add", "main.txt");
      git(p.repo, "commit", "-q", "-m", "main moved");
      git(p.repo, "push", "-q", "origin", "main");
      git(wt, "fetch", "-q", "origin");
      git(wt, "reset", "-q", "--hard", "origin/main");
      commitIn(wt, { "other.txt": "o\n" }, "own");
    });
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held-diverged"));
    expect(saved).toHaveLength(1);
    const text = readFileSync(join(t.paths.patches, saved[0]), "utf8");
    expect(text).toContain("other.txt");
    expect(text).not.toContain("main.txt");
  }, 60_000);

  it("saves a held-diverged patch of the local branch's own commits before putting it back at the held head (AC-5)", async () => {
    let held = "";
    const t = await setup(() => ({ implement: [] }), (sha) => ghRoutes(sha), (_p, wt) => {
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "reset", "-q", "--hard", "origin/main");
      commitIn(wt, { "other.txt": "o\n" });
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    const saved = readdirSync(t.paths.patches).filter((f) => f.includes("held-diverged"));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(t.paths.patches, saved[0]), "utf8")).toContain("other.txt");
    expect(logs).toContainEqual(expect.objectContaining({ kind: "held-work-restored", source: "local", head: held, patch: join(t.paths.patches, saved[0]) }));
  }, 60_000);

  it("with a PR bound, keeps an unpushed held commit on the remote head and does not rebase it away (AC-2)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let remote = "";
    let held = "";
    const t = await setup(() => ({ fix: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      remote = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
      held = commitIn(wt, { "fix.txt": "f\n" });
    });
    // main moves on, so a rebase would rewrite the held commit.
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", t.pair.origin, scratch);
    commitIn(scratch, { "main.txt": "m\n" });
    git(scratch, "push", "-q", "origin", "HEAD:main");
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: remote }, pendingFixInput: "x", heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(head(t.claim.worktree)).toBe(held);
    expect(logs.find((r) => r.kind === "worktree-synced")).toBeUndefined();
    expect(logs).toContainEqual({ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held });
    expect(inputOf(t.paths, "7-fix-").held_work).toContain(held);
  }, 60_000);

  it("with a PR bound, a held head the remote diverged from is dropped as today, and the stage is not told it is there (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    let remote = "";
    const t = await setup(() => ({ fix: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
      held = commitIn(wt, { "fix.txt": "f\n" });
    });
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", "-b", "issue-7", t.pair.origin, scratch);
    remote = commitIn(scratch, { "elsewhere.txt": "e\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "fix", plan: plan as never, pr: { number: 9, head_sha: remote }, pendingFixInput: "x", heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "worktree-synced", dropped: held }));
    expect(logs).toContainEqual({ kind: "held-work-lost", issue: 7, branch: "issue-7", head: held });
    expect(inputOf(t.paths, "7-fix-").held_work).toBeUndefined();
  }, 60_000);

  it("says unknown, not 'not on origin' or '(none)', when the branch and PR lookups fail (AC-4)", async () => {
    let held = "";
    const failing = (sha: string): Route[] => [{ method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ status: 422, body: { message: "lookup failed" } }) }, ...ghRoutes(sha)];
    const t = await setup(() => ({ implement: [] }), failing, (_p, wt) => { held = commitIn(wt, { "work.txt": "w\n" }); });
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: held } });
    await writeClaim(t.paths, c);
    t.deps.fetchOrigin = async () => {};
    git(t.claim.worktree, "remote", "set-url", "origin", join(t.pair.root, "nonexistent.git"));
    try {
      await step(t.deps, c);
    } finally {
      git(t.claim.worktree, "remote", "set-url", "origin", t.pair.origin);
    }
    const text = inputOf(t.paths, "7-implement-").held_work!;
    expect(text).toContain(held);
    expect(text).toMatch(/on origin: unknown/);
    expect(text).toMatch(/pull requests from it: unknown/i);
    expect(text).not.toContain("not on origin");
    expect(text).not.toContain("(none)");
  }, 60_000);

  it("a recorded escalation checked again after the step threw saves one held patch and logs held-work once (AC-1, spec 015 AC-10)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({
      implement: [(run: StageRun) => { commitIn(run.worktree, { "work.txt": "w\n" }); return { escalation: capability }; }],
    }), prRoutes(state), (p) => { state.pair = p; });
    const logs: Record<string, unknown>[] = [];
    let failures = 1;
    t.deps.log = (r) => {
      logs.push(r);
      if (r.kind === "transition" && failures-- > 0) throw new Error("getaddrinfo EAI_AGAIN api.github.com");
    };
    const c = at(t.claim, { stage: "implement", plan: plan as never });
    await writeClaim(t.paths, c);
    await expect(step(t.deps, c)).rejects.toThrow(/EAI_AGAIN/);
    const kept = (await readClaim(t.paths, 7))!;
    expect(kept.stageRun?.stage).toBe("implement");
    const r = await step(t.deps, kept);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "stage-result-kept", stage: "implement" }));
    expect(r.claim.state).toMatchObject({ stage: "question-check", heldWork: { branch: "issue-7" } });
    expect(readdirSync(t.paths.patches).filter((f) => f.includes("held"))).toHaveLength(1);
    expect(logs.filter((l) => l.kind === "held-work")).toHaveLength(1);
  }, 60_000);

  it("a network failure fetching the held branch fails the step and keeps the held work untouched (AC-5)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p) => { state.pair = p; });
    const logs = logsOf(t.deps);
    const scratch = join(t.pair.root, "scratch");
    git(t.pair.root, "clone", "-q", t.pair.origin, scratch);
    git(scratch, "checkout", "-q", "-b", "issue-7");
    const remoteHead = commitIn(scratch, { "other.txt": "o\n" });
    git(scratch, "push", "-q", "origin", "issue-7");
    const lost = "1".repeat(40);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: lost } });
    await writeClaim(t.paths, c);
    // The service's own fetch got through; the branch fetch then hits the outage.
    t.deps.fetchOrigin = async () => {};
    git(t.claim.worktree, "remote", "set-url", "origin", join(t.pair.root, "nonexistent.git"));
    try {
      await expect(step(t.deps, c)).rejects.toThrow();
    } finally {
      git(t.claim.worktree, "remote", "set-url", "origin", t.pair.origin);
    }
    expect(logs.find((r) => r.kind === "held-work-lost")).toBeUndefined();
    expect(logs.find((r) => r.kind === "stale-branch-dropped")).toBeUndefined();
    expect((await readClaim(t.paths, 7))?.state.heldWork).toEqual({ branch: "issue-7", head: lost });
    expect(git(t.pair.origin, "rev-parse", "refs/heads/issue-7").trim()).toBe(remoteHead);
  }, 60_000);

  it("runs as without held work when the held head is already on main (AC-5)", async () => {
    const t = await setup(() => ({ implement: [] }));
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: { branch: "issue-7", head: head(t.claim.worktree) } });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs.find((r) => r.kind === "held-work-kept")).toBeUndefined();
  }, 60_000);

  it("keeps issue-7 locally and on origin while the spec track records an answer, and delete_branch puts the worktree back on it (AC-6)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    let held = "";
    const t = await setup(() => ({ spec: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      held = commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const heldWork = { branch: "issue-7", head: held };
    const c = at(t.claim, { stage: "spec", track: "spec", specMode: "record", heldWork });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(t.adapter.heads).toEqual(["spec-7"]);
    expect(logs.find((r) => r.kind === "recovered-commits" || r.kind === "stale-branch-dropped")).toBeUndefined();
    expect(originHas(state.pair!, "issue-7")).toBe(true);
    expect(git(t.claim.worktree, "rev-parse", "issue-7").trim()).toBe(held);
    expect(head(t.claim.worktree)).toBe(git(state.pair!.repo, "rev-parse", "origin/main").trim());

    await applyActions(t.deps, at(t.claim, { track: "issue", heldWork }), [{ type: "delete_branch", branch: "spec-7" }]);
    expect(branchIn(t.claim.worktree)).toBe("issue-7");
    expect(head(t.claim.worktree)).toBe(held);
  }, 60_000);

  it("still drops the stale branch and resets when there is no held work (AC-8)", async () => {
    const state: { pair?: ReturnType<typeof repoPair> } = {};
    const t = await setup(() => ({ implement: [] }), prRoutes(state), (p, wt) => {
      state.pair = p;
      commitIn(wt, { "work.txt": "w\n" });
      git(wt, "push", "-q", "origin", "issue-7");
    });
    const logs = logsOf(t.deps);
    const c = at(t.claim, { stage: "implement", plan: plan as never, heldWork: null });
    await writeClaim(t.paths, c);
    await step(t.deps, c);
    expect(logs.map((r) => r.kind)).toEqual(expect.arrayContaining(["recovered-commits", "stale-branch-dropped"]));
    expect(originHas(state.pair!, "issue-7")).toBe(false);
    expect(head(t.claim.worktree)).toBe(git(state.pair!.repo, "rev-parse", "origin/main").trim());
  }, 60_000);
});

/** The PR branch issue-7 on origin with one commit of its own, and main moved on since, so the driver's rebase moves HEAD. */
function prBehindMain(pair: ReturnType<typeof repoPair>, wt: string): void {
  commitIn(wt, { "feature.txt": "feature\n" }, "feature");
  git(wt, "push", "-q", "-u", "origin", "issue-7");
  writeFileSync(join(pair.repo, "main.txt"), "main moved\n");
  git(pair.repo, "add", "main.txt");
  git(pair.repo, "commit", "-q", "-m", "main moved");
  git(pair.repo, "push", "-q", "origin", "main");
}
/** A scripted adapter whose failing runs are rate-limited (429), as when the Claude quota is spent. */
function rateLimited(results: Record<string, Scripted[]>): ReturnType<typeof scriptedAdapter> {
  const a = scriptedAdapter(results);
  return { ...a, judge: (e, exit, timedOut) => exit === 0 ? a.judge(e, exit, timedOut) : { outcome: "failed", reason: "You've hit your session limit", apiErrorStatus: 429, finalText: null } };
}
const dnsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" }) });
const patchFiles = (paths: ReturnType<typeof statePaths>) => readdirSync(paths.patches).filter((f) => /^7-.*\.patch$/.test(f));

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
    deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch }, retry: { enabled: false } }), "o/r");
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
    expect(adapter.ran).toEqual(["plan:claude-fable-5-1"]);
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
    deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch }, retry: { enabled: false } }), "o/r");
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
    expect(adapter.ran).toEqual(["review:claude-fable-5-1"]);
    expect(logs).toContainEqual(expect.objectContaining({ kind: "stage-result-kept", stage: "review" }));
    expect(logs).toContainEqual(expect.objectContaining({ kind: "pr-closed", pr: 9 }));
    expect(r.claim.state).toMatchObject({ stage: "plan", replans: 1, pr: null });
    expect(gh.calls.filter((x) => x.method === "POST" && x.url === "/repos/o/r/issues/9/comments")).toHaveLength(2);
  }, 60_000);
});

/** `conflicting`, then the conflict resolved by merging origin/main into the branch (PR #77's shape). */
function mergeMainResolved(worktree: string): void {
  git(worktree, "fetch", "-q", "origin");
  expect(() => git(worktree, "merge", "-q", "--no-edit", "origin/main")).toThrow();
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  git(worktree, "add", "a.txt");
  git(worktree, "commit", "-q", "--no-edit");
}

describe("driver: a rebase respects merged main (spec 024)", () => {
  const fixInputs = (paths: ReturnType<typeof statePaths>) => readdirSync(paths.runs).filter((d) => d.startsWith("7-fix-")).sort()
    .map((d) => JSON.parse(readFileSync(join(paths.runs, d, "input.json"), "utf8")).fix_input as string);

  it("a branch that merged main runs its review on the same head, with no conflict raised (AC-1; PR #77)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({ review: [approve] }), undefined, (pair, wt) => { conflicting(pair, wt); mergeMainResolved(wt); });
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    const r = await step(deps, atReview);
    expect(adapter.ran).toEqual(["review:claude-fable-5-1"]);
    expect(r.claim.state).toMatchObject({ stage: "merge", fixes: 0, conflictPending: false, history: [] });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a fix that returns the unchanged head fails, a rescue is told the real state, and a second one closes the PR (AC-3, AC-5; PR #77)", async () => {
    const unchanged = (sha: string) => ({ head_sha: sha, addressed: [0, 1] });
    const { deps, claim, adapter, paths, sha } = await setup((sha) => ({ fix: [unchanged(sha), unchanged(sha)] }), undefined, conflicting);
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state).toMatchObject({ stage: "fix", conflictPending: true });
    expect(r.claim.state.history.at(-1)).toMatch(/origin\/main conflicted before review[\s\S]*CONFLICT/);
    r = await step(deps, r.claim);
    expect(r.claim.state).toMatchObject({ stage: "fix", fixes: 0, conflictPending: true, rescues: 1, rescueRun: true });
    r = await step(deps, r.claim);
    expect(adapter.ran).toHaveLength(2);
    expect(fixInputs(paths)[1]).toMatch(/unchanged/);
    expect(fixInputs(paths)[1]).toContain(sha);
    expect(r.claim.state).toMatchObject({ stage: "plan", replans: 1, pr: null, conflictPending: false });
  }, 60_000);

  it("a branch holding a merge with a real conflict is told to merge, not rebase, and its merge survives (AC-2, AC-3)", async () => {
    let wtPath = "";
    const resolve = (run: StageRun) => { mergeMainResolved(run.worktree); return { head_sha: head(run.worktree), addressed: [] }; };
    const { deps, claim, adapter, paths, sha } = await setup(() => ({ fix: [resolve], review: [approve] }), (sha) => ghRoutes(sha, { prs: { 9: { head: () => head(wtPath) } } }), (pair, wt) => {
      wtPath = wt;
      conflicting(pair, wt);
      mergeMainResolved(wt);
      writeFileSync(join(pair.repo, "a.txt"), "main again\n");
      git(pair.repo, "commit", "-q", "-am", "main again");
      git(pair.repo, "push", "-q", "origin", "main");
    });
    const atReview: Claim = { ...claim, state: { ...claim.state, stage: "review", plan: plan as never, pr: { number: 9, head_sha: sha } } };
    let r = await step(deps, atReview);
    expect(r.claim.state).toMatchObject({ stage: "fix", conflictPending: true });
    expect(head(claim.worktree)).toBe(sha);
    r = await step(deps, r.claim);
    const [input] = fixInputs(paths);
    expect(input).toMatch(/^Bring this branch up to date with origin\/main/);
    expect(input).not.toMatch(/rebase this branch|rebase onto/i);
    expect(input).toMatch(/merge origin\/main into it rather than rebasing/);
    expect(r.claim.state).toMatchObject({ stage: "verify", fixes: 1, conflictPending: false });
    expect((await steps(deps, r.claim, 2)).state.stage).toBe("merge");
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5", "review:claude-fable-5-1"]);
    expect(git(claim.worktree, "rev-list", "--merges", "--count", "origin/main..HEAD").trim()).toBe("2");
  }, 60_000);

  it("a conflict pending on a head that already holds main runs no agent and goes to verify (AC-4)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({}), undefined, (pair, wt) => { conflicting(pair, wt); mergeMainResolved(wt); });
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "Rebase onto main conflicted:\nCONFLICT a.txt" } };
    const r = await step(deps, atFix);
    expect(adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "verify", conflictPending: false, fixes: 1 });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a conflict pending that no longer conflicts leaves no unpushed rebase behind (AC-4)", async () => {
    const { deps, claim, adapter, sha } = await setup(() => ({}), undefined, prBehindMain);
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "stale" } };
    const r = await step(deps, atFix);
    expect(adapter.ran).toEqual([]);
    expect(r.claim.state).toMatchObject({ stage: "verify", conflictPending: false });
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);

  it("a conflict still real is left to the fix agent, with the worktree where the sync put it (AC-4, C1)", async () => {
    const { deps, claim, adapter, sha } = await setup((sha) => ({ fix: [{ head_sha: sha, addressed: [] }] }), undefined, conflicting);
    const atFix: Claim = { ...claim, state: { ...claim.state, stage: "fix", plan: plan as never, pr: { number: 9, head_sha: sha }, conflictPending: true, pendingFixInput: "Rebase onto main conflicted:\nCONFLICT a.txt" } };
    await step(deps, atFix);
    expect(adapter.ran).toEqual(["fix:claude-sonnet-5-5"]);
    expect(git(claim.worktree, "status", "--porcelain").trim()).toBe("");
    expect(head(claim.worktree)).toBe(sha);
  }, 60_000);
});
