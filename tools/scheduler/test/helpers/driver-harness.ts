import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { expect } from "vitest";
import type { Adapter, StageRun } from "../../src/adapters/types.ts";
import { initialChainState } from "../../src/chain/machine.ts";
import type { ChainState } from "../../src/chain/types.ts";
import { step, type DriverDeps } from "../../src/chain/driver.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../../src/config.ts";
import { GitHubClient } from "../../src/github/client.ts";
import { ensureWorktree } from "../../src/runner/worktree.ts";
import { loadStageDefinitions } from "../../src/stages/definition.ts";
import { writeClaim, type Claim } from "../../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../../src/state/paths.ts";
import type { Notification } from "../../src/notify/types.ts";
import type { Question } from "../../src/types.ts";
import { mockGitHub, type Route } from "./mock-github.ts";
import { git, repoPair, withTopDesign } from "./repo-pair.ts";

// The shared setup of the driver-*.test.ts files, split from one driver.test.ts so vitest runs them in parallel (issue #360).

export const script = join(import.meta.dirname, "..", "fixtures", "stage-script.ts");
export const events = join(import.meta.dirname, "..", "fixtures", "streams", "claude-success.jsonl");
export const spec = readFileSync(join(import.meta.dirname, "..", "fixtures", "specs", "good-backend.md"), "utf8");

/** A scripted result: a value, or a function of the run that may do the agent's git work first and returns the result. */
export type Scripted = unknown | ((run: StageRun) => unknown);

/** One fake adapter that answers per stage from a script of results; `heads` records the branch each run started on. */
export function scriptedAdapter(results: Record<string, Scripted[]>): Adapter & { ran: string[]; heads: string[] } {
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

export interface PrOver { headRef?: string; head?: string | (() => string); body?: string; merged?: boolean; mergeable?: boolean; state?: "open" | "closed" }
export interface RouteOver { openPrs?: { number: number; added: string[] }[]; checks?: unknown[]; mergeable?: boolean; merged?: boolean; issueLabels?: string[]; prHead?: string; headRef?: string; issueBody?: string; prs?: Record<number, PrOver> }

export function ghRoutes(sha: string, over: RouteOver = {}): Route[] {
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
    { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: (over.openPrs ?? []).map((p) => ({ number: p.number })) }) },
    { method: "GET", path: /^\/repos\/o\/r\/pulls\/(\d+)\/files$/, reply: (m) => ({ body: (over.openPrs?.find((p) => p.number === Number(m[1]))?.added ?? []).map((filename) => ({ filename, status: "added" })) }) },
    { method: "PATCH", path: /^\/repos\/o\/r\/pulls\/\d+$/, reply: () => ({ body: {} }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/.+$/, reply: () => ({ status: 204, body: null }) },
    { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: checks.length, check_runs: checks } }) },
    { method: "POST", path: /^\/repos\/o\/r\/check-runs\/\d+\/rerequest$/, reply: () => ({ status: 201, body: {} }) },
    { method: "PUT", path: /^\/repos\/o\/r\/pulls\/\d+\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
  ];
}

/** `results` and `routes` take the worktree's real HEAD, which the PR binding (AC-10/AC-11) checks against; `prepare` runs before it is read. */
export async function setup(
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
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch } }), "o/r"),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: () => {}, fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
    freeSpace: async () => ({ bytes: 20 * 2 ** 30, inodes: 1e6 }),
  };
  const claim: Claim = { issue: 7, state: initialChainState(7), worktree: wt.path, started_at: new Date().toISOString(), last_activity_at: new Date().toISOString(), run_id: null };
  await writeClaim(paths, claim);
  return { deps, claim, gh, notifications, adapter, pair, paths, sha };
}

export const plan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
export const impl = (sha: string) => ({ pr_number: 9, head_sha: sha, tasks_done: ["T1"] });
export const settled = { conversation: "settled", decision: "approve it", findings: [] };
export const outside = "conversation turn outside a conversation";

export const approve = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };

/** A stand-in for systemd-run, written to tmp: drops the scope flags and runs the command after `--`. */
export function fakeSystemdRun(dir: string): string {
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
export function conflicting(pair: ReturnType<typeof repoPair>, worktree: string): void {
  writeFileSync(join(worktree, "a.txt"), "worktree\n");
  git(worktree, "commit", "-q", "-am", "worktree change");
  writeFileSync(join(pair.repo, "a.txt"), "main\n");
  git(pair.repo, "commit", "-q", "-am", "main change");
  git(pair.repo, "push", "-q", "origin", "main");
}

export async function steps(deps: DriverDeps, claim: Claim, n: number): Promise<Claim> {
  let c = claim;
  for (let i = 0; i < n; i++) c = (await step(deps, c)).claim;
  return c;
}

export const Q: Question = { kind: "technical", question: "Which store?\nIt decides the schema.", options: [{ label: "a", cost: "cheap" }, { label: "b", cost: "dear" }], recommendation: "a" };

export function at(claim: Claim, patch: Partial<ChainState>, extra: Partial<Claim> = {}): Claim {
  return { ...claim, ...extra, state: { ...claim.state, ...patch } };
}
/** Every call that changes something on GitHub, in order. */
export const writes = (gh: { calls: { method: string; url: string }[] }) => gh.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url}`);
/** The input.json of the newest run whose id starts with `prefix`. */
export function inputOf(paths: ReturnType<typeof statePaths>, prefix: string): StageInputJson {
  const dir = readdirSync(paths.runs).filter((d) => d.startsWith(prefix)).sort().at(-1)!;
  return JSON.parse(readFileSync(join(paths.runs, dir, "input.json"), "utf8"));
}
export type StageInputJson = Record<string, string | undefined>;
export function commitIn(wt: string, files: Record<string, string>, msg = "work"): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(wt, p, ".."), { recursive: true });
    writeFileSync(join(wt, p), c);
  }
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", msg);
  return git(wt, "rev-parse", "HEAD").trim();
}
export const head = (wt: string) => git(wt, "rev-parse", "HEAD").trim();
export const branchIn = (wt: string) => git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim();
export const ledgerFile = (paths: ReturnType<typeof statePaths>) => join(paths.escalations, "7.json");
export const logEvents = (paths: ReturnType<typeof statePaths>) => readFileSync(paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
export const onSpec7 = (_pair: ReturnType<typeof repoPair>, wt: string) => {
  git(wt, "checkout", "-q", "-b", "spec-7");
  commitIn(wt, { "specs/010-thing/notes.md": "notes\n" }, "spec work");
  git(wt, "push", "-q", "-u", "origin", "spec-7");
};

/** The PR branch issue-7 on origin with one commit of its own, and main moved on since, so the driver's rebase moves HEAD. */
export function prBehindMain(pair: ReturnType<typeof repoPair>, wt: string): void {
  commitIn(wt, { "feature.txt": "feature\n" }, "feature");
  git(wt, "push", "-q", "-u", "origin", "issue-7");
  writeFileSync(join(pair.repo, "main.txt"), "main moved\n");
  git(pair.repo, "add", "main.txt");
  git(pair.repo, "commit", "-q", "-m", "main moved");
  git(pair.repo, "push", "-q", "origin", "main");
}
/** A scripted adapter whose failing runs are rate-limited (429), as when the Claude quota is spent. */
export function rateLimited(results: Record<string, Scripted[]>): ReturnType<typeof scriptedAdapter> {
  const a = scriptedAdapter(results);
  return { ...a, judge: (e, exit, timedOut) => exit === 0 ? a.judge(e, exit, timedOut) : { outcome: "failed", reason: "You've hit your session limit", apiErrorStatus: 429, finalText: null } };
}
export const dnsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" }) });
export const patchFiles = (paths: ReturnType<typeof statePaths>) => readdirSync(paths.patches).filter((f) => /^7-.*\.patch$/.test(f));

/** `conflicting`, then the conflict resolved by merging origin/main into the branch (PR #77's shape). */
export function mergeMainResolved(worktree: string): void {
  git(worktree, "fetch", "-q", "origin");
  expect(() => git(worktree, "merge", "-q", "--no-edit", "origin/main")).toThrow();
  writeFileSync(join(worktree, "a.txt"), "resolved\n");
  git(worktree, "add", "a.txt");
  git(worktree, "commit", "-q", "--no-edit");
}

/** A scripted adapter whose failing runs are judged as `outcome` with `status` and `reason`. */
export function judgedAs(results: Record<string, Scripted[]>, status: number | null, reason: string, outcome: "failed" | "timeout" | "bounds" = "failed"): ReturnType<typeof scriptedAdapter> {
  const a = scriptedAdapter(results);
  return { ...a, judge: (e, exit, timedOut) => exit === 0 ? a.judge(e, exit, timedOut) : { outcome, reason, apiErrorStatus: status, finalText: null } };
}
export const UNREACHABLE = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";
