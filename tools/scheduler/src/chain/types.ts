import type { ScopeResult } from "../gates/scope.ts";
import type {
  AgentStageName, AskingStage, Finding, FixResult, ImplementResult, PlanResult, Question, QuestionCheckResult, ReviewResult, SpecMode, SpecResult,
} from "../types.ts";

export type ChainStage =
  | "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge" | "spec" | "question-check"
  | "done" | "released" | "waiting" | "paused" | "abandoned";

export interface ChainState {
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
  /** C1: set by a rebase conflict, cleared by the next successful fix; the driver skips the rebase while it is set. */
  conflictPending: boolean;
  /** Which PR the chain works on: the issue PR (`issue-<issue>`) or a spec PR (`spec-<issue>`). Every entry into the spec stage sets "spec". */
  track: "issue" | "spec";
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
  question: Question | null;
  askingStage: AskingStage | null;
  answer: string | null;
  answerQuestionId: number | null;
  answerKind: Question["kind"] | null;
  recordAnswer: boolean;
  decideInput: string | null;
  /** An issue PR parked while a spec PR records an answer (AC-18). */
  parkedPr: { number: number; head_sha: string } | null;
  pendingSince: string | null;
  checksRerun: boolean;
}

export type ChainEvent =
  | { type: "start" }
  | { type: "stage_ok"; stage: "plan"; result: PlanResult }
  | { type: "stage_ok"; stage: "implement"; result: ImplementResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "fix"; result: FixResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "review"; result: ReviewResult; security: boolean }
  | { type: "stage_ok"; stage: "spec"; result: SpecResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "question-check"; result: QuestionCheckResult }
  | { type: "stage_failed"; stage: AgentStageName; reason: string; postpone?: boolean }
  /** `at`: when the checks were read; `pending`: the required checks still pending or missing. */
  | { type: "checks"; status: "green" | "failed" | "pending"; log?: string; sensitive: boolean; at: string; pending?: string[] }
  /** `specGate`: on the spec track, spec-present and the UI-design gate run again on origin/main after the merge (AC-4). */
  | { type: "merge_result"; status: "merged" | "not_mergeable"; detail?: string; specGate?: { ok: true } | { ok: false; gate: "spec-present" | "ui-design"; reason: string } }
  | { type: "rebase_conflict"; detail: string }
  /** The PR head moved after verify and review; valid only in stage merge, which goes back to verify. */
  | { type: "head_moved"; head_sha: string }
  | { type: "answered"; answer: string; questionId: number }
  | { type: "liveness_expired" };

export type Action =
  | { type: "run_stage"; stage: AgentStageName; attempt: number; fixInput?: string; profile?: "security" }
  | { type: "verify" }
  | { type: "merge" }
  | { type: "label"; add: string[]; remove: string[]; target?: "pr" }
  | { type: "comment"; text: string }
  | { type: "notify"; gate: string; label: string; text: string }
  | { type: "release"; reason: string; savePatch: boolean }
  | { type: "wait"; seconds: number }
  | { type: "done" }
  /** Carries the PR and its branch: the new state has already dropped the PR when the driver applies it (review focus 6). */
  | { type: "close_pr"; pr: number; branch: string; comment: string }
  | { type: "delete_branch"; branch: string }
  | { type: "finding"; stage: AgentStageName; finding: Finding }
  | { type: "pause"; question: Question; asking: AskingStage }
  | { type: "rerun_checks"; sha: string };
