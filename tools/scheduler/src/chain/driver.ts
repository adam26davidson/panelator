import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { adapterFor as defaultAdapterFor } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import type { Config } from "../config.ts";
import { ROOT } from "../gates/design-tree.ts";
import { isSensitive, scopeGate, specPresentGate, specScopeGate, uiDesignGate, type ScopeResult } from "../gates/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { PullRequestInfo } from "../github/types.ts";
import type { Notifier } from "../notify/types.ts";
import { listProfiles, readSensitiveGlobs, resolveProfile } from "../profiles/resolve.ts";
import { afterFallback, harnessForModel, retryDecision } from "../runner/retry.ts";
import { runStage, type StageOutcome } from "../runner/run.ts";
import {
  checkoutBranch, commitsPatch, deleteLocalBranch, diffFilesAgainstBase, discardUncommitted, rebaseOntoMain, removeWorktree, syncToRemote, uncommittedPatch,
} from "../runner/worktree.ts";
import { buildSelectContext } from "../shortlist/fetch.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { StageInput } from "../stages/prompt.ts";
import { removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { appendFindings } from "../state/findings.ts";
import { archiveLedger, writeLedger } from "../state/ledger.ts";
import { appendMerge } from "../state/merges.ts";
import { writePaused, type PausedRecord } from "../state/paused.ts";
import { savePatch } from "../state/patches.ts";
import type { StatePaths } from "../state/paths.ts";
import { answeredEntry, answeredForIssue, appendQuestionLog } from "../state/questions.ts";
import { newRunId, runDir } from "../state/runs.ts";
import { classOf } from "../shortlist/rank.ts";
import type {
  AgentStageName, FixOutcome, Harness, ImplementOutcome, ImplementResult, IssueData, PlanOutcome, Profile, SpecResult, StageDefinition,
} from "../types.ts";
import { CLAIM_LABEL, NEEDS_DECISION_LABEL, POSTPONE_WAIT_S, branchOf, ledgerOf, transition } from "./machine.ts";
import { formatQuestion, questionBody, questionMarker } from "./question.ts";
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
const AGENT_STAGES: AgentStageName[] = ["plan", "implement", "review", "fix", "spec", "question-check"];
const ENDED: ChainState["stage"][] = ["done", "released", "abandoned", "paused"];
/** C1: prepended to the fix input when the fix stage has to resolve a rebase conflict itself. */
export const CONFLICT_FIX_LINE = "Rebase this branch onto origin/main and resolve the conflicts before addressing the items below.";
/** AC-10: prepended to a fix input that names the charter (a security finding or a scope violation). */
export const CHARTER_REVERT_LINE = `Revert every change this PR makes to ${ROOT}: the charter is never changed by a pull request. Restore the file exactly as it is on origin/main.`;
/** AC-21: a spec PR body must not close any issue, by number, by owner/repo#N or by URL (D8). */
export const CLOSING_KEYWORD = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+(#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)/i;
const DECISIONS = "docs/decisions/";
const CITED = /question #(\d+)/g;
const MARKED = /\(maintainer answer, question #(\d+)\)/g;
const answerMark = (id: number) => `(maintainer answer, question #${id})`;
/** Run-record paths listed in an abandonment comment, newest last. */
const ABANDON_RUNS_MAX = 200;
const stageUnit = (runId: string) => `panelator-stage-${runId}`;

export { defaultAdapterFor };

function gitShow(repoDir: string, ref: string): string | null {
  try {
    return execFileSync("git", ["show", ref], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function specOnMain(repoDir: string, path: string | null): string {
  return path ? gitShow(repoDir, `origin/main:${path}`) ?? "" : "";
}

async function gitOut(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function worktreeHead(worktree: string): Promise<string> {
  return (await gitOut(worktree, "rev-parse", "HEAD")).trim();
}

async function refExists(worktree: string, ref: string): Promise<boolean> {
  try {
    await gitOut(worktree, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(worktree: string, a: string, b: string): Promise<boolean> {
  try {
    await gitOut(worktree, "merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether every change `branch` makes since it left main is already on origin/main: true after a squash merge, which
 * leaves the branch's commits off main's history while its content is there.
 */
async function changesOnMain(worktree: string, branch: string): Promise<boolean> {
  const files = (await gitOut(worktree, "diff", "--name-only", "-z", `origin/main...${branch}`)).split("\0").filter(Boolean);
  if (!files.length) return true;
  try {
    await gitOut(worktree, "diff", "--quiet", "origin/main", branch, "--", ...files);
    return true;
  } catch {
    return false;
  }
}

/** Saves the worktree's uncommitted changes and its commits not on origin/main, each skipped when empty. */
async function saveWorktreeWork(deps: DriverDeps, claim: Claim, kind: string): Promise<void> {
  const leftovers = await uncommittedPatch(claim.worktree).catch(() => "");
  const commits = await commitsPatch(claim.worktree, "origin/main").catch(() => "");
  const u = await savePatch(deps.paths, claim.issue, leftovers, deps.now(), `${kind}-uncommitted`);
  const c = await savePatch(deps.paths, claim.issue, commits, deps.now(), `${kind}-commits`);
  if (u || c) deps.log({ kind: "worktree-saved", issue: claim.issue, uncommitted: u, commits: c });
}

/** The lines the PR adds (`origin/main...HEAD`), per file. */
async function addedLinesByFile(worktree: string): Promise<Map<string, string[]>> {
  const out = await gitOut(worktree, "-c", "core.quotePath=false", "diff", "--unified=0", "--no-color", "origin/main...HEAD");
  const files = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = path === "/dev/null" ? null : [];
      if (current) files.set(path.replace(/^b\//, ""), current);
    } else if (line.startsWith("+") && current) current.push(line.slice(1));
  }
  return files;
}

async function addedLines(worktree: string): Promise<string[]> {
  return [...(await addedLinesByFile(worktree)).values()].flat();
}

const ids = (lines: string[], re: RegExp): number[] => [...new Set(lines.flatMap((l) => [...l.matchAll(re)].map((m) => Number(m[1]))))].sort((a, b) => a - b);
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

/** AC-10, C7: every id the diff cites, verified only by an `answered` entry in the questions log for this issue. */
async function answeredQuestions(deps: DriverDeps, issue: number, worktree: string): Promise<string> {
  const cited = ids(await addedLines(worktree), CITED);
  if (!cited.length) return "(none)";
  const lines: string[] = [];
  for (const id of cited) {
    const e = await answeredEntry(deps.paths, id);
    const verified = e !== null && e.issue === issue;
    lines.push(verified && e
      ? `#${id}: verified. Question: ${(e.question?.question ?? "(not logged)").split("\n")[0]}. Answer: ${oneLine(e.answer ?? "")}`
      : `#${id}: NOT verified; treat as no citation`);
  }
  return lines.join("\n");
}

/** Task 6 ruling: an ADR an earlier fix recorded stays in scope on the issue PR when its added lines carry a verified mark. */
async function verifiedDecisionFiles(deps: DriverDeps, issue: number, worktree: string): Promise<string[]> {
  const out: string[] = [];
  for (const [file, lines] of await addedLinesByFile(worktree)) {
    if (!file.startsWith(DECISIONS)) continue;
    for (const id of ids(lines, MARKED)) {
      if ((await answeredEntry(deps.paths, id))?.issue === issue) {
        out.push(file);
        break;
      }
    }
  }
  return out;
}

/** A capability answer is not a decision and is not recorded (AC-18): only a product or technical answer needs its mark. */
const answerToRecord = (s: ChainState): boolean => s.answerQuestionIds.length > 0 && (s.answerKind === "product" || s.answerKind === "technical");

/** T3: the mark of any answered question of the chain counts. */
async function carriesMark(worktree: string, questionIds: number[]): Promise<boolean> {
  return (await addedLines(worktree)).some((l) => questionIds.some((id) => l.includes(answerMark(id))));
}

/** Files under docs/decisions/ the PR adds (`origin/main...HEAD`). */
async function addedDecisionFiles(worktree: string): Promise<string[]> {
  return (await gitOut(worktree, "-c", "core.quotePath=false", "diff", "--diff-filter=A", "--name-only", "origin/main...HEAD")).split("\n").filter((f) => f.startsWith(DECISIONS));
}

/** AC-18: a fix recording a technical answer adds a file under docs/decisions/ that carries the mark of an answered id of the chain. */
async function recordsAnswer(worktree: string, questionIds: number[]): Promise<boolean> {
  for (const f of await addedDecisionFiles(worktree)) {
    const text = await readFile(join(worktree, f), "utf8").catch(() => "");
    if (questionIds.some((id) => text.includes(answerMark(id)))) return true;
  }
  return false;
}

/** C8: the issue's answered questions, for the question check: one already answered may settle the new one. */
async function issueAnswers(deps: DriverDeps, issue: number): Promise<string> {
  const entries = await answeredForIssue(deps.paths, issue);
  if (!entries.length) return "(none)";
  return entries.map((e) => `#${e.question_comment_id}: Question: ${oneLine(e.question?.question ?? "(not logged)")} Answer: ${oneLine(e.answer ?? "")}`).join("\n");
}

/** AC-21, AC-22: the spec PR's scope, judged with the spec's Parent: from the worktree and the parent before (origin/main) and after. */
async function specTrackScope(deps: DriverDeps, claim: Claim, diff: string[], specPath: string | null): Promise<ScopeResult> {
  if (!specPath) return { ok: false, violations: ["the issue body has no Spec: line naming the spec this PR changes"] };
  const text = await readFile(join(claim.worktree, specPath), "utf8").catch(() => "");
  const parent = parseSpec(text).parent;
  const before = parent ? gitShow(deps.repoDir, `origin/main:${parent}`) ?? "" : "";
  const after = parent ? await readFile(join(claim.worktree, parent), "utf8").catch(() => "") : "";
  return specScopeGate(diff, specPath, parent, before, after, claim.state.answerKind === "product");
}

async function buildInput(
  deps: DriverDeps, claim: Claim, issueTitle: string, issueBody: string, specText: string, ci: string | undefined, answered: string | undefined,
): Promise<StageInput> {
  const s = claim.state;
  const pr = s.pr ? { number: s.pr.number, head_sha: s.pr.head_sha, url: `https://github.com/${deps.cfg.repo}/pull/${s.pr.number}` } : undefined;
  let fixInput = s.pendingFixInput === null ? undefined : s.conflictPending ? `${CONFLICT_FIX_LINE}\n${s.pendingFixInput}` : s.pendingFixInput;
  if (fixInput?.includes(ROOT)) fixInput = `${CHARTER_REVERT_LINE}\n${fixInput}`;
  // The question a resumed stage answers: on the state while it is asked, from the log's answered entry once it is answered (AC-15).
  let question = s.question;
  if (!question && s.answer !== null && s.answerQuestionId !== null) question = (await answeredEntry(deps.paths, s.answerQuestionId))?.question ?? null;
  return {
    issue: { number: claim.issue, title: issueTitle, body: issueBody },
    spec: specText, plan: s.plan ?? undefined, pr, ci,
    fix_input: fixInput,
    history: s.history.length ? s.history.join("\n\n") : undefined,
    question: question ? questionBody(question, deps.cfg.maintainer) : undefined,
    // Each reply already carries its "Question #<id>: " prefix (T3).
    answer: s.answer ?? undefined,
    mode: s.specMode ?? undefined,
    decide_input: s.decideInput ?? undefined,
    spec_problem: s.specProblem ?? undefined,
    answered_questions: answered,
    result_path: "", profile_instructions: "",
  };
}

function pickProfile(deps: DriverDeps, def: StageDefinition, state: ChainState, security: boolean): Profile | null {
  if (def.name === "question-check") return null;
  // AC-4, AC-21: the security profile wins over spec on a spec PR.
  if (def.name === "review" && security) return resolveProfile(deps.agentsDir, "security");
  // D9: everything on the spec PR (its review, fix and implement) works under the spec profile.
  if (state.track === "spec" && (def.name === "review" || def.name === "fix" || def.name === "implement")) return resolveProfile(deps.agentsDir, "spec");
  if (def.profile === "none") return null;
  // I4: an unknown profile throws; the plan stage already refused a domain with no profile.
  return resolveProfile(deps.agentsDir, def.profile === "from-issue" ? state.plan?.domain ?? "backend" : def.profile);
}

/**
 * AC-10/AC-11: the result must name the commit the worktree is on, and the PR must be open, from `bound.branch` into
 * main, at that same commit (I1). Returns the PR when it is bound, else null.
 */
async function prBound(deps: DriverDeps, claim: Claim, bound: { prNumber: number; branch: string }, headSha: string): Promise<PullRequestInfo | null> {
  if (headSha !== (await worktreeHead(claim.worktree))) return null;
  const pr = await deps.gh.pullRequest(bound.prNumber);
  // An open PR only: after a crash between a re-plan's close_pr and the claim write, a fix must not bind to the closed PR.
  return pr.state === "open" && pr.head_sha === headSha && pr.base_ref === "main" && pr.head_ref === bound.branch ? pr : null;
}

/** The bot identity every commit the scheduler makes or rewrites carries (stage commits and rebases alike). */
function botIdentity(deps: DriverDeps): { name: string; email: string } {
  return { name: deps.cfg.app.bot_login, email: `${deps.cfg.app.bot_login}@users.noreply.github.com` };
}

/**
 * T2: with no PR bound, the chain's branch must not exist on origin: a failed attempt (an implement or spec run that
 * pushed but failed before reporting its PR, a retry, a re-plan, a re-claim after a release) may have left it there,
 * with an open PR, and the next push or `gh pr create` would collide with it. Its commits are saved as a patch, any
 * open PR from it is closed with a comment, and the branch is deleted on GitHub.
 */
async function dropStaleRemoteBranch(deps: DriverDeps, claim: Claim, branch: string): Promise<void> {
  const ref = `refs/heads/${branch}`;
  const listed = (await gitOut(claim.worktree, "ls-remote", "--heads", "origin", ref)).trim();
  if (!listed) return;
  const tracking = `refs/remotes/origin/${branch}`;
  await gitOut(claim.worktree, "fetch", "-q", "origin", `+${ref}:${tracking}`);
  const commits = await commitsPatch(claim.worktree, "origin/main", tracking).catch(() => "");
  const saved = await savePatch(deps.paths, claim.issue, commits, deps.now(), "stale-branch");
  const prs = await deps.gh.openPullRequestsFrom(branch).catch((e) => {
    // Deleting the head branch closes its PRs on GitHub anyway; only the comment is lost.
    deps.log({ kind: "warn", issue: claim.issue, msg: `open PRs from ${branch}: ${(e as Error).message}` });
    return [] as number[];
  });
  for (const pr of prs) {
    await deps.gh.comment(pr, `Closed by the scheduler: this PR is from a failed attempt at issue #${claim.issue}, which starts again from origin/main. Its commits are saved as a patch.`);
    await deps.gh.closePullRequest(pr);
  }
  await deps.gh.deleteBranch(branch);
  await gitOut(claim.worktree, "update-ref", "-d", tracking).catch(() => "");
  deps.log({ kind: "stale-branch-dropped", issue: claim.issue, branch, prs, patch: saved });
}

/**
 * Fetch, keep any leftovers as a patch, then put the worktree where the next step must see it: with no PR, the
 * chain's branch (`issue-<n>` or `spec-<n>`) fresh from origin/main (C1, AC-21); with a PR, that PR's branch at its
 * remote head (R1), so the diffs the gates judge (sensitivity, scope) are of the commit GitHub holds. Commits the
 * reset or sync discards are saved as a patch first (spec 005), like the uncommitted leftovers.
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
  const branch = branchOf(claim.state);
  if (claim.state.pr === null) {
    const commits = await commitsPatch(claim.worktree, "origin/main");
    if (commits.trim()) {
      const saved = await savePatch(deps.paths, claim.issue, commits, deps.now(), "commits");
      deps.log({ kind: "recovered-commits", issue: claim.issue, patch: saved, base: "origin/main" });
    }
    await dropStaleRemoteBranch(deps, claim, branch);
    await checkoutBranch(claim.worktree, branch, "origin/main");
    return;
  }
  const remoteBranch = `origin/${branch}`;
  const current = (await gitOut(claim.worktree, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  if (current !== branch) {
    if (!(await refExists(claim.worktree, remoteBranch))) throw new Error(`PR #${claim.state.pr.number}: ${remoteBranch} not found after fetch`);
    await checkoutBranch(claim.worktree, branch, remoteBranch);
    deps.log({ kind: "worktree-branch", issue: claim.issue, from: current, to: branch });
  }
  const sync = await syncToRemote(claim.worktree, remoteBranch);
  if (!sync.moved) return;
  // The dropped head is still in the object store after the reset; a head already on main carries no work of its own.
  const own = sync.dropped !== null && !(await isAncestor(claim.worktree, sync.dropped, "origin/main"));
  const saved = own ? await savePatch(deps.paths, claim.issue, await commitsPatch(claim.worktree, remoteBranch, sync.dropped!), deps.now(), "dropped") : null;
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

async function fetchIssue(deps: DriverDeps, issue: number): Promise<{ title: string; body: string }> {
  const { data } = await deps.gh.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { owner: deps.gh.owner, repo: deps.gh.repo, issue_number: issue });
  return { title: String(data.title ?? ""), body: String(data.body ?? "") };
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
  // The spec stage and the question check work from origin/main and are never rebased (spec section 4).
  if (stage !== "spec" && stage !== "question-check" && state.pr !== null && !state.conflictPending) {
    const rebase = await rebaseOntoMain(claim.worktree, "origin/main", botIdentity(deps));
    if (!rebase.ok) return { type: "rebase_conflict", detail: rebase.conflict };
  }
  // C1: with a conflict pending the fix stage rebases and resolves it itself (its input says so).

  const issue = await fetchIssue(deps, claim.issue);
  const specPath = specPathFromIssueBody(issue.body);
  const specText = specOnMain(deps.repoDir, specPath);
  const diffBefore = await diffFilesAgainstBase(claim.worktree);
  // C5: a sensitive diff gets the normal review first, then the security review (the state's security pass).
  const sensitive = stage === "review" && (state.sensitive || isSensitive(diffBefore, sensitiveGlobs).length > 0);
  const security = sensitive && state.securityPass;
  const profile = pickProfile(deps, def, state, security);
  const ci = stage === "review" && state.pr ? await ciSummary(deps, state.pr.head_sha) : undefined;
  // AC-10: review gets the diff's cited answers; C8: the question check gets the issue's answered questions.
  const answered = stage === "review" ? await answeredQuestions(deps, claim.issue, claim.worktree) : stage === "question-check" ? await issueAnswers(deps, claim.issue) : undefined;
  const input = await buildInput(deps, claim, issue.title, issue.body, specText, ci, answered);

  const attempt = state.attempt;
  const exec = async (model?: string, harness?: Harness, tag?: string): Promise<StageOutcome> => {
    const h = harness ?? def.harness;
    // I2: the real run id, persisted before the run, so a restart can find the run's scope unit. A rescue or a
    // fallback, or a run in the same second as an earlier one, gets its own id so no run record is overwritten.
    const base = newRunId(claim.issue, stage, attempt, deps.now()) + (tag ? `-${tag}` : "");
    let runId = base;
    for (let n = 2; existsSync(runDir(deps.paths, runId)); n++) runId = `${base}-${n}`;
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

  // AC-1: a rescue runs on the rescue model; the state is the only source of that.
  let out = state.rescueRun ? await exec(deps.cfg.rescue_model, harnessForModel(deps.cfg.rescue_model), "rescue") : await exec();
  deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId, rescue: state.rescueRun || undefined });
  if (out.outcome !== "ok") {
    // A rescue is never downgraded: like any strong-tier stage it is postponed on a rate limit (AC-27).
    const retryDef: StageDefinition = state.rescueRun ? { ...def, tier: "strong", independent: false, fallback: undefined } : def;
    const retry = retryDecision(retryDef, out.judgement, out.usage.cost_usd ?? 0, deps.cfg.retry_cost_limit_usd);
    if (retry.kind === "postpone") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome, postpone: true };
    if (retry.kind === "fallback") {
      out = await exec(retry.model, retry.harness, "fallback");
      deps.log({ kind: "stage", issue: claim.issue, stage, attempt, outcome: out.outcome, reason: out.reason, run_id: out.runId, fallback: retry.model });
      // Only afterFallback judges the fallback run (AC-26).
      if (out.outcome !== "ok" && afterFallback(def, out.judgement).kind === "postpone") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome, postpone: true };
    }
  }
  if (out.outcome !== "ok") return { type: "stage_failed", stage, reason: out.reason ?? out.outcome };

  switch (stage) {
    case "plan": {
      const result = out.result as PlanOutcome;
      // AC-17, review focus 9: a plan that escalates skips the domain-profile check.
      if (!("escalation" in result && result.escalation)) {
        // I4: a domain with no profile fails the plan rather than running under another profile.
        const domain = (result as { domain: string }).domain;
        if (!listProfiles(deps.agentsDir).includes(domain)) return { type: "stage_failed", stage: "plan", reason: `profile not available: ${domain}` };
      }
      return { type: "stage_ok", stage: "plan", result };
    }
    case "review":
      return { type: "stage_ok", stage: "review", result: out.result as never, security, sensitive };
    case "question-check":
      return { type: "stage_ok", stage: "question-check", result: out.result as never };
    case "spec":
      return specEvent(deps, claim, issue.body, out.result as SpecResult);
    case "implement":
    case "fix":
      return codeEvent(deps, claim, stage, out.result as ImplementOutcome | FixOutcome, issue.body, specText, sensitiveGlobs);
  }
}

async function codeEvent(
  deps: DriverDeps, claim: Claim, stage: "implement" | "fix", result: ImplementOutcome | FixOutcome, issueBody: string, specText: string, sensitiveGlobs: string[],
): Promise<ChainEvent> {
  const state = claim.state;
  // AC-17: a result that escalates has no PR or scope to check.
  if ("escalation" in result && result.escalation) {
    return stage === "implement" ? { type: "stage_ok", stage, result: result as ImplementOutcome } : { type: "stage_ok", stage, result: result as FixOutcome };
  }
  const r = result as ImplementResult | { head_sha: string };
  const prNumber = stage === "implement" ? (r as ImplementResult).pr_number : state.pr?.number;
  if (prNumber === undefined || !(await prBound(deps, claim, { prNumber, branch: branchOf(state) }, r.head_sha))) {
    return { type: "stage_failed", stage, reason: "result: pr mismatch" };
  }
  if (stage === "fix" && state.recordAnswer && !(await recordsAnswer(claim.worktree, state.answerQuestionIds))) {
    return { type: "stage_failed", stage, reason: "result: answer not recorded under docs/decisions/" };
  }
  // AC-18: a fix on a spec PR records a product or technical answer in that PR, carrying the mark.
  if (stage === "fix" && state.track === "spec" && answerToRecord(state) && !(await carriesMark(claim.worktree, state.answerQuestionIds))) {
    return { type: "stage_failed", stage, reason: "result: answer not marked" };
  }
  const diff = await diffFilesAgainstBase(claim.worktree);
  let scope: ScopeResult = { ok: true };
  if (state.track === "spec") scope = await specTrackScope(deps, claim, diff, specPathFromIssueBody(issueBody));
  else if (state.plan) {
    // C6: an ADR the PR adds is in scope (design section 3 item 2: an agent records its own large decision); an edit to an
    // existing ADR is in scope only for a recording fix or with a verified mark.
    const newAdrs = (await addedDecisionFiles(claim.worktree)).filter((f) => f.endsWith(".md"));
    const extra = [...(stage === "fix" && state.recordAnswer ? [DECISIONS] : []), ...newAdrs, ...(await verifiedDecisionFiles(deps, claim.issue, claim.worktree))];
    scope = scopeGate(diff, state.plan, parseSpec(specText), sensitiveGlobs, extra);
  }
  return stage === "implement" ? { type: "stage_ok", stage, result: result as ImplementOutcome, scope } : { type: "stage_ok", stage, result: result as FixOutcome, scope };
}

/** AC-18, AC-21, AC-22: the checks on a spec stage result, in order, then the spec PR's scope. */
async function specEvent(deps: DriverDeps, claim: Claim, issueBody: string, r: SpecResult): Promise<ChainEvent> {
  const state = claim.state;
  const failed = (reason: string): ChainEvent => ({ type: "stage_failed", stage: "spec", reason });
  if (r.verdict === "question") return { type: "stage_ok", stage: "spec", result: r };
  // D5: the spec-result schema already refused a spec_path outside specs/ (the run failed as "result: invalid").
  const specPath = r.spec_path!;
  const issueSpec = specPathFromIssueBody(issueBody);
  if (issueSpec !== null && issueSpec !== specPath) return failed("result: spec_path differs from the issue's Spec: line");
  const pr = r.pr_number === undefined || r.head_sha === undefined ? null : await prBound(deps, claim, { prNumber: r.pr_number, branch: `spec-${claim.issue}` }, r.head_sha);
  if (!pr) return failed("result: pr mismatch");
  if (CLOSING_KEYWORD.test(pr.body)) return failed("result: spec PR body closes an issue");
  if (answerToRecord(state) && !(await carriesMark(claim.worktree, state.answerQuestionIds))) return failed("result: answer not marked");
  const scope = await specTrackScope(deps, claim, await diffFilesAgainstBase(claim.worktree), specPath);
  if (issueSpec === null) await deps.gh.setIssueBody(claim.issue, `${issueBody}\n\nSpec: ${specPath}`);
  return { type: "stage_ok", stage: "spec", result: r, scope };
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
  if (summary.status === "pending") {
    const required = deps.cfg.required_checks;
    const pending = required.length
      ? required.filter((n) => summary.runs.find((r) => r.name === n)?.status !== "completed")
      : summary.runs.filter((r) => r.status !== "completed").map((r) => r.name);
    return { type: "checks", status: "pending", sensitive, at: deps.now().toISOString(), pending };
  }
  return { type: "checks", status: summary.status, sensitive, at: deps.now().toISOString() };
}

/** AC-4: after a spec PR merges, spec-present (with the parent checks) and the UI-design gate run again on origin/main. */
async function specGateOnMain(deps: DriverDeps, claim: Claim): Promise<NonNullable<Extract<ChainEvent, { type: "merge_result" }>["specGate"]>> {
  await deps.fetchOrigin();
  const { title, body } = await fetchIssue(deps, claim.issue);
  const issue: IssueData = { number: claim.issue, title, author: "", body, labels: [], labelEvents: [], createdAt: "" };
  const ctx = buildSelectContext(deps.repoDir, deps.cfg, new Set(), deps.cfg.app.bot_login);
  const path = specPathFromIssueBody(body);
  const text = path ? ctx.readSpec(path) : null;
  const present = specPresentGate(issue, text, ctx.readSpec);
  if (!present.ok) return { ok: false, gate: "spec-present", reason: present.reason };
  const ui = uiDesignGate(parseSpec(text ?? ""), ctx.listDesign(path ?? ""));
  if (!ui.ok) return { ok: false, gate: "ui-design", reason: ui.reason };
  return { ok: true };
}

async function mergeEvent(deps: DriverDeps, claim: Claim): Promise<ChainEvent> {
  const pr = claim.state.pr;
  if (!pr) throw new Error(`merge without a PR (issue ${claim.issue})`);
  const info = await deps.gh.pullRequest(pr.number);
  // Already merged (a crash between the merge PUT and writeClaim): record it and finish without merging again.
  if (!info.merged) {
    // C2: merge only the commit that verify and review ran on; a moved head goes back to verify.
    if (info.head_sha !== pr.head_sha) return { type: "head_moved", head_sha: info.head_sha };
    if (info.mergeable === false) return { type: "merge_result", status: "not_mergeable", detail: info.mergeable_state };
    const r = await deps.gh.mergePullRequest(pr.number, pr.head_sha);
    if (!r.merged) return { type: "merge_result", status: "not_mergeable", detail: r.message };
  }
  // AC-4: a spec PR is not a feature or debt merge; the chain goes on after the gates on main.
  if (claim.state.track === "spec") return { type: "merge_result", status: "merged", specGate: await specGateOnMain(deps, claim) };
  // The issue's labels give the merge record its class; no label refuses the merge (spec 006 AC-9).
  const labels = await deps.gh.issueLabels(claim.issue);
  const cls = classOf({ number: claim.issue, title: "", author: "", body: "", labels, labelEvents: [], createdAt: "" }, deps.cfg.labels);
  await appendMerge(deps.paths, { issue: claim.issue, pr: pr.number, cls, at: deps.now().toISOString() });
  return { type: "merge_result", status: "merged" };
}

/** AC-5: the run records an abandonment comment links, as paths in the scheduler state directory. */
async function runRecordList(deps: DriverDeps, issue: number): Promise<string> {
  const names = (await readdir(deps.paths.runs).catch(() => [] as string[])).filter((n) => n.startsWith(`${issue}-`)).sort();
  const kept = names.slice(-ABANDON_RUNS_MAX);
  const lines = kept.map((n) => `- \`runs/${n}\``);
  if (!lines.length) return "Run records: none.";
  const omitted = names.length - kept.length;
  return ["Run records, in the scheduler state directory:", ...(omitted ? [`(${omitted} earlier run records omitted)`] : []), ...lines].join("\n");
}

/** AC-13: the pause, in the spec's order; D6: `sent` is logged before the record says `paused`. */
async function pauseIssue(deps: DriverDeps, claim: Claim, a: Extract<Action, { type: "pause" }>): Promise<void> {
  const rec: PausedRecord = {
    issue: claim.issue, phase: "pausing", nonce: randomUUID(), state: claim.state, question: a.question, asking_stage: a.asking,
    question_comment_id: null, asked_at: null, reminded: false, answer: null, reply_comment_id: null,
  };
  await writePaused(deps.paths, rec);
  await completePause(deps, rec);
}

/**
 * AC-13 from the question comment on, for a record in phase `pausing`: the driver's pause, and the service loop's
 * completion of one a crash interrupted. With `adoptBy`, a comment by that login carrying the record's nonce is adopted
 * instead of posting a second question; a question comment with another nonce never is.
 */
export async function completePause(deps: DriverDeps, rec: PausedRecord, adoptBy?: string): Promise<void> {
  let asked = rec;
  let questionId = rec.question_comment_id;
  if (questionId === null) {
    const marker = questionMarker(rec.nonce);
    const ours = adoptBy === undefined ? undefined : (await deps.gh.listComments(rec.issue)).find((c) => c.author === adoptBy && c.body.includes(marker));
    const posted = ours ? { id: ours.id, created_at: ours.at } : await deps.gh.comment(rec.issue, formatQuestion(rec.question, deps.cfg.maintainer, rec.nonce));
    questionId = posted.id;
    asked = { ...rec, question_comment_id: posted.id, asked_at: posted.created_at };
    await writePaused(deps.paths, asked);
  }
  await deps.gh.addLabels(rec.issue, [NEEDS_DECISION_LABEL]);
  await deps.gh.removeLabel(rec.issue, CLAIM_LABEL);
  await deps.notifier.notify({ issue: rec.issue, gate: "question", label: NEEDS_DECISION_LABEL, text: `Issue #${rec.issue} has a question for the maintainer (${rec.question.kind}): ${rec.question.question}` });
  await appendQuestionLog(deps.paths, { issue: rec.issue, at: deps.now().toISOString(), event: "sent", asking_stage: rec.asking_stage, question_comment_id: questionId });
  await writePaused(deps.paths, { ...asked, phase: "paused" });
  await removeClaim(deps.paths, rec.issue);
}

/** AC-17: re-run, once, each pending required check that has a run; a refusal or a missing run is logged (the fix input names them). */
async function rerunChecks(deps: DriverDeps, claim: Claim, sha: string): Promise<void> {
  const summary = await deps.gh.checks(sha, deps.cfg.required_checks);
  const required = deps.cfg.required_checks.length ? deps.cfg.required_checks : [...new Set(summary.runs.map((r) => r.name))];
  for (const name of required) {
    const runs = summary.runs.filter((r) => r.name === name && r.status !== "completed");
    if (!summary.runs.some((r) => r.name === name)) deps.log({ kind: "rerun-check-missing", issue: claim.issue, sha, check: name });
    for (const run of runs) {
      try {
        const ok = await deps.gh.rerequestCheckRun(run.id);
        deps.log({ kind: ok ? "rerun-check" : "rerun-check-refused", issue: claim.issue, sha, check: name, id: run.id });
      } catch (e) {
        deps.log({ kind: "rerun-check-error", issue: claim.issue, sha, check: name, id: run.id, error: (e as Error).message });
      }
    }
  }
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
        await deps.gh.comment(claim.issue, claim.state.stage === "abandoned" ? `${a.text}\n\n${await runRecordList(deps, claim.issue)}` : a.text);
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
        if (claim.state.stage === "abandoned") {
          // Spec 005: nothing the worktree removal discards goes unsaved (the last run's leftovers, commits never in a PR).
          await saveWorktreeWork(deps, claim, "abandoned");
          // AC-7: an abandoned issue's ledger is archived, after its finding; a later claim starts with fresh counts.
          await archiveLedger(deps.paths, claim.issue, deps.now());
        }
        await removeWorktree(deps.repoDir, claim.worktree).catch((e) => deps.log({ kind: "error", issue: claim.issue, error: `worktree remove: ${(e as Error).message}` }));
        await removeClaim(deps.paths, claim.issue);
        status = "ended";
        break;
      case "wait":
        claim.state.postponedUntil = a.seconds >= POSTPONE_WAIT_S ? new Date(deps.now().getTime() + a.seconds * 1000).toISOString() : null;
        status = "waiting";
        break;
      case "close_pr": {
        // AC-2, AC-5, C10: the closed PR's own branch is saved, from the action's fields (the state no longer has the PR).
        const commits = await commitsPatch(claim.worktree, "origin/main", `origin/${a.branch}`).catch((e) => {
          deps.log({ kind: "warn", issue: claim.issue, msg: `no patch for closed PR #${a.pr}: ${(e as Error).message}` });
          return "";
        });
        const saved = await savePatch(deps.paths, claim.issue, commits, deps.now(), "closed-pr");
        await deps.gh.comment(a.pr, a.comment);
        await deps.gh.closePullRequest(a.pr);
        await deps.gh.deleteBranch(a.branch);
        deps.log({ kind: "pr-closed", issue: claim.issue, pr: a.pr, branch: a.branch, patch: saved });
        break;
      }
      case "delete_branch": {
        // AC-4, AC-21: back on issue-<n> from origin/main, then the spec branch goes locally and on GitHub.
        // Spec 005: unpushed or unmerged work on the branch is saved first; a branch whose changes are on main is not.
        const leftovers = await uncommittedPatch(claim.worktree).catch(() => "");
        if (leftovers.trim()) {
          await savePatch(deps.paths, claim.issue, leftovers, deps.now(), "uncommitted");
          await discardUncommitted(claim.worktree);
        }
        const local = `refs/heads/${a.branch}`;
        if ((await refExists(claim.worktree, local)) && !(await changesOnMain(claim.worktree, local))) {
          const saved = await savePatch(deps.paths, claim.issue, await commitsPatch(claim.worktree, "origin/main", local), deps.now(), "deleted-branch");
          deps.log({ kind: "branch-saved", issue: claim.issue, branch: a.branch, patch: saved });
        }
        await checkoutBranch(claim.worktree, `issue-${claim.issue}`, "origin/main");
        await deleteLocalBranch(claim.worktree, a.branch);
        await deps.gh.deleteBranch(a.branch);
        break;
      }
      case "rerun_checks":
        await rerunChecks(deps, claim, a.sha);
        break;
      case "finding":
        await appendFindings(deps.paths, { issue: claim.issue, stage: a.stage, run_id: "escalation", timestamp: deps.now().toISOString() }, [a.finding]);
        break;
      case "pause":
        // The worktree is kept for the resumed stage.
        await pauseIssue(deps, claim, a);
        status = "ended";
        break;
      case "run_stage":
      case "verify":
      case "merge":
        // The next step reads the stage from the state.
        break;
    }
  }
  return status;
}

/**
 * Rule 1 of step(): the claim's pending actions, in order, each removed from the claim once applied, so a crash
 * repeats at most the one in flight (AC-5). D11: after an ending action the claim is gone and is not rewritten.
 */
async function applyPending(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }> {
  let c = claim;
  let status: StepStatus = "continue";
  while (c.pendingActions?.length) {
    const [a, ...rest] = c.pendingActions;
    const s = await applyActions(deps, c, [a]);
    if (s !== "continue") status = s;
    const { pendingActions: _done, ...base } = c;
    c = rest.length ? { ...base, pendingActions: rest } : base;
    if (s === "ended") return { claim: c, status };
    await writeClaim(deps.paths, { ...c, last_activity_at: deps.now().toISOString() });
  }
  return { claim: c, status };
}

/** AC-18: `asked` on entering the question check, or on a follow-up's pause without it (T-minor 5); `checked` with its verdict. */
async function logQuestion(deps: DriverDeps, before: ChainState, after: ChainState, event: ChainEvent): Promise<void> {
  const at = deps.now().toISOString();
  if (event.type === "stage_ok" && event.stage === "question-check" && before.askingStage) {
    await appendQuestionLog(deps.paths, { issue: before.issue, at, event: "checked", asking_stage: before.askingStage, verdict: event.result.verdict, reasoning: event.result.reasoning });
  }
  const entering = after.stage === "question-check" && before.stage !== "question-check" && before.stage !== "waiting";
  const followUp = after.stage === "paused" && event.type === "stage_ok" && event.stage !== "question-check";
  if ((entering || followUp) && after.question && after.askingStage) {
    await appendQuestionLog(deps.paths, { issue: after.issue, at, event: "asked", asking_stage: after.askingStage, question: after.question });
  }
}

/** Errors propagate to the caller; the service loop catches and logs them per chain. */
export async function step(deps: DriverDeps, claim: Claim): Promise<{ claim: Claim; status: StepStatus }> {
  // An abandonment not yet finished: finish it, no transition (AC-5).
  if (claim.pendingActions?.length) return applyPending(deps, claim);
  let event: ChainEvent;
  if (claim.pendingEvent) {
    // AC-15: a resume's `answered` event goes through the transition like any other.
    const { pendingEvent, ...rest } = claim;
    event = pendingEvent;
    claim = rest;
  } else {
    const stage = claim.state.stage;
    if (ENDED.includes(stage)) return { claim, status: "ended" };
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
  }

  const before = claim.state;
  const { state, actions } = transition(before, event);
  claim = { ...claim, state, last_activity_at: deps.now().toISOString() };
  // AC-7: the ledger is written whenever a counter or the history changes, before any action.
  if (JSON.stringify(ledgerOf(before)) !== JSON.stringify(ledgerOf(state))) await writeLedger(deps.paths, claim.issue, ledgerOf(state));
  await logQuestion(deps, before, state, event);
  if (state.stage === "abandoned") {
    // AC-5: the whole action list is on disk before the first action, so a crash finishes it from where it stopped.
    claim = { ...claim, pendingActions: actions };
    await writeClaim(deps.paths, claim);
    deps.log({ kind: "transition", issue: claim.issue, event: event.type, stage: state.stage, status: "abandoning" });
    return applyPending(deps, claim);
  }
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
