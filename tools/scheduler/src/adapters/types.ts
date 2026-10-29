import type { RunOutcome } from "../state/runs.ts";
import type { AgentStageName, Bounds, Harness, Profile } from "../types.ts";

export interface StageRun {
  resume?:{sessionId:string};
  conversation?:boolean;
  runId: string;
  stage: AgentStageName;
  attempt: number;
  issue: number;
  prompt: string;
  model: string;
  bounds: Bounds;
  worktree: string;
  sessionId: string;
  resultPath: string;
  profile: Profile | null;
  effort?: string;
}

export interface Usage {
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  tool_calls: number;
}

export interface Judgement {
  outcome: RunOutcome;
  reason: string | null;
  apiErrorStatus: number | null;
  finalText: string | null;
}

export interface Command {
  argv: string[];
  env: Record<string, string>;
}

export interface Adapter {
  harness: Harness;
  /** Spec 013: the vendor whose quota a run counts against, when `harness` is not one (a test's fake harness). */
  quotaHarness?: Harness;
  buildCommand(run: StageRun): Command;
  judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement;
  usage(events: unknown[]): Usage;
  /** True for a record that ends one agent turn; the runner counts these against bounds.max_turns. */
  isTurnEnd?(event: unknown): boolean;
  /**
   * True for a stage whose run has no tool that writes files on this harness: when its result file is missing, the
   * runner takes the result from the last JSON object in the final assistant text instead (final review T1).
   */
  resultInText?(stage: AgentStageName): boolean;
}

export type { RunOutcome };
