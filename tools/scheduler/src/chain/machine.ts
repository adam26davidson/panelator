import { fixLoopGate, NEEDS_DESIGN_STAGE, readyGate, type ScopeResult } from "../gates/index.ts";
import type { AgentStageName, AskingStage, ImplementResult, PendingAnswer, PlanResult, Question, SpecMode } from "../types.ts";
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
/** C7: releases for repeated chain errors; the next one abandons the issue. */
export const MAX_CHAIN_ERRORS = 1;
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

export type LedgerCounts = Pick<
  ChainState, "rescues" | "specRescues" | "replans" | "specRevisions" | "specAnswers" | "decideReturns" | "history" | "pendingAnswer" | "chainFailures" | "chainErrors"
>;

/** The ledger's fields of a state; a ledger written before T4 and C7 lacks the last three, which default. */
export function ledgerOf(state: Omit<LedgerCounts, "pendingAnswer" | "chainFailures" | "chainErrors"> & Partial<LedgerCounts>): LedgerCounts {
  return {
    rescues: state.rescues, specRescues: state.specRescues, replans: state.replans, specRevisions: state.specRevisions,
    specAnswers: state.specAnswers, decideReturns: state.decideReturns, history: [...state.history],
    pendingAnswer: state.pendingAnswer ?? null, chainFailures: state.chainFailures ?? null, chainErrors: state.chainErrors ?? 0,
  };
}

const clip = (text: string): string => text.slice(0, HISTORY_ENTRY_MAX);

/**
 * A new chain; `ledger` seeds the escalation counts and history of an issue claimed before (AC-7), trimmed like any
 * history, and an answer a release left unrecorded (T4).
 */
export function initialChainState(issue: number, specProblem: string | null = null, ledger: Parameters<typeof ledgerOf>[0] | null = null): ChainState {
  return {
    issue, stage: "claimed", attempt: 1, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0,
    sensitive: false, pr: null, plan: null, pendingFixInput: null, postponedUntil: null, resumeStage: null, conflictPending: false,
    track: "issue", rescues: 0, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 0, decideReturns: 0, history: [],
    rescueRun: false, specMode: null, specProblem, question: null, askingStage: null, answer: null, answerQuestionId: null, answerQuestionIds: [], answerKind: null,
    pendingAnswer: null, recordIds: [], recordKind: null, recordAnswer: false, decideInput: null, decidedQuestion: null, parkedPr: null, pendingSince: null, checksRerun: false, securityPass: false,
    chainFailures: null, chainErrors: 0,
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

/** The answer fields an unrecorded answer (T4) restores when no other answer is in hand, so its spec PR must carry its mark. */
function restorePending(s: ChainState): Partial<ChainState> {
  const p = s.pendingAnswer;
  if (!p || s.recordIds.length) return {};
  return { answer: p.text, answerQuestionIds: [...p.ids], answerQuestionId: p.ids[p.ids.length - 1], answerKind: p.kind, recordIds: [...p.ids], recordKind: p.kind };
}

/** Every entry into the spec stage goes through here and sets the spec track; an unrecorded answer comes along (T4). */
function toSpec(state: ChainState, mode: SpecMode, patch: Partial<ChainState> = {}): Step {
  return run({ ...state, track: "spec", specMode: mode }, "spec", {}, { ...patch, ...restorePending({ ...state, ...patch }) });
}

/** A fresh plan, unless an answer is still unrecorded (T4): then the spec stage records it first, and plan runs after that merge. */
function toPlan(state: ChainState, patch: Partial<ChainState> = {}): Step {
  if ({ ...state, ...patch }.pendingAnswer) return toSpec(state, "record", patch);
  return run(state, "plan", {}, patch);
}

/** C5: the review pass the state is in; the security pass runs under the security profile. */
function reviewProfile(state: ChainState): { profile?: "security" } {
  return state.securityPass ? { profile: "security" } : {};
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
  // The PR is closed: its fix input, conflict and rescue flag go with it, and so do a decide-mode input, an ADR requirement on its
  // run and the answer it was applying (T-minor 3); an answer not yet recorded on main stays in `pendingAnswer` (T4).
  const dropPr: Partial<ChainState> = {
    pr: null, pendingFixInput: null, conflictPending: false, rescueRun: false, decideInput: null, decidedQuestion: null, recordAnswer: false, securityPass: false,
    answer: null, answerQuestionId: null, answerQuestionIds: [], answerKind: null, recordIds: [], recordKind: null,
  };
  const close = (why: string): Action[] => (s.pr ? [{ type: "close_pr", pr: s.pr.number, branch: branchOf(s), comment: `${why}${clip(reason)}` }] : []);
  if (s.replans < MAX_REPLANS) {
    const next = toPlan(s, { ...dropPr, plan: null, fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0, replans: s.replans + 1 });
    return { state: next.state, actions: [...close("Closed by the scheduler to re-plan: "), ...next.actions] };
  }
  if (s.specRevisions < MAX_SPEC_REVISIONS) {
    const next = toSpec(s, "revise", { ...dropPr, specRevisions: s.specRevisions + 1 });
    return { state: next.state, actions: [...close("Closed by the scheduler to revise the spec: "), ...next.actions] };
  }
  return abandon(s, stuck);
}

function boundsText(s: ChainState): string {
  return `rescue ${s.rescues}/${MAX_RESCUES}, spec-track rescue ${s.specRescues}/${MAX_RESCUES}, re-plan ${s.replans}/${MAX_REPLANS}, spec revision ${s.specRevisions}/${MAX_SPEC_REVISIONS}, chain-error release ${s.chainErrors}/${MAX_CHAIN_ERRORS}`;
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
function decideYourself(state: ChainState, asking: AskingStage, reasoning: string, sentBack: Question | null = state.question): Step {
  const question = state.question;
  const s = { ...state, decideReturns: state.decideReturns + 1, question: null };
  if (asking === "verify" || s.decideReturns > MAX_DECIDE_RETURNS) return escalateAsker(s, asking, `decide_yourself: ${reasoning}`, question);
  return resume(s, asking, { decideInput: reasoning, decidedQuestion: sentBack }, "decide");
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Tm1: the shortest quote of the reply a follow-up may rest on, after whitespace is collapsed. */
export const FOLLOW_UP_QUOTE_MIN = 15;
/** Tm1: a quoted request starts with one of these words (or the quote contains a question mark). */
const REQUEST_WORDS = ["can", "could", "would", "will", "please", "tell", "explain", "clarify", "say", "what", "which", "why", "how", "when", "where", "who", "is", "are", "do", "does", "should"];

/** The maintainer's latest reply as written: the last part of the joined answer, without its "Question #<id>: " prefix. */
function latestReply(answer: string): string {
  const parts = answer.split(/(?:^|\n\n)Question #\d+: /);
  return parts[parts.length - 1];
}

/**
 * C2, Tm1, AC-15: a follow-up answers the maintainer's reply, which asked something back. It says so (`follow_up`) and
 * quotes the part of the latest reply it answers: at least FOLLOW_UP_QUOTE_MIN characters, found in that reply as
 * written, and itself a question or a request (a "?" in it, or a first word from REQUEST_WORDS).
 */
function isFollowUp(state: ChainState, q: Question): boolean {
  if (q.follow_up !== true || state.answer === null || q.reply_quote === undefined) return false;
  const quote = squash(q.reply_quote);
  const asks = quote.includes("?") || REQUEST_WORDS.includes(quote.split(" ")[0].replace(/[^a-z]/g, ""));
  return quote.length >= FOLLOW_UP_QUOTE_MIN && asks && squash(latestReply(state.answer)).includes(quote);
}

/**
 * A stage's result carries a question (AC-12, AC-14, AC-15, AC-17). Decide mode comes first (Tm1): only a question marked
 * `new_blocker` goes on, to the question check, which sees the question sent back (CM2); anything else fails the run.
 * Otherwise a follow-up pauses at once, and any other question goes to the check.
 */
function ask(state: ChainState, stage: Stuck, question: Question): Step {
  if (state.decideInput !== null) {
    if (question.new_blocker !== true) return failedInDecideMode(state, stage);
    return run({ ...state, rescueRun: false }, "question-check", {}, { question, askingStage: stage });
  }
  if (isFollowUp(state, question)) return pause({ ...state, rescueRun: false }, question, stage);
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
  const s: ChainState = { ...state, rescueRun: false, decideInput: null, decidedQuestion: null, answer: null };
  if (state.track === "issue") Object.assign(s, { answerQuestionId: null, answerQuestionIds: [], answerKind: null });
  // TI1: a spec or fix run that succeeded with answers to record carried every mark (the driver refuses one without).
  if (stage === "spec" || stage === "fix" || state.track === "issue") Object.assign(s, { recordIds: [], recordKind: null });
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
        // Section 4: the follow-up row comes first (T-minor 2); then kind other is a bound hit with a rescue fix (AC-8).
        if (r.escalation && isFollowUp(state, r.escalation)) return ask(state, "review", r.escalation);
        if (!r.escalation || r.escalation.kind === "other") {
          return escalate(settle(state, "review"), "fix", `review escalated: ${r.escalation?.question ?? "no escalation object"}`, escalationInput("Review", r.escalation));
        }
        return ask(state, "review", r.escalation);
      }
      const s = settle(state, "review");
      const sensitive = s.sensitive || event.sensitive === true;
      const text = `Review requested changes:\n${r.findings_on_pr.map((f, i) => `${i}. [${f.criterion}] ${f.file}:${f.line} ${f.scenario}`).join("\n")}`;
      // AC-9: findings from either review on a sensitive diff go through the fix loop; the next round runs both reviews again.
      if (sensitive && r.findings_on_pr.length > 0) return toFix(note({ ...s, securityPass: false }, text), text);
      if (r.verdict !== "approve") return toFix(note({ ...s, securityPass: false }, text), text);
      // C5: on a sensitive diff the normal review's approval is followed by the security review; both must approve.
      if (sensitive && !s.securityPass && !event.security) return run({ ...s, securityPass: true }, "review", { profile: "security" });
      return { state: { ...s, stage: "merge", securityPass: false }, actions: [{ type: "merge" }] };
    }
    case "spec": {
      const r = event.result;
      if (r.verdict === "question") {
        if (!r.question) throw new Error(`spec question without a question object (issue ${state.issue})`);
        if (r.question.kind !== "other") return ask(state, "spec", r.question);
        // AC-14: kind other is not sent to the check; in decide mode it is a failed run like any question.
        if (state.decideInput !== null) return failedInDecideMode(state, "spec");
        return decideYourself({ ...state, rescueRun: false }, "spec", KIND_OTHER_REASONING, r.question);
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
      if (event.result.verdict === "send") {
        // C10: the strong-tier check's wording is what the maintainer reads; the kind stays the asking stage's, which routes the answer.
        const worded = event.result.question;
        return pause(state, worded ? { kind: question.kind, question: worded.question, options: worded.options, recommendation: worded.recommendation } : question, askingStage);
      }
      return decideYourself(state, askingStage, event.result.reasoning);
    }
  }
}

/** AC-17: the question the verify bound raises after the re-run and the investigating fix. */
function neverReported(pr: number, names: string): Question {
  return {
    kind: "capability",
    question: `A required check never reported on PR #${pr}: ${names}. The scheduler re-ran it and a fix investigated its workflow; it stayed pending for another ${VERIFY_PENDING_MAX_H} hours.`,
    // C9: only what agents cannot do is the maintainer's; dropping an obsolete check is a change agents make in a reviewed PR.
    options: [
      { label: "fixed, re-check", cost: `you fix the cause outside the repository (runner, app permissions, workflow settings); verify waits up to ${VERIFY_PENDING_MAX_H} more hours` },
    ],
    recommendation: "fixed, re-check, once the cause outside the repository is fixed",
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
      const input = `Required checks ${names} have been pending for ${VERIFY_PENDING_MAX_H} hours on ${sha}; the scheduler has re-run those it could. Investigate why they never report: the workflow files and triggers that should produce them, and whether each check has a run. Fix the cause if it is in this repository; otherwise change nothing and say so. If a check is obsolete (nothing produces it any more and nothing it guards remains), record a finding that names its \`required_checks\` entry in agents/scheduler.yaml for removal, a change agents make in their own reviewed PR; do not edit that file here.`;
      const next = toFix(checked, input, { checksRerun: true, pendingSince: null });
      return { state: next.state, actions: [{ type: "rerun_checks", sha }, ...next.actions] };
    }
    return run(checked, "question-check", {}, { question: neverReported(checked.pr.number, names), askingStage: "verify", pendingSince: null });
  }
  // Verify moves on: the window closes, and a reply that resumed verify is no longer an input (AC-18).
  const moved: ChainState = { ...checked, pendingSince: null, checksRerun: false, answer: null, securityPass: false };
  if (state.track === "issue") Object.assign(moved, { answerQuestionId: null, answerQuestionIds: [], answerKind: null, recordIds: [], recordKind: null });
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
    rescueRun: false, specProblem: null, specMode: null, decideInput: null, decidedQuestion: null, answer: null, answerQuestionId: null, answerQuestionIds: [], answerKind: null,
    recordIds: [], recordKind: null,
    recordAnswer: false, securityPass: false,
    // T4: a merged spec PR on this chain carried the unrecorded answer (the driver refused one without its mark).
    pendingAnswer: null,
  };
  const after = (next: Step): Step => ({ state: next.state, actions: [deleteBranch, ...next.actions] });
  if (gate.ok) {
    const base: ChainState = { ...state, ...fresh, track: "issue" };
    if (state.parkedPr) {
      return after(toFix({ ...base, pr: state.parkedPr, parkedPr: null },
        `Apply the maintainer's decision to ${state.answerQuestionIds.map((id) => `question #${id}`).join(", ")}, now recorded on main. Read it in the spec and the top designs, then change this PR to follow it.`));
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
    state: { ...state, ...fresh, stage: "released", pr: null, parkedPr: null },
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

const KIND_STRENGTH: Question["kind"][] = ["other", "capability", "technical", "product"];
const strongest = (a: Question["kind"] | null, b: Question["kind"]): Question["kind"] => (a !== null && KIND_STRENGTH.indexOf(a) > KIND_STRENGTH.indexOf(b) ? a : b);

/**
 * AC-18: the routes of the five `paused` rows of spec section 4. T3: a reply to a question asked while an earlier answer
 * was still unspent adds to it: every id is kept, the texts are joined, and the strongest kind routes and is recorded.
 */
function answered(state: ChainState, event: Extract<ChainEvent, { type: "answered" }>): Step {
  const { question, askingStage: asking } = state;
  if (!question || !asking) throw new Error(`paused without a question (issue ${state.issue})`);
  const id = event.questionId;
  const reply = `Question #${id}: ${event.answer}`;
  const ids = [...state.answerQuestionIds, id];
  const answer = state.answer === null ? reply : `${state.answer}\n\n${reply}`;
  // TI1: a product or technical answer must be recorded, and so must a follow-up's answer while the decision it
  // completes is unrecorded. The kind that routes is the strongest of the answers still to record, not of answers
  // already recorded: a later capability answer on a spec PR is not a decision to record.
  const decisionKind = question.kind === "product" || question.kind === "technical" ? question.kind : null;
  const recordable = decisionKind !== null || (question.follow_up === true && state.recordIds.length > 0);
  const recordKind = recordable ? (strongest(state.recordKind, decisionKind ?? state.recordKind!) as "product" | "technical") : state.recordKind;
  const recordIds = recordable ? [...new Set([...state.recordIds, id])] : state.recordIds;
  const before = state.answer ?? state.pendingAnswer?.text ?? null;
  const pendingAnswer: PendingAnswer | null = recordable
    ? {
      ids: [...new Set([...(state.pendingAnswer?.ids ?? []), ...recordIds])],
      kind: strongest(state.pendingAnswer?.kind ?? null, recordKind!) as "product" | "technical",
      text: before === null ? reply : `${before}\n\n${reply}`,
    }
    : state.pendingAnswer;
  // Tm2: an answer ends decide mode; the stage runs again with the answer, not the earlier reasoning.
  const s: ChainState = {
    ...state, answer, answerQuestionId: id, answerQuestionIds: ids, answerKind: strongest(state.answerKind, question.kind), recordIds, recordKind,
    pendingAnswer, question: null, decideInput: null, decidedQuestion: null,
  };
  if (asking === "spec") return resume(s, "spec", {}, s.specMode === "decide" ? "write" : undefined);
  // A capability answer is not a decision: the asking stage runs again with it, and nothing is recorded.
  if (!recordable) return resume(s, asking);
  const decision = `${question.question}\nAnswer: ${event.answer}`;
  const marks = recordIds.map((r) => `(maintainer answer, question #${r})`).join(", ");
  if (asking === "review" || asking === "fix") {
    // On a spec PR the decision is recorded in that PR; there is no issue PR to park.
    if (s.track === "spec") {
      return toFix(s, `Record the maintainer's decision in this spec PR, marked ${marks}, then apply it:\n${decision}`);
    }
    if (recordKind === "product") return toSpec({ ...s, parkedPr: s.pr, pr: null }, "record");
    return toFix(s, `Record the maintainer's decision as an ADR under docs/decisions/, marked ${marks}, then apply it:\n${decision}`, { recordAnswer: true });
  }
  return toSpec(s, "record");
}

/**
 * A release (liveness, C7 chain errors). AC-21: a released spec track frees `spec-<issue>` for the next spec PR, and a
 * parked issue PR is closed so the next claim can open `issue-<issue>`. An unrecorded answer stays in the ledger (T4).
 */
function releaseClaim(state: ChainState, why: string, text: string, gate: string, reason: string, extra: Action[] = []): Step {
  const closeComment = `Closed by the scheduler: the claim was released ${why}.`;
  const closes: Action[] = [];
  if (state.track === "spec") {
    closes.push(state.pr ? { type: "close_pr", pr: state.pr.number, branch: branchOf(state), comment: closeComment } : { type: "delete_branch", branch: branchOf(state) });
  }
  if (state.parkedPr) closes.push({ type: "close_pr", pr: state.parkedPr.number, branch: `issue-${state.issue}`, comment: closeComment });
  return {
    state: { ...state, stage: "released", ...(state.track === "spec" ? { pr: null } : {}), parkedPr: null },
    actions: [
      ...closes,
      { type: "comment", text },
      { type: "label", add: [], remove: [CLAIM_LABEL] },
      ...extra,
      { type: "notify", gate, label: "", text },
      { type: "release", reason, savePatch: true },
    ],
  };
}

/** The stage a chain error is charged to (C7): the agent stage it was in or waiting to resume, else fix (verify, merge) or plan. */
export function stuckOf(s: ChainState): Stuck {
  const stage = s.stage === "waiting" ? s.resumeStage : s.stage;
  if (stage === "question-check") return s.askingStage && s.askingStage !== "verify" ? s.askingStage : "fix";
  if (stage === "plan" || stage === "implement" || stage === "review" || stage === "fix" || stage === "spec") return stage;
  return s.stage === "claimed" ? "plan" : "fix";
}

/** C7: the driver failed on this chain again and again. The first time the claim is released with the error; after that the issue is abandoned. */
function chainError(state: ChainState, error: string): Step {
  const s = note({ ...state, chainFailures: null }, `chain error in ${state.stage}: ${error}`);
  if (s.chainErrors >= MAX_CHAIN_ERRORS) return abandon(s, stuckOf(s));
  const shown = clip(error).replaceAll("@", "(at)");
  const text = [
    "Claim released: the scheduler failed on this issue repeatedly. The last error:",
    "",
    "```", shown, "```",
    "",
    "Uncommitted work was saved as a patch in the scheduler state directory. The issue is claimed again on a later poll; another release like this abandons it.",
  ].join("\n");
  const finding: Action = {
    type: "finding", stage: stuckOf(s),
    finding: { what: "chain released after repeated scheduler errors", where: `issue #${s.issue}, stage ${state.stage}`, evidence: error, noticed_how: "scheduler chain error" },
  };
  return releaseClaim({ ...s, chainErrors: s.chainErrors + 1 }, "after repeated scheduler errors", text, "chain_error", "chain error", [finding]);
}

export function transition(state:ChainState,event:ChainEvent):Step {
 if(state.conversation&&(event.type==='stage_ok'||event.type==='stage_failed')){
  const c=state.conversation;
  const result=event.type==='stage_ok'?event.result as unknown as {conversation?:string;decision?:string;escalation?:Question}:null;
  if(result?.escalation&&isFollowUp(state,result.escalation))return pause({...state,conversation:null},result.escalation,c.asking);
  if(result?.conversation==='settled'||c.retried){
   const decision=result?.conversation==='settled'?result.decision??null:null;
   return {state:{...c.next,decision,conversation:null,resumeSession:null},actions:[{type:'thread_reply',text:decision?`Settled: ${decision.split('\n')[0]}; recording it next`:'Settled: continuing with your answer'},...c.actions]};
  }
  return {state:{...state,conversation:{...c,retried:true}},actions:[{type:'thread_reply',text:`The ${c.asking} run failed; the chain retries`},{type:'run_stage',stage:c.asking,attempt:state.attempt,conversation:true}]};
 }
 const next=baseTransition(state,event);
 if(event.type==='answered'&&state.resumeSession&&state.askingStage!=='verify'){
  const asking=state.askingStage!;
  const action=next.actions.find(a=>a.type==='run_stage');
  if(!action||(action.type==='run_stage'&&action.stage!==asking)){
   return {state:{...next.state,stage:asking,track:state.track,pr:state.pr,specMode:state.specMode,askingStage:asking,conversation:{asking,retried:false,next:{...next.state,resumeSession:null},actions:next.actions},resumeSession:state.resumeSession},actions:[{type:'run_stage',stage:asking,attempt:state.attempt,conversation:true}]};
  }
 }
 if(state.answer&&(event.type==='stage_ok'||event.type==='stage_failed')&&!(event.type==='stage_ok'&&'escalation' in event.result&&event.result.escalation)&&!next.actions.some(a=>a.type==='pause')&&next.state.stage!=='question-check'){
  const result=event.type==='stage_ok'?event.result as unknown as {pr_number?:number}:null;
  const text=event.type==='stage_failed'?`The ${event.stage} run failed; the chain retries`:event.stage==='spec'&&result?.pr_number?`Done: recorded in PR #${result.pr_number}`:'Done: continuing with your answer';
  next.actions.unshift({type:'thread_reply',text});
 }
 return next;
}

function baseTransition(state: ChainState, event: ChainEvent): Step {
  if (event.type === "liveness_expired" || event.type === "chain_error") {
    if (ENDED.includes(state.stage)) invalid(state, event);
    if (event.type === "chain_error") return chainError(state, event.error);
    const text = "Claim released: no run in flight and no activity for the liveness window. Uncommitted work was saved as a patch in the scheduler state directory.";
    return releaseClaim(state, "by liveness", text, "liveness", "liveness expired");
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
      if (event.type === "start") return state.specProblem ? toSpec(state, "write") : toPlan(state);
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
          return { state: { ...state, stage: "done", pendingAnswer: null }, actions: [{ type: "label", add: [], remove: [CLAIM_LABEL] }, { type: "done" }] };
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
