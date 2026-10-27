import { fixLoopGate, readyGate } from "../gates/index.ts";
import type { AgentStageName, Question, SpecMode } from "../types.ts";
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

export type LedgerCounts = Pick<ChainState, "rescues" | "specRescues" | "replans" | "specRevisions" | "specAnswers" | "decideReturns" | "history">;

export function ledgerOf(state: LedgerCounts): LedgerCounts {
  return {
    rescues: state.rescues, specRescues: state.specRescues, replans: state.replans, specRevisions: state.specRevisions,
    specAnswers: state.specAnswers, decideReturns: state.decideReturns, history: [...state.history],
  };
}

/** A new chain; `ledger` seeds the escalation counts and history of an issue claimed before (AC-7). */
export function initialChainState(issue: number, specProblem: string | null = null, ledger: LedgerCounts | null = null): ChainState {
  return {
    issue, stage: "claimed", attempt: 1, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0,
    sensitive: false, pr: null, plan: null, pendingFixInput: null, postponedUntil: null, resumeStage: null, conflictPending: false,
    track: "issue", rescues: 0, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 0, decideReturns: 0, history: [],
    rescueRun: false, specMode: null, specProblem, question: null, askingStage: null, answer: null, answerQuestionId: null, answerKind: null,
    recordAnswer: false, decideInput: null, parkedPr: null, pendingSince: null, checksRerun: false,
    ...(ledger ? ledgerOf(ledger) : {}),
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

/** The branch of the PR the chain works on; the spec stage always runs on the spec track (Task 6). */
export function branchOf(state: Pick<ChainState, "issue" | "track">): string {
  return state.track === "spec" ? `spec-${state.issue}` : `issue-${state.issue}`;
}

type Step = { state: ChainState; actions: Action[] };
/** A stage whose bound can be hit: the question check maps to the asking stage and verify to fix. */
type Stuck = Exclude<AgentStageName, "question-check">;

const POSTPONABLE: ChainStage[] = ["plan", "implement", "review", "fix", "spec", "question-check"];

function invalid(state: ChainState, event: ChainEvent): never {
  throw new Error(`invalid event ${event.type} in stage ${state.stage} (issue ${state.issue})`);
}

function note(state: ChainState, entry: string): ChainState {
  return { ...state, history: [...state.history, entry.slice(0, HISTORY_ENTRY_MAX)].slice(-HISTORY_MAX_ENTRIES) };
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
  // The PR is closed: its fix input, conflict and rescue flag go with it.
  const dropPr: Partial<ChainState> = { pr: null, pendingFixInput: null, conflictPending: false, rescueRun: false };
  const close = (why: string): Action[] => (s.pr ? [{ type: "close_pr", pr: s.pr.number, branch: branchOf(s), comment: `${why}${reason}` }] : []);
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
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (kept.length > 0 && size + entries[i].length > ABANDON_COMMENT_HISTORY_MAX) break;
    kept.unshift(entries[i]);
    size += entries[i].length;
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
    ...kept.map((e, i) => `${i + 1}. ${e.split("\n").join("\n   ")}`),
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

function escalationInput(q: Question | undefined): string {
  if (!q) return "The review escalated without an escalation object.";
  const options = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.cost}`);
  return [`Review escalated (kind ${q.kind}): ${q.question}`, "Options:", ...options, `Recommendation: ${q.recommendation}`].join("\n");
}

export function transition(state: ChainState, event: ChainEvent): Step {
  if (event.type === "liveness_expired") {
    const text = "Claim released: no run in flight and no activity for the liveness window. Uncommitted work was saved as a patch in the scheduler state directory.";
    // AC-21: a released spec track frees `spec-<issue>` for the next spec PR.
    const specTrack: Action[] = state.track !== "spec" ? []
      : state.pr ? [{ type: "close_pr", pr: state.pr.number, branch: branchOf(state), comment: "Closed by the scheduler: the claim was released by liveness." }]
      : [{ type: "delete_branch", branch: branchOf(state) }];
    return {
      state: { ...state, stage: "released" },
      actions: [
        ...specTrack,
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
      default:
        invalid(state, event);
    }
  }

  switch (state.stage) {
    case "claimed":
      if (event.type === "start") return run(state, "plan");
      break;
    case "waiting":
      if (event.type === "start" && state.resumeStage) {
        if (state.resumeStage === "spec") return toSpec(state, state.specMode ?? "write", { attempt: state.attempt });
        const extra = state.resumeStage === "fix" && state.pendingFixInput ? { fixInput: state.pendingFixInput }
          : state.resumeStage === "review" ? reviewProfile(state) : {};
        return run(state, state.resumeStage, extra, { attempt: state.attempt });
      }
      break;
    case "plan":
      if (event.type === "stage_ok" && event.stage === "plan") {
        const s = { ...state, rescueRun: false };
        const gate = readyGate(event.result);
        if (gate.ok) return run({ ...s, plan: event.result }, "implement");
        // C2 stopgap: spec 006 Task 6 routes the first spec gap to the spec stage in answer mode.
        return escalate(s, "plan", `spec gap: ${gate.reason}`);
      }
      break;
    case "implement":
    case "fix":
      if (event.type === "stage_ok" && (event.stage === "implement" || event.stage === "fix")) {
        const pr = event.stage === "implement"
          ? { number: event.result.pr_number, head_sha: event.result.head_sha }
          : state.pr ? { ...state.pr, head_sha: event.result.head_sha } : null;
        const fixes = event.stage === "fix" ? state.fixes + 1 : state.fixes;
        const done = { ...state, pr, fixes, conflictPending: false, rescueRun: false };
        if (!event.scope.ok) {
          const text = `Diff touches files outside the plan's file scope:\n${event.scope.violations.map((v) => `- ${v}`).join("\n")}`;
          const noted = note(done, text);
          if (state.scopeViolations >= 1) return escalate(noted, event.stage, "scope violated a second time", text);
          return toFix(noted, text, { scopeViolations: 1 });
        }
        return { state: { ...done, stage: "verify", pendingFixInput: null }, actions: [{ type: "verify" }] };
      }
      break;
    case "verify":
      if (event.type === "checks") {
        const checked = { ...state, sensitive: event.sensitive };
        if (event.status === "pending") return { state: checked, actions: [{ type: "wait", seconds: PENDING_WAIT_S }] };
        if (event.status === "failed") {
          const text = `A required check failed:\n${event.log ?? "(no log excerpt)"}`;
          return toFix(note(checked, text), text);
        }
        return run(checked, "review", reviewProfile(checked));
      }
      break;
    case "review":
      if (event.type === "stage_ok" && event.stage === "review") {
        const s = { ...state, rescueRun: false };
        const r = event.result;
        // Spec 006 Task 6 sends kinds other than "other" to the question check; until then every escalation is a bound hit (AC-8).
        if (r.verdict === "escalate") return escalate(s, "fix", `review escalated: ${r.escalation?.question ?? "no escalation object"}`, escalationInput(r.escalation));
        const text = `Review requested changes:\n${r.findings_on_pr.map((f, i) => `${i}. [${f.criterion}] ${f.file}:${f.line} ${f.scenario}`).join("\n")}`;
        // AC-9: security findings go through the fix loop; a later approval without findings merges.
        if ((s.sensitive || event.security) && r.findings_on_pr.length > 0) return toFix(note(s, text), text);
        if (r.verdict === "approve") return { state: { ...s, stage: "merge" }, actions: [{ type: "merge" }] };
        return toFix(note(s, text), text);
      }
      break;
    case "merge":
      if (event.type === "merge_result") {
        if (event.status === "merged") return { state: { ...state, stage: "done" }, actions: [{ type: "label", add: [], remove: [CLAIM_LABEL] }, { type: "done" }] };
        return toFix(state, `PR not mergeable:\n${event.detail ?? ""}`);
      }
      if (event.type === "head_moved") return { state: { ...state, stage: "verify", pr: { ...state.pr!, head_sha: event.head_sha } }, actions: [{ type: "verify" }] };
      break;
    default:
      break;
  }
  invalid(state, event);
}
