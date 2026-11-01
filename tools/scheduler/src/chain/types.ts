import type { ScopeResult } from "../gates/scope.ts";
import type {
  AgentStageName, AskingStage, DesignResult, Finding, FixOutcome, ImplementOutcome, PendingAnswer, PlanOutcome, PlanResult, Question, QuestionCheckResult, ReviewResult, SpecMode,
  SpecResult,
} from "../types.ts";

export type ChainStage =
  | "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge" | "spec" | "design" | "question-check"
  | "done" | "released" | "waiting" | "paused" | "abandoned";

export interface ChainState {
  resumeSession?:import('../state/paused.ts').AskingSession|null;
  conversation?: {asking:Exclude<AskingStage,'verify'>;retried:boolean;next:ChainState;actions:Action[]}|null;
  decision?:string|null;
  issue: number;
  stage: ChainStage;
  attempt: number;
  fixes: number;
  scopeViolations: number;
  planFailures: number;
  implementFailures: number;
  sensitive: boolean;
  pr: { number: number; head_sha: string } | null;
  plan: PlanResult | null;
  pendingFixInput: string | null;
  postponedUntil: string | null;
  resumeStage: AgentStageName | null;
  /**
   * C1: set by a rebase conflict, cleared by the next successful fix (spec 024: one that returns a new head) or by
   * `conflict_gone`; while it is set the driver only checks that the conflict is still real before the fix runs.
   */
  conflictPending: boolean;
  /**
   * Which PR the chain works on: the issue PR (`issue-<issue>`), a spec PR (`spec-<issue>`) or a design PR
   * (`design-<issue>`, spec 029). Every entry into the spec stage sets "spec"; every entry into the design stage "design".
   */
  track: "issue" | "spec" | "design";
  /** The escalation ledger (AC-7): kept per issue across releases. */
  rescues: number;
  specRescues: number;
  replans: number;
  specRevisions: number;
  specAnswers: number;
  decideReturns: number;
  history: string[];
  /** The current run is a rescue (AC-1): a failure escalates at once; any stage_ok clears it. */
  rescueRun: boolean;
  specMode: SpecMode | null;
  specProblem: string | null;
  /** Spec 029 AC-1: the UI-design gate's reason while the design track runs. */
  designProblem: string | null;
  /** Spec 029 AC-4: design runs after a merge that left the gate failing, and rescues on the design track (ledger fields). */
  designRevisions: number;
  designRescues: number;
  question: Question | null;
  askingStage: AskingStage | null;
  /** The maintainer's replies not yet spent, each prefixed "Question #<id>: " (T3: a follow-up chain accumulates them). */
  answer: string | null;
  /** The newest answered question; `answerQuestionIds` holds every id of the chain, and `answerKind` the strongest kind. */
  answerQuestionId: number | null;
  answerQuestionIds: number[];
  answerKind: Question["kind"] | null;
  /** T4: a product or technical answer not yet recorded on main; part of the ledger, so a release keeps it. */
  pendingAnswer: PendingAnswer | null;
  /** C3, CM2: the question the check sent back to decide, while decide mode lasts; a new blocker is checked against it. */
  decidedQuestion: Question | null;
  /**
   * TI1: the answered product or technical questions not yet recorded by a successful run, and their strongest kind.
   * `answerQuestionIds` is the history of the chain's answers; these are the ones a recording run must still mark.
   */
  recordIds: number[];
  recordKind: "product" | "technical" | null;
  /** C5: on a sensitive diff, review runs twice: the normal review, then (with this set) the security review. */
  securityPass: boolean;
  /** C7: the chain's consecutive driver errors, kept in the ledger so a restart does not reset them. */
  chainFailures: { count: number; last: string } | null;
  /** C7: releases for repeated chain errors on this issue (bounded like the escalation path). */
  chainErrors: number;
  recordAnswer: boolean;
  decideInput: string | null;
  /** An issue PR parked while a spec PR records an answer (AC-18). */
  parkedPr: { number: number; head_sha: string } | null;
  pendingSince: string | null;
  checksRerun: boolean;
  /** AC-1: the branch and head a stage left when its result carried a question; kept until a PR is bound on it or the attempt is discarded. */
  heldWork: { branch: string; head: string } | null;
}

export type ChainEvent =
  | { type: "start" }
  /** C14: a result with an `escalation` need not carry the stage's other fields, and its event carries no `scope` (AC-17). */
  | { type: "stage_ok"; stage: "plan"; result: PlanOutcome; head?: string }
  | { type: "stage_ok"; stage: "implement"; result: ImplementOutcome; scope?: ScopeResult; head?: string }
  | { type: "stage_ok"; stage: "fix"; result: FixOutcome; scope?: ScopeResult; head?: string }
  /** `security`: this run was the security review; `sensitive`: the reviewed diff touches a sensitive path (C5). */
  | { type: "stage_ok"; stage: "review"; result: ReviewResult; security: boolean; sensitive?: boolean }
  /** `scope`: the spec PR's scope check (AC-22), required for `revised`, absent for `question`. */
  | { type: "stage_ok"; stage: "spec"; result: SpecResult; scope?: ScopeResult; head?: string }
  /** Spec 029 AC-2: `scope` is the design PR's scope check, required for `designed`, absent for `question`. */
  | { type: "stage_ok"; stage: "design"; result: DesignResult; scope?: ScopeResult; head?: string }
  | { type: "stage_ok"; stage: "question-check"; result: QuestionCheckResult }
  | { type: "stage_failed"; stage: AgentStageName; reason: string; postpone?: boolean; /** Spec 013 AC-5: when the quota that postponed it resets. */ until?: string }
  /** `at`: when the checks were read; `pending`: the required checks still pending or missing. */
  | { type: "checks"; status: "green" | "failed" | "pending"; log?: string; sensitive: boolean; at: string; pending?: string[] }
  /** `specGate`: on the spec and design tracks, spec-present and the UI-design gate run again on origin/main after the merge (spec 006 AC-4, spec 029 AC-4). */
  | { type: "merge_result"; status: "merged" | "not_mergeable"; detail?: string; specGate?: { ok: true } | { ok: false; gate: "spec-present" | "ui-design"; reason: string } }
  | { type: "rebase_conflict"; detail: string }
  /** Spec 024: before a conflict-pending fix runs, the driver found origin/main no longer conflicts with the head. Valid only in that fix. */
  | { type: "conflict_gone" }
  /** The PR head moved after verify and review; valid only in stage merge, which goes back to verify. */
  | { type: "head_moved"; head_sha: string }
  | { type: "answered"; answer: string; questionId: number }
  | { type: "liveness_expired" }
  /** C7: the driver failed MAX_CHAIN_FAILURES times in a row on this chain; `error` is the last error. */
  | { type: "chain_error"; error: string };

export type Action =
  | {type:'thread_reply';text:string}
  | { type: "run_stage"; stage: AgentStageName; attempt: number; fixInput?: string; profile?: "security" | "design";conversation?:boolean }
  | { type: "verify" }
  | { type: "merge" }
  | { type: "label"; add: string[]; remove: string[]; target?: "pr" }
  | { type: "comment"; text: string }
  | { type: "notify"; gate: string; label: string; text: string }
  | { type: "release"; reason: string; savePatch: boolean }
  | { type: "wait"; seconds: number; /** Spec 013 AC-5: an absolute end of the wait, in place of `seconds`. */ until?: string }
  | { type: "done" }
  /** Carries the PR and its branch: the new state has already dropped the PR when the driver applies it (review focus 6). */
  | { type: "close_pr"; pr: number; branch: string; comment: string }
  | { type: "delete_branch"; branch: string }
  | { type: "finding"; stage: AgentStageName; finding: Finding }
  | { type: "pause"; question: Question; asking: AskingStage }
  | { type: "rerun_checks"; sha: string };
