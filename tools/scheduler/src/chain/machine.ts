import { fixLoopGate, NEEDS_DESIGN_STAGE, readyGate, type ScopeResult } from "../gates/index.ts";
import type { AgentStageName, AskingStage, ImplementResult, PlanResult, Question, SpecMode } from "../types.ts";
import type { Action, ChainEvent, ChainStage, ChainState } from "./types.ts";

export const CLAIM_LABEL = "in-progress";
export const ABANDONED_LABEL = "abandoned";
export const NEEDS_DECISION_LABEL = "needs-decision";
export const PENDING_WAIT_S = 60;
export const POSTPONE_WAIT_S = 1800;

/** Escalation bounds (AC-6): fixed in code, counted per issue. `MAX_RESCUES` applies on each track. */
export const MAX_RESCUES = 1;
export const MAX_REPLANS = 1;
export const MAX_SPEC_REVISIONS = 1;
export const MAX_SPEC_ANSWERS = 1;
export const MAX_DECIDE_RETURNS = 1;
export const VERIFY_PENDING_MAX_H = 6;
/** History (AC-7): each entry capped in length, the last entries kept. */
export const HISTORY_ENTRY_MAX = 4000;
export const HISTORY_MAX_ENTRIES = 20;
/** The history quoted in the abandonment comment stays well under GitHub's 65536-character comment limit. */
const ABANDON_COMMENT_HISTORY_MAX = 50_000;
/** AC-14: a spec question of kind `other` is answered by the scheduler as if the check had said decide_yourself. */
const KIND_OTHER_REASONING = "kind other is not a question for the maintainer";
/** The ended stages (AC-27): nothing runs and liveness does not apply. */
/** Stages a chain does not leave by itself; `liveness_expired` is invalid in them. */
export const ENDED: ChainStage[] = ["done", "released", "abandoned", "paused"];

export type LedgerCounts = Pick<ChainState, "rescues" | "specRescues" | "replans" | "specRevisions" | "specAnswers" | "decideReturns" | "history">;

export function ledgerOf(state: LedgerCounts): LedgerCounts {
  return {
    rescues: state.rescues, specRescues: state.specRescues, replans: state.replans, specRevisions: state.specRevisions,
    specAnswers: state.specAnswers, decideReturns: state.decideReturns, history: [...state.history],
  };
}

const clip = (text: string): string => text.slice(0, HISTORY_ENTRY_MAX);

/** A new chain; `ledger` seeds the escalation counts and history of an issue claimed before (AC-7), trimmed like any history. */
export function initialChainState(issue: number, specProblem: string | null = null, ledger: LedgerCounts | null = null): ChainState {
  return {
    issue, stage: "claimed", attempt: 1, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0,
    sensitive: false, pr: null, plan: null, pendingFixInput: null, postponedUntil: null, resumeStage: null, conflictPending: false,
    track: "issue", rescues: 0, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 0, decideReturns: 0, history: [],
    rescueRun: false, specMode: null, specProblem, question: null, askingStage: null, answer: null, answerQuestionId: null, answerKind: null,
    recordAnswer: false, decideInput: null, parkedPr: null, pendingSince: null, checksRerun: false,
    ...(ledger ? { ...ledgerOf(ledger), history: ledger.history.slice(-HISTORY_MAX_ENTRIES).map(clip) } : {}),
  };
}

/** A claim state as read from disk, possibly written before spec 006: missing fields get their defaults, `securityFinding` is dropped (AC-7). */
export function normalizeChainState(raw: unknown): ChainState {
  if (typeof raw !== "object" || raw === null || typeof (raw as { issue?: unknown }).issue !== "number") {
    throw new Error("invalid chain state: not an object with a numeric issue");
  }
  const { securityFinding: _dropped, ...rest } = raw as Record<string, unknown>;
  return { ...initialChainState(rest.issue as number), ...rest } as ChainState;
}

/** The branch of the PR the chain works on; the spec stage always runs on the spec track. */
export function branchOf(state: Pick<ChainState, "issue" | "track">): string {
  return state.track === "spec" ? `spec-${state.issue}` : `issue-${state.issue}`;
}

type Step = { state: ChainState; actions: Action[] };
/** A stage whose bound can be hit: the question check maps to the asking stage and verify to fix. */
type Stuck = Exclude<AgentStageName, "question-check">;
type StageOk = Extract<ChainEvent, { type: "stage_ok" }>;

const POSTPONABLE: ChainStage[] = ["plan", "implement", "review", "fix", "spec", "question-check"];

function invalid(state: ChainState, event: ChainEvent): never {
  throw new Error(`invalid event ${event.type} in stage ${state.stage} (issue ${state.issue})`);
}

function note(state: ChainState, entry: string): ChainState {
  return { ...state, history: [...state.history, clip(entry)].slice(-HISTORY_MAX_ENTRIES) };
}

function run(state: ChainState, stage: AgentStageName, extra: Partial<Extract<Action, { type: "run_stage" }>> = {}, patch: Partial<ChainState> = {}): Step {
  const attempt = patch.attempt ?? 1;
  return { state: { ...state, ...patch, stage, attempt, resumeStage: null }, actions: [{ type: "run_stage", stage, attempt, ...extra }] };
}

/** Every entry into the spec stage goes through here and sets the spec track. */
function toSpec(state: ChainState, mode: SpecMode, patch: Partial<ChainState> = {}): Step {
  return run({ ...state, track: "spec", specMode: mode }, "spec", {}, patch);
}

function reviewProfile(state: ChainState): { profile?: "security" } {
  return state.sensitive ? { profile: "security" } : {};
}

function toFix(state: ChainState, fixInput: string, patch: Partial<ChainState> = {}): Step {
  const gate = fixLoopGate(state.fixes);
  if (!gate.ok) return escalate({ ...state, ...patch }, "fix", gate.reason, fixInput);
  return run(state, "fix", { fixInput }, { ...patch, pendingFixInput: fixInput });
}

/** The stuck stage once more, fresh; the driver reads `rescueRun` and the history from the state. */
function rerun(state: ChainState, stuck: Stuck, fixInput: string, patch: Partial<ChainState>): Step {
  switch (stuck) {
    case "fix":
      return run(state, "fix", { fixInput }, { ...patch, pendingFixInput: fixInput });
    case "review":
      return run(state, "review", reviewProfile(state), patch);
    case "spec":
      return toSpec(state, state.specMode ?? "write", patch);
    default:
      return run(state, stuck, {}, patch);
  }
}

/**
 * The escalation rule of spec section 4 (AC-1 to AC-5), applied at once when a bound is hit. `fixInput` is the
 * input of a rescue fix (the work the fix loop could not finish); it defaults to `reason`.
 */
function escalate(state: ChainState, stuck: Stuck, reason: string, fixInput: string = reason): Step {
  const s = note(state, `${stuck}: ${reason}`);
  if (s.track === "spec" || stuck === "spec") {
    if (s.specRescues < MAX_RESCUES) return rerun(s, stuck, fixInput, { specRescues: s.specRescues + 1, rescueRun: true, track: "spec" });
    return abandon(s, stuck);
  }
  if (s.rescues < MAX_RESCUES) return rerun(s, stuck, fixInput, { rescues: s.rescues + 1, rescueRun: true });
  // The PR is closed: its fix input, conflict and rescue flag go with it, and so do a decide-mode input and an ADR requirement on its run.
  const dropPr: Partial<ChainState> = { pr: null, pendingFixInput: null, conflictPending: false, rescueRun: false, decideInput: null, recordAnswer: false };
  const close = (why: string): Action[] => (s.pr ? [{ type: "close_pr", pr: s.pr.number, branch: branchOf(s), comment: `${why}${clip(reason)}` }] : []);
  if (s.replans < MAX_REPLANS) {
    const next = run(s, "plan", {}, { ...dropPr, plan: null, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0, replans: s.replans + 1 });
    return { state: next.state, actions: [...close("Closed by the scheduler to re-plan: "), ...next.actions] };
  }
  if (s.specRevisions < MAX_SPEC_REVISIONS) {
    const next = toSpec(s, "revise", { ...dropPr, specRevisions: s.specRevisions + 1 });
    return { state: next.state, actions: [...close("Closed by the scheduler to revise the spec: "), ...next.actions] };
  }
  return abandon(s, stuck);
}

function boundsText(s: ChainState): string {
  return `rescue ${s.rescues}/${MAX_RESCUES}, spec-track rescue ${s.specRescues}/${MAX_RESCUES}, re-plan ${s.replans}/${MAX_REPLANS}, spec revision ${s.specRevisions}/${MAX_SPEC_REVISIONS}`;
}

/** Informational only: no @ anywhere (AC-5, C11), the newest history entries that fit. The driver appends the run-record paths. */
function abandonmentComment(s: ChainState): string {
  const entries = s.history.map((e) => e.replaceAll("@", "(at)"));
  const render = (e: string, n: number) => `${n}. ${e.split("\n").join("\n   ")}`;
  // The rendered size, bounded from above: the widest "N. " prefix, three spaces per continuation line, and the joining newline.
  const widest = String(entries.length).length + 2;
  const renderedSize = (e: string) => widest + e.length + 3 * (e.split("\n").length - 1) + 1;
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = renderedSize(entries[i]);
    if (kept.length > 0 && size + cost > ABANDON_COMMENT_HISTORY_MAX) break;
    kept.unshift(entries[i]);
    size += cost;
  }
  const omitted = entries.length - kept.length;
  return [
    "### Issue abandoned by the scheduler",
    "",
    "The scheduler stopped work on this issue: its escalation path is used up. The issue stays open.",
    "",
    `Bounds hit: ${boundsText(s)}.`,
    "",
    "History, oldest first:",
    "",
    ...(omitted > 0 ? [`(${omitted} earlier entries omitted)`, ""] : []),
    ...kept.map((e, i) => render(e, i + 1)),
    "",
    "Spec C's re-triage picks this issue up; nothing is needed from the maintainer.",
  ].join("\n");
}

/** AC-5: close the PRs, comment, label, record a finding, notify once, end. The issue is not closed. */
function abandon(s: ChainState, stuck: Stuck): Step {
  const why = "Closed by the scheduler: the issue was abandoned after its escalation path.";
  const closes: Action[] = [];
  if (s.pr) closes.push({ type: "close_pr", pr: s.pr.number, branch: branchOf(s), comment: why });
  if (s.parkedPr) closes.push({ type: "close_pr", pr: s.parkedPr.number, branch: `issue-${s.issue}`, comment: why });
  return {
    state: { ...s, stage: "abandoned", pr: null, parkedPr: null, rescueRun: false },
    actions: [
      ...closes,
      { type: "comment", text: abandonmentComment(s) },
      { type: "label", add: [ABANDONED_LABEL], remove: [CLAIM_LABEL] },
      {
        type: "finding", stage: stuck,
        finding: { what: "issue abandoned after the escalation path", where: `issue #${s.issue}`, evidence: s.history.join("\n"), noticed_how: "scheduler escalation" },
      },
      { type: "notify", gate: "abandoned", label: ABANDONED_LABEL, text: `Issue #${s.issue} abandoned after the escalation path (${boundsText(s)}).` },
      { type: "done" },
    ],
  };
}

function escalationInput(who: string, q: Question | null | undefined): string {
  if (!q) return `${who} escalated without an escalation object.`;
  const options = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.cost}`);
  return [`${who} escalated (kind ${q.kind}): ${q.question}`, "Options:", ...options, `Recommendation: ${q.recommendation}`].join("\n");
}

/** A bound hit by the stage that asked a question: verify's stuck stage is fix, which gets the question as input (AC-1, AC-14). */
function escalateAsker(s: ChainState, asking: AskingStage, reason: string, question: Question | null): Step {
  if (asking === "verify") return escalate(s, "fix", reason, `${reason}\n\n${escalationInput("Verify", question)}`);
  return escalate(s, asking, reason, asking === "fix" ? s.pendingFixInput ?? reason : reason);
}

/** The asking stage runs again: after an answer (AC-18) or sent back to decide (AC-14). */
function resume(s: ChainState, asking: AskingStage, patch: Partial<ChainState> = {}, mode?: SpecMode): Step {
  switch (asking) {
    case "spec":
      return toSpec(s, mode ?? s.specMode ?? "write", patch);
    case "verify":
      // A new six-hour window (AC-17).
      return { state: { ...s, ...patch, stage: "verify", attempt: 1, pendingSince: null }, actions: [{ type: "verify" }] };
    case "review":
      return run(s, "review", reviewProfile(s), patch);
    case "fix":
      return run(s, "fix", s.pendingFixInput ? { fixInput: s.pendingFixInput } : {}, patch);
    default:
      return run(s, asking, {}, patch);
  }
}

/** AC-13: one pause action; the driver writes the paused record, posts the question and releases the claim. */
function pause(s: ChainState, question: Question, asking: AskingStage): Step {
  return { state: { ...s, stage: "paused", question, askingStage: asking }, actions: [{ type: "pause", question, asking }] };
}

/** AC-14: the asking stage runs again in decide mode; verify, or a second return on the issue, is a bound hit. */
function decideYourself(state: ChainState, asking: AskingStage, reasoning: string): Step {
  const question = state.question;
  const s = { ...state, decideReturns: state.decideReturns + 1, question: null };
  if (asking === "verify" || s.decideReturns > MAX_DECIDE_RETURNS) return escalateAsker(s, asking, `decide_yourself: ${reasoning}`, question);
  return resume(s, asking, { decideInput: reasoning }, "decide");
}

/** A stage's result carries a question (AC-12, AC-15, AC-17): a follow-up pauses, decide mode fails the run, otherwise the check runs. */
function ask(state: ChainState, stage: Stuck, question: Question): Step {
  if (state.answer !== null) return pause({ ...state, rescueRun: false }, question, stage);
  if (state.decideInput !== null) return failedInDecideMode(state, stage);
  return run({ ...state, rescueRun: false }, "question-check", {}, { question, askingStage: stage });
}

function failedInDecideMode(state: ChainState, stage: Stuck): Step {
  return transition(state, { type: "stage_failed", stage, reason: "escalated in decide mode" });
}

/**
 * A stage succeeded with a decision (not a question): its rescue, decide-mode input and reply are spent (AC-14, AC-18).
 * On the spec track the answered question's id and kind stay until the spec PR merges: its fixes are scope-checked with them.
 */
function settle(state: ChainState, stage: AgentStageName): ChainState {
  const s: ChainState = { ...state, rescueRun: false, decideInput: null, answer: null };
  if (state.track === "issue") Object.assign(s, { answerQuestionId: null, answerKind: null });
  if (stage === "fix") s.recordAnswer = false;
  return s;
}

function scopeOf(state: ChainState, event: { stage: string; scope?: ScopeResult }): ScopeResult {
  if (!event.scope) throw new Error(`stage_ok of ${event.stage} without a scope result (issue ${state.issue})`);
  return event.scope;
}

const violationList = (violations: string[]) => violations.map((v) => `- ${v}`).join("\n");

function stageOk(state: ChainState, event: StageOk): Step {
  switch (event.stage) {
    case "plan": {
      if (event.result.escalation) return ask(state, "plan", event.result.escalation);
      const s = settle(state, "plan");
      const result = event.result as PlanResult;
      const gate = readyGate(result);
      if (gate.ok) return run({ ...s, plan: result }, "implement");
      // AC-19: the first gap is answered by the spec stage; a gap after it is a bound hit.
      if (s.specAnswers < MAX_SPEC_ANSWERS) return toSpec(s, "answer", { specProblem: gate.reason, specAnswers: s.specAnswers + 1 });
      return escalate(s, "plan", `spec gap after an answered gap: ${gate.reason}`);
    }
    case "implement":
    case "fix": {
      if (event.result.escalation) return ask(state, event.stage, event.result.escalation);
      const scope = scopeOf(state, event);
      const result = event.result as ImplementResult | { head_sha: string };
      const pr = event.stage === "implement"
        ? { number: (result as ImplementResult).pr_number, head_sha: result.head_sha }
        : state.pr ? { ...state.pr, head_sha: result.head_sha } : null;
      const fixes = event.stage === "fix" ? state.fixes + 1 : state.fixes;
      const done = { ...settle(state, event.stage), pr, fixes, conflictPending: false };
      if (!scope.ok) {
        const text = `Diff touches files outside the plan's file scope:\n${violationList(scope.violations)}`;
        const noted = note(done, text);
        if (state.scopeViolations >= 1) return escalate(noted, event.stage, "scope violated a second time", text);
        return toFix(noted, text, { scopeViolations: 1 });
      }
      return { state: { ...done, stage: "verify", pendingFixInput: null }, actions: [{ type: "verify" }] };
    }
    case "review": {
      const r = event.result;
      if (r.verdict === "escalate") {
        // AC-8: kind other is a bound hit with a rescue fix, before the follow-up and decide-mode rules.
        if (!r.escalation || r.escalation.kind === "other") {
          return escalate(settle(state, "review"), "fix", `review escalated: ${r.escalation?.question ?? "no escalation object"}`, escalationInput("Review", r.escalation));
        }
        return ask(state, "review", r.escalation);
      }
      const s = settle(state, "review");
      const text = `Review requested changes:\n${r.findings_on_pr.map((f, i) => `${i}. [${f.criterion}] ${f.file}:${f.line} ${f.scenario}`).join("\n")}`;
      // AC-9: security findings go through the fix loop; a later approval without findings merges.
      if ((s.sensitive || event.security) && r.findings_on_pr.length > 0) return toFix(note(s, text), text);
      if (r.verdict === "approve") return { state: { ...s, stage: "merge" }, actions: [{ type: "merge" }] };
      return toFix(note(s, text), text);
    }
    case "spec": {
      const r = event.result;
      if (r.verdict === "question") {
        if (!r.question) throw new Error(`spec question without a question object (issue ${state.issue})`);
        if (r.question.kind !== "other") return ask(state, "spec", r.question);
        // AC-14: kind other is not sent to the check; in decide mode it is a failed run like any question.
        if (state.decideInput !== null) return failedInDecideMode(state, "spec");
        return decideYourself({ ...state, rescueRun: false }, "spec", KIND_OTHER_REASONING);
      }
      if (r.pr_number === undefined || r.head_sha === undefined) throw new Error(`spec revised without a PR (issue ${state.issue})`);
      const scope = scopeOf(state, event);
      const done: ChainState = {
        ...settle(state, "spec"), pr: { number: r.pr_number, head_sha: r.head_sha }, fixes: 0, scopeViolations: 0, specMode: null,
        pendingFixInput: null, conflictPending: false,
      };
      if (scope.ok) return { state: { ...done, stage: "verify" }, actions: [{ type: "verify" }] };
      // AC-22: handled like implement's first violation; the fix's second violation follows the spec-track rule.
      const text = `Diff touches files outside the spec PR's scope:\n${violationList(scope.violations)}`;
      return toFix(note(done, text), text, { scopeViolations: 1 });
    }
    case "question-check": {
      const { question, askingStage } = state;
      if (!question || !askingStage) throw new Error(`question check without a question (issue ${state.issue})`);
      if (event.result.verdict === "send") return pause(state, question, askingStage);
      return decideYourself(state, askingStage, event.result.reasoning);
    }
  }
}

/** AC-17: the question the verify bound raises after the re-run and the investigating fix. */
function neverReported(pr: number, names: string): Question {
  return {
    kind: "capability",
    question: `A required check never reported on PR #${pr}: ${names}. The scheduler re-ran it and a fix investigated its workflow; it stayed pending for another ${VERIFY_PENDING_MAX_H} hours.`,
    options: [
      { label: "fixed, re-check", cost: `you fix the cause outside the repository (runner, app permissions, workflow settings); verify waits up to ${VERIFY_PENDING_MAX_H} more hours` },
      { label: "drop the check from `required_checks`", cost: "you edit the scheduler configuration; PRs then merge without that check" },
    ],
    recommendation: "fixed, re-check, if the check still guards something; otherwise drop it",
  };
}

function verifyChecks(state: ChainState, event: Extract<ChainEvent, { type: "checks" }>): Step {
  const checked = { ...state, sensitive: event.sensitive };
  if (event.status === "pending") {
    const since = checked.pendingSince ?? event.at;
    if (Date.parse(event.at) - Date.parse(since) < VERIFY_PENDING_MAX_H * 3_600_000) {
      return { state: { ...checked, pendingSince: since }, actions: [{ type: "wait", seconds: PENDING_WAIT_S }] };
    }
    if (!checked.pr) throw new Error(`verify without a PR (issue ${state.issue})`);
    const sha = checked.pr.head_sha;
    const names = event.pending?.length ? event.pending.join(", ") : "(not named)";
    if (!checked.checksRerun) {
      const input = `Required checks ${names} have been pending for ${VERIFY_PENDING_MAX_H} hours on ${sha}; the scheduler has re-run those it could. Investigate why they never report: the workflow files and triggers that should produce them, and whether each check has a run. Fix the cause if it is in this repository; otherwise change nothing and say so.`;
      const next = toFix(checked, input, { checksRerun: true, pendingSince: null });
      return { state: next.state, actions: [{ type: "rerun_checks", sha }, ...next.actions] };
    }
    return run(checked, "question-check", {}, { question: neverReported(checked.pr.number, names), askingStage: "verify", pendingSince: null });
  }
  // Verify moves on: the window closes, and a reply that resumed verify is no longer an input (AC-18).
  const moved: ChainState = { ...checked, pendingSince: null, checksRerun: false, answer: null };
  if (state.track === "issue") Object.assign(moved, { answerQuestionId: null, answerKind: null });
  if (event.status === "failed") {
    const text = `A required check failed:\n${event.log ?? "(no log excerpt)"}`;
    return toFix(note(moved, text), text);
  }
  return run(moved, "review", reviewProfile(moved));
}

/** AC-4: after a spec PR merges, spec-present and the UI-design gate ran again on origin/main. The chain is not done. */
function specMerged(state: ChainState, gate: NonNullable<Extract<ChainEvent, { type: "merge_result" }>["specGate"]>): Step {
  const deleteBranch: Action = { type: "delete_branch", branch: branchOf(state) };
  const fresh: Partial<ChainState> = {
    fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0, conflictPending: false, pendingFixInput: null, pendingSince: null, checksRerun: false,
    rescueRun: false, specProblem: null, specMode: null, decideInput: null, answer: null, answerQuestionId: null, answerKind: null, recordAnswer: false,
  };
  const after = (next: Step): Step => ({ state: next.state, actions: [deleteBranch, ...next.actions] });
  if (gate.ok) {
    const base: ChainState = { ...state, ...fresh, track: "issue" };
    if (state.parkedPr) {
      return after(toFix({ ...base, pr: state.parkedPr, parkedPr: null },
        `Apply the maintainer's decision to question #${state.answerQuestionId}, now recorded on main. Read it in the spec and the top designs, then change this PR to follow it.`));
    }
    return after(run({ ...base, pr: null, plan: null }, "plan"));
  }
  if (gate.gate === "spec-present") {
    return after(escalate({ ...state, pr: null, specProblem: gate.reason, specMode: "write" }, "spec", `spec-present failed after merge: ${gate.reason}`));
  }
  // AC-20: wait for spec E's design stage; the ledger is kept (not archived).
  const closeParked: Action[] = state.parkedPr
    ? [{ type: "close_pr", pr: state.parkedPr.number, branch: `issue-${state.issue}`, comment: "Closed by the scheduler: the issue waits for its design stage." }]
    : [];
  return {
    state: { ...state, stage: "released", pr: null, parkedPr: null },
    actions: [
      deleteBranch,
      ...closeParked,
      { type: "comment", text: `The spec PR merged, but the UI-design gate failed on main: ${gate.reason}` },
      { type: "label", add: [NEEDS_DESIGN_STAGE], remove: [CLAIM_LABEL] },
      { type: "notify", gate: "ui-design", label: NEEDS_DESIGN_STAGE, text: `Issue #${state.issue} waits for the design stage: ${gate.reason}` },
      { type: "release", reason: "ui design missing after the spec merge", savePatch: false },
    ],
  };
}

/** AC-18: the routes of the five `paused` rows of spec section 4. */
function answered(state: ChainState, event: Extract<ChainEvent, { type: "answered" }>): Step {
  const { question, askingStage: asking } = state;
  if (!question || !asking) throw new Error(`paused without a question (issue ${state.issue})`);
  const s: ChainState = { ...state, answer: event.answer, answerQuestionId: event.questionId, answerKind: question.kind, question: null };
  if (asking === "spec") return resume(s, "spec");
  // A capability answer is not a decision: the asking stage runs again with it, and nothing is recorded.
  if (question.kind !== "product" && question.kind !== "technical") return resume(s, asking);
  const decision = `${question.question}\nAnswer: ${event.answer}`;
  if (asking === "review" || asking === "fix") {
    // On a spec PR the decision is recorded in that PR; there is no issue PR to park.
    if (s.track === "spec") {
      return toFix(s, `Record the maintainer's decision in this spec PR, marked (maintainer answer, question #${event.questionId}), then apply it:\n${decision}`);
    }
    if (question.kind === "product") return toSpec({ ...s, parkedPr: s.pr, pr: null }, "record");
    return toFix(s, `Record the maintainer's decision as an ADR under docs/decisions/, marked (maintainer answer, question #${event.questionId}), then apply it:\n${decision}`, { recordAnswer: true });
  }
  return toSpec(s, "record");
}

export function transition(state: ChainState, event: ChainEvent): Step {
  if (event.type === "liveness_expired") {
    if (ENDED.includes(state.stage)) invalid(state, event);
    const text = "Claim released: no run in flight and no activity for the liveness window. Uncommitted work was saved as a patch in the scheduler state directory.";
    // AC-21: a released spec track frees `spec-<issue>` for the next spec PR, and a parked issue PR is closed so the next claim can open `issue-<issue>`.
    const closes: Action[] = [];
    if (state.track === "spec") {
      closes.push(state.pr
        ? { type: "close_pr", pr: state.pr.number, branch: branchOf(state), comment: "Closed by the scheduler: the claim was released by liveness." }
        : { type: "delete_branch", branch: branchOf(state) });
    }
    if (state.parkedPr) closes.push({ type: "close_pr", pr: state.parkedPr.number, branch: `issue-${state.issue}`, comment: "Closed by the scheduler: the claim was released by liveness." });
    return {
      state: { ...state, stage: "released", ...(state.track === "spec" ? { pr: null } : {}), parkedPr: null },
      actions: [
        ...closes,
        { type: "comment", text },
        { type: "label", add: [], remove: [CLAIM_LABEL] },
        { type: "notify", gate: "liveness", label: "", text },
        { type: "release", reason: "liveness expired", savePatch: true },
      ],
    };
  }
  if (event.type === "rebase_conflict") {
    if (!["plan", "implement", "review", "fix", "verify", "merge"].includes(state.stage)) invalid(state, event);
    return toFix(state, `Rebase onto main conflicted:\n${event.detail}`, { conflictPending: true });
  }
  if (event.type === "stage_failed") {
    if (event.stage !== state.stage) invalid(state, event);
    // AC-27: before every other failure rule; a postponed rescue stays a rescue and nothing is spent or noted.
    if (event.postpone) {
      if (!POSTPONABLE.includes(state.stage)) invalid(state, event);
      return { state: { ...state, stage: "waiting", resumeStage: event.stage, postponedUntil: null }, actions: [{ type: "wait", seconds: POSTPONE_WAIT_S }] };
    }
    const s = note(state, `${event.stage} attempt ${state.attempt} failed: ${event.reason}`);
    if (s.rescueRun && event.stage !== "question-check") return escalate(s, event.stage, `rescue run failed: ${event.reason}`, s.pendingFixInput ?? event.reason);
    switch (s.stage) {
      case "plan":
        if (s.planFailures === 0) return run(s, "plan", {}, { planFailures: 1, attempt: 2 });
        return escalate(s, "plan", `failed twice: ${event.reason}`);
      case "implement":
        if (s.implementFailures === 0) return run(s, "implement", {}, { implementFailures: 1, attempt: 2 });
        return escalate(s, "implement", `failed twice: ${event.reason}`);
      case "review":
        if (s.attempt === 1) return run(s, "review", reviewProfile(s), { attempt: 2 });
        return escalate(s, "review", `failed twice: ${event.reason}`);
      case "fix":
        return escalate(s, "fix", `failed: ${event.reason}`, s.pendingFixInput ?? event.reason);
      case "spec":
        if (s.attempt === 1) return toSpec(s, s.specMode ?? "write", { attempt: 2 });
        return escalate(s, "spec", `failed twice: ${event.reason}`);
      case "question-check": {
        if (!s.askingStage) throw new Error(`question check without an asking stage (issue ${state.issue})`);
        if (s.attempt === 1) return run(s, "question-check", {}, { attempt: 2 });
        // AC-12: a bound hit for the stage that asked.
        return escalateAsker(s, s.askingStage, `question check failed twice: ${event.reason}`, s.question);
      }
      default:
        invalid(state, event);
    }
  }
  if (event.type === "stage_ok") {
    if (event.stage !== state.stage) invalid(state, event);
    return stageOk(state, event);
  }

  switch (state.stage) {
    case "claimed":
      // AC-19: a missing or incomplete spec starts at the spec stage.
      if (event.type === "start") return state.specProblem ? toSpec(state, "write") : run(state, "plan");
      break;
    case "waiting":
      if (event.type === "start" && state.resumeStage) {
        if (state.resumeStage === "spec") return toSpec(state, state.specMode ?? "write", { attempt: state.attempt });
        const extra = state.resumeStage === "fix" && state.pendingFixInput ? { fixInput: state.pendingFixInput }
          : state.resumeStage === "review" ? reviewProfile(state) : {};
        return run(state, state.resumeStage, extra, { attempt: state.attempt });
      }
      break;
    case "verify":
      if (event.type === "checks") return verifyChecks(state, event);
      break;
    case "merge":
      if (event.type === "merge_result") {
        if (event.status === "merged") {
          if (state.track === "spec") return specMerged(state, event.specGate ?? { ok: false, gate: "spec-present", reason: "the post-merge spec gates did not run" });
          return { state: { ...state, stage: "done" }, actions: [{ type: "label", add: [], remove: [CLAIM_LABEL] }, { type: "done" }] };
        }
        return toFix(state, `PR not mergeable:\n${event.detail ?? ""}`);
      }
      if (event.type === "head_moved") return { state: { ...state, stage: "verify", pr: { ...state.pr!, head_sha: event.head_sha } }, actions: [{ type: "verify" }] };
      break;
    case "paused":
      if (event.type === "answered") return answered(state, event);
      break;
    default:
      break;
  }
  invalid(state, event);
}
