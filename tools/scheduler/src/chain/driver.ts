import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { adapterFor as defaultAdapterFor } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { isSensitive, scopeGate } from "../gates/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { Notifier } from "../notify/types.ts";
import { readSensitiveGlobs, resolveProfile } from "../profiles/resolve.ts";
import { retryDecision } from "../runner/retry.ts";
import { runStage, type StageOutcome } from "../runner/run.ts";
import { diffFilesAgainstBase, discardUncommitted, rebaseOntoMain, removeWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { StageInput } from "../stages/prompt.ts";
import { removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { appendMerge } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import type { StatePaths } from "../state/paths.ts";
import { classOf } from "../shortlist/rank.ts";
import type { AgentStageName, FixResult, Harness, ImplementResult, Profile, StageDefinition } from "../types.ts";
import { POSTPONE_WAIT_S, SECURITY_REVIEW_LABEL, transition } from "./machine.ts";
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
  now: () => Date;
  log: (rec: Record<string, unknown>) => void;
  fetchOrigin: () => Promise<void>;
}

export type StepStatus = "continue" | "waiting" | "ended";
const AGENT_STAGES: AgentStageName[] = ["plan", "implement", "review", "fix"];
const ENDED: ChainState["stage"][] = ["done", "released", "needs-human"];

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
    spec: specText, plan: s.plan ?? undefined, pr, ci, fix_input: s.pendingFixInput ?? undefined,
    result_path: "", profile_instructions: "",
  };
}

function pickProfile(deps: DriverDeps, def: StageDefinition, state: ChainState, security: boolean): Profile | null {
  if (security && def.name === "review") return resolveProfile(deps.agentsDir, "security");
  if (def.profile === "none") return null;
  const name = def.profile === "from-issue" ? state.plan?.domain ?? "backend" : def.profile;
  try {
    return resolveProfile(deps.agentsDir, name);
  } catch {
    return resolveProfile(deps.agentsDir, "backend");
  }
}

/** AC-10/AC-11: the result must name the commit the worktree is on, and the PR must point at that same commit. */
async function prBound(deps: DriverDeps, claim: Claim, stage: "implement" | "fix", result: ImplementResult | FixResult): Promise<boolean> {
  const head = await worktreeHead(claim.worktree);
  if (result.head_sha !== head) return false;
  const prNumber = stage === "implement" ? (result as ImplementResult).pr_number : claim.state.pr?.number;
  if (prNumber === undefined) return false;
  const pr = await deps.gh.pullRequest(prNumber);
  return pr.head_sha === result.head_sha;
}

async function runAgentStage(deps: DriverDeps, claim: Claim, stage: AgentStageName): Promise<ChainEvent> {
  const state = claim.state;
  const def = deps.stages[stage];
  const sensitiveGlobs = readSensitiveGlobs(deps.agentsDir);

  await deps.fetchOrigin();
  // A dirty tree makes the rebase throw: keep the leftovers as a patch, then start from HEAD.
  const patch = await uncommittedPatch(claim.worktree);
  if (patch.trim()) {
    const saved = await savePatch(deps.paths, claim.issue, patch, deps.now());
    await discardUncommitted(claim.worktree);
    deps.log({ kind: "recovered-uncommitted", issue: claim.issue, patch: saved });
  }
  const rebase = await rebaseOntoMain(claim.worktree);
  if (!rebase.ok) return { type: "rebase_conflict", detail: rebase.conflict };

  const { data: issue } = await deps.gh.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: deps.gh.owner, repo: deps.gh.repo, issue_number: claim.issue });
  const specPath = specPathFromIssueBody(String(issue.body ?? ""));
  const specText = specOnMain(deps.repoDir, specPath);
  const diffBefore = await diffFilesAgainstBase(claim.worktree);
  const security = stage === "review" && (state.sensitive || isSensitive(diffBefore, sensitiveGlobs).length > 0);
  const profile = pickProfile(deps, def, state, security);
  const input = await buildInput(deps, claim, String(issue.title ?? ""), String(issue.body ?? ""), specText, undefined);

  const attempt = state.attempt;
  const exec = async (model?: string, harness?: Harness): Promise<StageOutcome> => {
    const h = harness ?? def.harness;
    claim.run_id = `${claim.issue}-${stage}-${attempt}`;
    await writeClaim(deps.paths, { ...claim, last_activity_at: deps.now().toISOString() });
    try {
      return await runStage(
        {
          paths: deps.paths, adapter: deps.adapterFor(h), systemdScope: deps.systemdScope, binDir: deps.binDir, now: deps.now,
          gitIdentity: { name: deps.cfg.app.bot_login, email: `${deps.cfg.app.bot_login}@users.noreply.github.com` },
        },
        { def, input, issue: claim.issue, attempt, worktree: claim.worktree, profile, model, harness },
      );
    } finally {
      claim.run_id = null;
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
  if (stage === "plan") return { type: "stage_ok", stage: "plan", result };
  if (stage === "review") return { type: "stage_ok", stage: "review", result, security };
  if (!(await prBound(deps, claim, stage, result))) return { type: "stage_failed", stage, reason: "result: pr mismatch" };
  const diff = await diffFilesAgainstBase(claim.worktree);
  const scope = state.plan ? scopeGate(diff, state.plan, parseSpec(specText), sensitiveGlobs) : { ok: true as const };
  return stage === "implement" ? { type: "stage_ok", stage: "implement", result, scope } : { type: "stage_ok", stage: "fix", result, scope };
}

async function verifyEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`verify without a PR (issue ${claim.issue})`);
  const summary = await deps.gh.checks(pr.head_sha, deps.cfg.required_checks);
  const sensitive = isSensitive(await diffFilesAgainstBase(claim.worktree), readSensitiveGlobs(deps.agentsDir)).length > 0;
  if (summary.status === "failed") {
    const first = summary.failed[0];
    const log = await deps.gh.jobLogExcerpt(first.id).catch(() => `(no log for ${first.name})`);
    return { type: "checks", status: "failed", log: `${first.name}\n${log}`, sensitive };
  }
  return { type: "checks", status: summary.status, sensitive };
}

async function mergeEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`merge without a PR (issue ${claim.issue})`);
  // AC-11: a security-review label on the issue or on the PR (PR labels are issue labels on its number) refuses the merge.
  const labels = await deps.gh.issueLabels(claim.issue);
  const prLabels = await deps.gh.issueLabels(pr.number);
  if (labels.includes(SECURITY_REVIEW_LABEL) || prLabels.includes(SECURITY_REVIEW_LABEL)) return { type: "merge_blocked", reason: "security-review label present" };
  const info = await deps.gh.pullRequest(pr.number);
  if (info.mergeable === false) return { type: "merge_result", status: "not_mergeable", detail: info.mergeable_state };
  const r = await deps.gh.mergePullRequest(pr.number, info.head_sha);
  if (!r.merged) return { type: "merge_result", status: "not_mergeable", detail: r.message };
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
        if (a.savePatch) await savePatch(deps.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""), deps.now());
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
        break;
    }
  }
  return status;
}

export async function step(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }> {
  const stage = claim.state.stage;
  if (ENDED.includes(stage)) return { claim, status: "ended" };
  let event: ChainEvent;
  if (stage === "claimed") event = { type: "start" };
  else if (stage === "waiting") {
    const until = claim.state.postponedUntil;
    if (until && new Date(until) > deps.now()) return { claim, status: "waiting" };
    event = { type: "start" };
  } else if (AGENT_STAGES.includes(stage as AgentStageName)) event = await runAgentStage(deps, claim, stage as AgentStageName);
  else if (stage === "verify") event = await verifyEvent(deps, claim);
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
