import { openIndex } from "../../src/events/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { expect, onTestFinished } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../../src/config.ts";
import { GitHubClient } from "../../src/github/client.ts";
import { Scheduler, type SchedulerDeps } from "../../src/service/loop.ts";
import { ServiceLog } from "../../src/service/log.ts";
import { SleepInhibitor } from "../../src/service/inhibit.ts";
import { loadStageDefinitions } from "../../src/stages/definition.ts";
import { listClaims, writeClaim } from "../../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../../src/state/paths.ts";
import { initialChainState } from "../../src/chain/machine.ts";
import { step } from "../../src/chain/driver.ts";
import type { PausedRecord } from "../../src/state/paused.ts";
import type { Question } from "../../src/types.ts";
import type { Notification } from "../../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./mock-github.ts";
import { git, repoPair, withTopDesign } from "./repo-pair.ts";
import { watchTickErrors } from "./tick-errors.ts";

// The shared setup of the loop-*.test.ts files, split from one loop.test.ts so vitest runs them in parallel (issue #360).

export const spec = readFileSync(join(import.meta.dirname, "..", "fixtures", "specs", "good-backend.md"), "utf8");
export const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
export const issue = (n: number, labels = ["validated", "class:product"]) => ({ number: n, title: `i${n}`, body: "Spec: specs/010-thing/spec.md", user: BOT, labels: labels.map((name) => ({ name })), created_at: `2026-10-0${n}T00:00:00Z`, updated_at: "2026-10-12T00:00:00Z" });

export function routes(issues: unknown[], labelsNow: Record<number, string[]> = {}, comments: Record<number, unknown[]> = {}): Route[] {
  let commentId = 900;
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, reply: (m, _b, url) => ({ body: comments[Number(m[1])] ?? [], headers: pageLink(url, 1, 1) }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: issues, headers: pageLink(url, 1, 1) }) },
    { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: issues.length } } } } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/\d+\/timeline$/, reply: () => ({ body: [] }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)$/, reply: (m) => ({ body: { ...issue(Number(m[1])), labels: (labelsNow[Number(m[1])] ?? ["validated", "in-progress"]).map((name) => ({ name })) } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/\d+\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: { id: ++commentId, created_at: "2026-10-12T12:00:00Z" } }) },
  ];
}

export type Drive = NonNullable<ConstructorParameters<typeof Scheduler>[1]>["driveChain"];
export async function setup(rs: Route[], slots = 1, drive?: Drive, specFile = spec) {
  const pair = repoPair(withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": specFile }, "specs/010-thing/spec.md"));
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  // fallback after the caller's routes (first match wins): a tick that loads the registry may list check runs
  const mainChecks: Route = { method: "GET", path: /^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) };
  const gh = mockGitHub([...rs, mainChecks]);
  const notifications: Notification[] = [];
  const started: number[] = [];
  let now = new Date("2026-10-12T12:00:00Z");
  let mono = 0;
  let probeCause: string | null = null;
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", slots, state_dir: paths.root, poll_interval_s: 5 };
  const deps: SchedulerDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [0, 0, 0] }),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    // the "chain" here is a stub: it records the issue and parks the claim in verify so the test controls time
    adapterFor: () => { throw new Error("not used"); }, systemdScope: false, now: () => now, log: () => {},
    fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
    botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
    scanChildren: async () => {},
    // Spec 100: the host probe; a test fails it with setProbe(cause).
    probeHost: async () => probeCause,
    fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => mono, requestRestart: () => { started.push(-1); },
  };
  const s = new Scheduler(deps, { driveChain: drive ?? (async (_d, claim) => { started.push(claim.issue); return { ...claim, state: { ...claim.state, stage: "verify" } }; }) });
  const watcher = watchTickErrors(s);
  onTestFinished(() => watcher.check());
  const watch = (scheduler: Scheduler) => { const w = watchTickErrors(scheduler); onTestFinished(() => w.check()); return scheduler; };
  return { s, deps, gh, notifications, setProbe: (c: string | null) => { probeCause = c; }, allowErrors: watcher.allow, watch, started, paths, pair, setNow: (d: Date) => { now = d; }, setMono: (m: number) => { mono = m; } };
}

export function claimedPayloads(paths: ReturnType<typeof statePaths>, issue: number): unknown[] {
  const db = openIndex(paths);
  const rows = db.prepare("SELECT payload FROM events WHERE issue = ? AND kind = 'issue.claimed' ORDER BY at, rowid").all(issue) as { payload: string }[];
  db.close();
  return rows.map((r) => JSON.parse(r.payload));
}

export function staleRows(paths: ReturnType<typeof statePaths>): [string, number, unknown][] {
  const db = openIndex(paths);
  const rows = db.prepare("SELECT kind, issue, payload FROM events WHERE issue = 7 AND kind IN ('chain.transition', 'issue.claimed', 'issue.released') ORDER BY at, rowid").all() as { kind: string; issue: number; payload: string }[];
  db.close();
  return rows.map((r) => [r.kind, r.issue, JSON.parse(r.payload)]);
}

export const Q: Question = { kind: "technical", question: "Which store?", options: [{ label: "a", cost: "cheap" }, { label: "b", cost: "dear" }], recommendation: "a" };
export const ME = "adam26davidson";
export const BOT_LOGIN = "panelator-pipeline[bot]";
export const comment = (id: number, login: string, at: string, body: string) => ({ id, user: { login }, created_at: at, body });
export const pausedState = () => ({ ...initialChainState(7), stage: "paused" as const, askingStage: "plan" as const, question: Q, rescues: 1 });
export const record = (over: Partial<PausedRecord> = {}): PausedRecord => ({
  issue: 7, phase: "paused", state: pausedState(), question: Q, asking_stage: "plan", nonce: "nonce-7",
  question_comment_id: 500, asked_at: "2026-10-12T08:00:00Z", reminded: false, answer: null, reply_comment_id: null, ...over,
});
export const waiting = (labels = ["validated", "class:product", "needs-decision"]) => issue(7, labels);
/** The real first step of the chain, so a resume's `answered` event is applied as the driver applies it. */
export const firstStep: NonNullable<Drive> = async (d, claim) => (await step(d, claim)).claim;
/** Spec 101 AC-1: poll every `stepMs` until every condition holds; at the bound, fail naming those still false. */
export async function waitFor(conditions: Record<string, () => boolean | Promise<boolean>>, timeoutMs = 25_000, stepMs = 10): Promise<void> {
  const missing = async () => { const out: string[] = []; for (const [name, f] of Object.entries(conditions)) if (!(await f())) out.push(name); return out; };
  const end = Date.now() + timeoutMs;
  let left = await missing();
  while (left.length && Date.now() < end) { await new Promise((r) => setTimeout(r, stepMs)); left = await missing(); }
  if (left.length) expect.fail(`timed out after ${timeoutMs} ms waiting for: ${left.join(", ")}`);
}

export const settle = () => new Promise((r) => setTimeout(r, 100));
export const logLines = (paths: { questionsLog: string }) => { try { return readFileSync(paths.questionsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const labelCalls = (gh: { calls: { method: string; url: string; body: unknown }[] }, n: number) =>
  gh.calls.filter((c) => c.url.startsWith(`/repos/o/r/issues/${n}/labels`)).map((c) => (c.method === "POST" ? `+${(c.body as { labels: string[] }).labels.join(",")}` : `-${decodeURIComponent(c.url.split("/").pop()!)}`));

export const dns =() => Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" });
export const serviceRecords = (paths: { serviceLog: string }) => readFileSync(paths.serviceLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

export type Harness =Awaited<ReturnType<typeof setup>>;
export const FUTURE = "2026-10-12T13:00:00Z";
export const PAST = "2026-10-12T11:00:00Z";
export const writeWaiting = (h: Harness, n: number, postponedUntil: string) =>
  writeClaim(h.paths, {
    issue: n, state: { ...initialChainState(n), stage: "waiting", resumeStage: "review", postponedUntil },
    worktree: join(h.pair.worktrees, `issue-${n}`), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null,
  });
export const rmClaim = async (h: Harness, n: number) => (await import("node:fs/promises")).unlink(join(h.paths.claims, `${n}.json`));
export const holdingDrive = () => {
  const st = { release: () => {}, started: [] as number[] };
  const drive: Drive = async (_d, claim) => { st.started.push(claim.issue); await new Promise<void>((r) => { st.release = r; }); return claim; };
  return { st, drive };
};

/** A run log shared by a chain stub and a standing-agent stub, each held until the test releases it. */
export const grantLog = () => {
  const grants: string[] = [];
  const held = new Map<string, () => void>();
  const hold = (key: string) => new Promise<void>((r) => { grants.push(key); held.set(key, r); });
  const release = async (key: string) => { held.get(key)?.(); held.delete(key); await settle(); };
  const drive: Drive = async (_d, claim) => { await hold(`chain:${claim.issue}`); return claim; };
  return { grants, hold, release, drive };
};
export const readyClaim = (h: Harness, n: number) =>
  writeClaim(h.paths, { issue: n, state: { ...initialChainState(n), stage: "verify" }, worktree: join(h.pair.worktrees, `issue-${n}`), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null });
/** Registers the action-audit agent; `due` puts its next_run at now. The stub never updates its state, so it stays due after each run. */
export async function withStanding(h: Harness, log: ReturnType<typeof grantLog>, due = true) {
  const { loadRegistry } = await import("../../src/standing/registry.ts");
  const { EVENT_NAMES } = await import("../../src/standing/events.ts");
  const { registryActionsCheck } = await import("../../src/actions/index.ts");
  const { loadParameterDefinitions } = await import("../../src/parameters/definitions.ts");
  const { ParameterStore } = await import("../../src/parameters/store.ts");
  const { initializeAgents, readAgentState, writeAgentState } = await import("../../src/standing/state.ts");
  const all = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
  h.deps.registry = { "action-audit": all["action-audit"] };
  h.deps.parameters = new ParameterStore(h.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), h.deps.cfg, h.deps.registry));
  await initializeAgents(h.paths, h.deps.registry, h.deps.parameters, h.deps.now());
  const state = (await readAgentState(h.paths, "action-audit"))!;
  if (due) await writeAgentState(h.paths, "action-audit", { ...state, next_run: h.deps.now().toISOString() });
  h.deps.runStanding = async () => { await log.hold("standing"); };
}
export const answeredRoutes = (shortlist: unknown[] = []) =>
  routes([waiting(), ...shortlist], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });

/** A SleepInhibitor over a fake systemd-inhibit: records each spawn's --why, each kill, and the service-log records. */
export const recordingInhibitor = () => {
  const spawned: string[] = [], killed: string[] = [], logged: Record<string, unknown>[] = [];
  const spawn = ((_cmd: string, args: string[]) => { const why = args.find((a) => a.startsWith("--why="))!.slice(6); spawned.push(why); return { kill: () => { killed.push(why); return true; }, unref() {}, on(ev: string, fn: () => void) { if (ev === "spawn") fn(); } }; }) as never;
  return { spawned, killed, logged, inhibitor: new SleepInhibitor({ enabled: true, spawn, log: (r) => logged.push(r) }) };
};

export async function outageSetup(drive: Drive, listed: () => unknown[] = () => []) {
  const rs = routes([]).map((r) =>
    String(r.path) === String(/^\/repos\/o\/r\/issues$/) ? { ...r, reply: (_m: RegExpExecArray, _b: unknown, url: URL) => ({ body: listed(), headers: pageLink(url, 1, 1) }) }
      : String(r.path) === String(/^\/graphql$/) ? { ...r, reply: () => ({ body: { data: { repository: { issues: { totalCount: listed().length } } } } }) } : r);
  const t = await setup(rs, 1, drive);
  const events: { event: string; payload: unknown }[] = [];
  t.deps.emitEvent = async (event, payload) => { events.push({ event, payload }); };
  await writeClaim(t.paths, { issue: 7, state: { ...initialChainState(7), stage: "verify" }, worktree: join(t.pair.worktrees, "issue-7"), started_at: t.deps.now().toISOString(), last_activity_at: t.deps.now().toISOString(), run_id: null });
  let now = t.deps.now();
  const advance = (s: number) => { now = new Date(now.getTime() + s * 1000); t.setNow(now); };
  return { ...t, events, advance, claim: async () => (await listClaims(t.paths))[0] };
}
