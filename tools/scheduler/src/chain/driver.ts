import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { adapterFor as defaultAdapterFor } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { isSensitive, scopeGate } from "../gates/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { Notifier } from "../notify/types.ts";
import { listProfiles, readSensitiveGlobs, resolveProfile } from "../profiles/resolve.ts";
import { retryDecision } from "../runner/retry.ts";
import { runStage, type StageOutcome } from "../runner/run.ts";
import { commitsPatch, diffFilesAgainstBase, discardUncommitted, rebaseOntoMain, removeWorktree, resetToBase, syncToRemote, uncommittedPatch } from "../runner/worktree.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { StageInput } from "../stages/prompt.ts";
import { removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { appendMerge } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import type { StatePaths } from "../state/paths.ts";
import { newRunId } from "../state/runs.ts";
import { classOf } from "../shortlist/rank.ts";
import type { AgentStageName, FixResult, Harness, ImplementResult, Profile, StageDefinition } from "../types.ts";
import { POSTPONE_WAIT_S, transition } from "./machine.ts";
import type { Action, ChainEvent, ChainState } from "./types.ts";

const execFileP = promisify(execFile);

export interface DriverDeps {
  cfg: Config;
  paths: StatePaths;
  gh: GitHubClient;
  notifier: Notifier;
  stages: Record<AgentStageName, StageDefinition>;
  agentsDir: string;
  repoDir: string;
  binDir: string;
  adapterFor: (harness: Harness) => Adapter;
  systemdScope: boolean;
  /** Test seam: a stand-in for systemd-run; production leaves it unset. */
  systemdRunBin?: string;
  /** I2: whether a stage scope unit is still active, and a best-effort stop for one. */
  unitActive: (unit: string) => Promise<boolean>;
  stopUnit: (unit: string) => Promise<void>;
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  fetchOrigin: () => Promise<void>;
}

export type StepStatus = "continue" | "waiting" | "ended";
const AGENT_STAGES: AgentStageName[] = ["plan", "implement", "review", "fix"];
const ENDED: ChainState["stage"][] = ["done", "released", "abandoned", "paused"];
/** C1: prepended to the fix input when the fix stage has to resolve a rebase conflict itself. */
export const CONFLICT_FIX_LINE = "Rebase this branch onto origin/main and resolve the conflicts before addressing the items below.";
const stageUnit = (runId: string) => `panelator-stage-${runId}`;

export { defaultAdapterFor };

function specOnMain(repoDir: string, path: string | null): string {
  if (!path) return "";
  try {
    return execFileSync("git", ["show", `origin/main:${path}`], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function worktreeHead(worktree: string): Promise<string> {
  return (await execFileP("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" })).stdout.trim();
}

async function buildInput(deps: DriverDeps, claim: Claim, issueTitle: string, issueBody: string, specText: string, ci: string | undefined): Promise<StageInput> {
  const s = claim.state;
  const pr = s.pr ? { number: s.pr.number, head_sha: s.pr.head_sha, url: `https://github.com/${deps.cfg.repo}/pull/${s.pr.number}` } : undefined;
  return {
    issue: { number: claim.issue, title: issueTitle, body: issueBody },
    spec: specText, plan: s.plan ?? undefined, pr, ci,
    fix_input: s.pendingFixInput === null ? undefined : s.conflictPending ? `${CONFLICT_FIX_LINE}\n${s.pendingFixInput}` : s.pendingFixInput,
    result_path: "", profile_instructions: "",
  };
}

function pickProfile(deps: DriverDeps, def: StageDefinition, state: ChainState, security: boolean): Profile | null {
  if (security && def.name === "review") return resolveProfile(deps.agentsDir, "security");
  if (def.profile === "none") return null;
  // I4: an unknown profile throws; the plan stage already refused a domain with no profile.
  return resolveProfile(deps.agentsDir, def.profile === "from-issue" ? state.plan?.domain ?? "backend" : def.profile);
}

/** AC-10/AC-11: the result must name the commit the worktree is on, and the PR must be issue-N into main at that same commit (I1). */
async function prBound(deps: DriverDeps, claim: Claim, stage: "implement" | "fix", result: ImplementResult | FixResult): Promise<boolean> {
  const head = await worktreeHead(claim.worktree);
  if (result.head_sha !== head) return false;
  const prNumber = stage === "implement" ? (result as ImplementResult).pr_number : claim.state.pr?.number;
  if (prNumber === undefined) return false;
  const pr = await deps.gh.pullRequest(prNumber);
  return pr.head_sha === result.head_sha && pr.base_ref === "main" && pr.head_ref === `issue-${claim.issue}`;
}

/** `null`: the claim's previous stage is still running in its scope (survived a scheduler crash); wait for it. */
/** The bot identity every commit the scheduler makes or rewrites carries (stage commits and rebases alike). */
function botIdentity(deps: DriverDeps): { name: string; email: string } {
  return { name: deps.cfg.app.bot_login, email: `${deps.cfg.app.bot_login}@users.noreply.github.com` };
}

/**
 * Fetch, keep any leftovers as a patch, then put the worktree where the next step must see it: current
 * main while there is no PR (C1), otherwise the PR branch's remote head (R1), so the diffs the gates
 * judge (sensitivity, scope) are of the commit GitHub holds and not of a stale local copy. Commits the reset
 * or sync discards are saved as a patch first (spec 005), like the uncommitted leftovers.
 */
async function syncWorktree(deps: DriverDeps, claim: Claim): Promise<void> {
  await deps.fetchOrigin();
  // A dirty tree makes the rebase or reset throw or lose work: keep the leftovers as a patch, then start from HEAD.
  const patch = await uncommittedPatch(claim.worktree);
  if (patch.trim()) {
    const saved = await savePatch(deps.paths, claim.issue, patch, deps.now(), "uncommitted");
    await discardUncommitted(claim.worktree);
    deps.log({ kind: "recovered-uncommitted", issue: claim.issue, patch: saved });
  }
  if (claim.state.pr === null) {
    const commits = await commitsPatch(claim.worktree, "origin/main");
    if (commits.trim()) {
      const saved = await savePatch(deps.paths, claim.issue, commits, deps.now(), "commits");
      deps.log({ kind: "recovered-commits", issue: claim.issue, patch: saved, base: "origin/main" });
    }
    await resetToBase(claim.worktree);
    return;
  }
  const remoteBranch = `origin/issue-${claim.issue}`;
  const sync = await syncToRemote(claim.worktree, remoteBranch);
  if (!sync.moved) return;
  // The dropped head is still in the object store after the reset.
  const saved = sync.dropped === null ? null : await savePatch(deps.paths, claim.issue, await commitsPatch(claim.worktree, remoteBranch, sync.dropped), deps.now(), "dropped");
  deps.log({ kind: "worktree-synced", issue: claim.issue, pr: claim.state.pr.number, dropped: sync.dropped, patch: saved });
}

/** One line per check run on the PR head for the review prompt; a lookup failure leaves the summary at "(none)". */
async function ciSummary(deps: DriverDeps, sha: string): Promise<string | undefined> {
  try {
    const s = await deps.gh.checks(sha, deps.cfg.required_checks);
    const lines = s.runs.map((r) => `${r.name}: ${r.status === "completed" ? r.conclusion ?? "unknown" : r.status}`);
    const head = s.status === "green" ? `All required checks passed for ${sha}.` : s.status === "failed" ? `Required checks failed for ${sha}.` : `Checks still pending for ${sha}.`;
    return [head, ...lines].join("\n");
  } catch {
    return undefined;
  }
}

async function runAgentStage(deps: DriverDeps, claim: Claim, stage: AgentStageName): Promise<ChainEvent | null> {
  const state = claim.state;
  // I2: never start a second run while the last one's scope is still alive.
  if (claim.run_id && deps.systemdScope && (await deps.unitActive(stageUnit(claim.run_id)))) {
    deps.log({ kind: "stage-still-running", issue: claim.issue, run_id: claim.run_id });
    return null;
  }
  const def = deps.stages[stage];
  const sensitiveGlobs = readSensitiveGlobs(deps.agentsDir);

  await syncWorktree(deps, claim);
  if (state.pr !== null && !state.conflictPending) {
    const rebase = await rebaseOntoMain(claim.worktree, "origin/main", botIdentity(deps));
    if (!rebase.ok) return { type: "rebase_conflict", detail: rebase.conflict };
  }
  // C1: with a conflict pending the fix stage rebases and resolves it itself (its input says so).

  const { data: issue } = await deps.gh.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: deps.gh.owner, repo: deps.gh.repo, issue_number: claim.issue });
  const specPath = specPathFromIssueBody(String(issue.body ?? ""));
  const specText = specOnMain(deps.repoDir, specPath);
  const diffBefore = await diffFilesAgainstBase(claim.worktree);
  const security = stage === "review" && (state.sensitive || isSensitive(diffBefore, sensitiveGlobs).length > 0);
  const profile = pickProfile(deps, def, state, security);
  const ci = stage === "review" && state.pr ? await ciSummary(deps, state.pr.head_sha) : undefined;
  const input = await buildInput(deps, claim, String(issue.title ?? ""), String(issue.body ?? ""), specText, ci);

  const attempt = state.attempt;
  const exec = async (model?: string, harness?: Harness): Promise<StageOutcome> => {
    const h = harness ?? def.harness;
    // I2: the real run id, persisted before the run, so a restart can find the run's scope unit.
    const runId = newRunId(claim.issue, stage, attempt, deps.now());
    claim.run_id = runId;
    await writeClaim(deps.paths, { ...claim, last_activity_at: deps.now().toISOString() });
    try {
      const out = await runStage(
        {
          paths: deps.paths, adapter: deps.adapterFor(h), systemdScope: deps.systemdScope, systemdRunBin: deps.systemdRunBin, binDir: deps.binDir, now: deps.now,
          gitIdentity: botIdentity(deps),
        },
        { def, input, issue: claim.issue, attempt, worktree: claim.worktree, profile, model, harness, runId },
      );
      // I2: a killed run can leave processes behind in its scope; stop the unit (best-effort).
      if ((out.outcome === "timeout" || out.outcome === "bounds") && deps.systemdScope) await deps.stopUnit(stageUnit(runId)).catch(() => {});
      return out;
    } finally {
      // Persisted, not only in memory: a throw here or later in the step must not leave a run "in flight" on disk (AC-15).
      claim.run_id = null;
      await writeClaim(deps.paths, { ...claim, run_id: null, last_activity_at: deps.now().toISOString() });
    }
  };

  let out = await exec();
  deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId });
  if (out.outcome !== "ok") {
    const retry = retryDecision(def, out.judgement, out.usage.cost_usd ?? 0, deps.cfg.retry_cost_limit_usd);
    if (retry.kind === "postpone") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome, postpone: true };
    if (retry.kind === "fallback") {
      out = await exec(retry.model, retry.harness);
      deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId, fallback: retry.model });
    }
  }
  if (out.outcome !== "ok") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome };

  const result = out.result as never;
  if (stage === "plan") {
    // I4: a domain with no profile fails the plan rather than running under another profile.
    const domain = (out.result as { domain: string }).domain;
    if (!listProfiles(deps.agentsDir).includes(domain)) return { type: "stage_failed", stage: "plan", reason: `profile not available: ${domain}` };
    return { type: "stage_ok", stage: "plan", result };
  }
  if (stage === "review") return { type: "stage_ok", stage: "review", result, security };
  if (stage !== "implement" && stage !== "fix") throw new Error("spec 006 Task 8");
  if (!(await prBound(deps, claim, stage, result))) return { type: "stage_failed", stage, reason: "result: pr mismatch" };
  const diff = await diffFilesAgainstBase(claim.worktree);
  const scope = state.plan ? scopeGate(diff, state.plan, parseSpec(specText), sensitiveGlobs) : { ok: true as const };
  return stage === "implement" ? { type: "stage_ok", stage: "implement", result, scope } : { type: "stage_ok", stage: "fix", result, scope };
}

async function verifyEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`verify without a PR (issue ${claim.issue})`);
  const summary = await deps.gh.checks(pr.head_sha, deps.cfg.required_checks);
  // R1: judge sensitivity on the pushed head (after head_moved the local copy is stale).
  await syncWorktree(deps, claim);
  const sensitive = isSensitive(await diffFilesAgainstBase(claim.worktree), readSensitiveGlobs(deps.agentsDir)).length > 0;
  if (summary.status === "failed") {
    const first = summary.failed[0];
    const log = await deps.gh.jobLogExcerpt(first.id).catch(() => `(no log for ${first.name})`);
    return { type: "checks", status: "failed", log: `${first.name}\n${log}`, sensitive, at: deps.now().toISOString() };
  }
  return { type: "checks", status: summary.status, sensitive, at: deps.now().toISOString() };
}

async function mergeEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`merge without a PR (issue ${claim.issue})`);
  // The issue's labels give the merge record its class; no label refuses the merge (spec 006 AC-9).
  const labels = await deps.gh.issueLabels(claim.issue);
  const info = await deps.gh.pullRequest(pr.number);
  // Already merged (a crash between the merge PUT and writeClaim): record it and finish without merging again.
  if (!info.merged) {
    // C2: merge only the commit that verify and review ran on; a moved head goes back to verify.
    if (info.head_sha !== pr.head_sha) return { type: "head_moved", head_sha: info.head_sha };
    if (info.mergeable === false) return { type: "merge_result", status: "not_mergeable", detail: info.mergeable_state };
    const r = await deps.gh.mergePullRequest(pr.number, pr.head_sha);
    if (!r.merged) return { type: "merge_result", status: "not_mergeable", detail: r.message };
  }
  const cls = classOf({ number: claim.issue, title: "", author: "", body: "", labels, labelEvents: [], createdAt: "" }, deps.cfg.labels);
  await appendMerge(deps.paths, { issue: claim.issue, pr: pr.number, cls, at: deps.now().toISOString() });
  return { type: "merge_result", status: "merged" };
}

export async function applyActions(deps: DriverDeps, claim: Claim, actions: Action[]): Promise<StepStatus> {
  let status: StepStatus = "continue";
  for (const a of actions) {
    switch (a.type) {
      case "label": {
        let target = claim.issue;
        if (a.target === "pr") {
          if (!claim.state.pr) {
            deps.log({ kind: "warn", issue: claim.issue, msg: "pr label action without a PR" });
            break;
          }
          target = claim.state.pr.number;
        }
        await deps.gh.addLabels(target, a.add);
        for (const l of a.remove) await deps.gh.removeLabel(target, l);
        break;
      }
      case "comment":
        await deps.gh.comment(claim.issue, a.text);
        break;
      case "notify":
        await deps.notifier.notify({ issue: claim.issue, gate: a.gate, label: a.label, text: a.text });
        break;
      case "release":
        if (a.savePatch) await savePatch(deps.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""), deps.now(), "release");
        await removeClaim(deps.paths, claim.issue);
        status = "ended";
        break;
      case "done":
        await removeWorktree(deps.repoDir, claim.worktree).catch((e) => deps.log({ kind: "error", issue: claim.issue, error: `worktree remove: ${(e as Error).message}` }));
        await removeClaim(deps.paths, claim.issue);
        status = "ended";
        break;
      case "wait":
        claim.state.postponedUntil = a.seconds >= POSTPONE_WAIT_S ? new Date(deps.now().getTime() + a.seconds * 1000).toISOString() : null;
        status = "waiting";
        break;
      default:
        // close_pr, delete_branch, finding, pause, rerun_checks: applied from spec 006 Task 8.
        break;
    }
  }
  return status;
}

/** Errors propagate to the caller; the service loop (Task 7) catches and logs them per chain. */
export async function step(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }> {
  const stage = claim.state.stage;
  if (ENDED.includes(stage)) return { claim, status: "ended" };
  let event: ChainEvent;
  if (stage === "claimed") event = { type: "start" };
  else if (stage === "waiting") {
    const until = claim.state.postponedUntil;
    if (until && new Date(until) > deps.now()) return { claim, status: "waiting" };
    event = { type: "start" };
  } else if (AGENT_STAGES.includes(stage as AgentStageName)) {
    const ev = await runAgentStage(deps, claim, stage as AgentStageName);
    if (ev === null) return { claim, status: "waiting" };
    event = ev;
  } else if (stage === "verify") event = await verifyEvent(deps, claim);
  else if (stage === "merge") event = await mergeEvent(deps, claim);
  else throw new Error(`unhandled stage ${stage}`);

  const { state, actions } = transition(claim.state, event);
  claim = { ...claim, state, last_activity_at: deps.now().toISOString() };
  const status = await applyActions(deps, claim, actions);
  deps.log({ kind: "transition", issue: claim.issue, event: event.type, stage: state.stage, status });
  if (status !== "ended") await writeClaim(deps.paths, claim);
  return { claim, status };
}

export async function driveChain(deps: DriverDeps, claim: Claim, isStopping: () => boolean): Promise<Claim> {
  let current = claim;
  while (!isStopping()) {
    const r = await step(deps, current);
    current = r.claim;
    if (r.status !== "continue") break;
  }
  return current;
}
