import type { ScopeResult } from "../gates/scope.ts";
import type { AgentStageName, FixResult, ImplementResult, PlanResult, ReviewResult } from "../types.ts";

export type ChainStage =
  | "claimed" | "plan" | "implement" | "verify" | "review" | "fix" | "merge"
  | "done" | "released" | "needs-human" | "waiting";

export interface ChainState {
  issue: number;
  stage: ChainStage;
  attempt: number;
  fixes: number;
  scopeViolations: number;
  planFailures: number;
  implementFailures: number;
  securityFinding: boolean;
  sensitive: boolean;
  pr: { number: number; head_sha: string } | null;
  plan: PlanResult | null;
  pendingFixInput: string | null;
  postponedUntil: string | null;
  resumeStage: AgentStageName | null;
}

export type ChainEvent =
  | { type: "start" }
  | { type: "stage_ok"; stage: "plan"; result: PlanResult }
  | { type: "stage_ok"; stage: "implement"; result: ImplementResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "fix"; result: FixResult; scope: ScopeResult }
  | { type: "stage_ok"; stage: "review"; result: ReviewResult; security: boolean }
  | { type: "stage_failed"; stage: AgentStageName; reason: string; postpone?: boolean }
  | { type: "checks"; status: "green" | "failed" | "pending"; log?: string; sensitive: boolean }
  | { type: "merge_result"; status: "merged" | "not_mergeable"; detail?: string }
  /** AC-11: a security-review label on the issue or PR refuses the merge; valid only in stage merge. */
  | { type: "merge_blocked"; reason: string }
  | { type: "rebase_conflict"; detail: string }
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
  | { type: "done" };
