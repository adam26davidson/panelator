import type { RunOutcome } from "../state/runs.ts";
import type { AgentStageName, Bounds, Harness, Profile } from "../types.ts";

export interface StageRun {
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
  buildCommand(run: StageRun): Command;
  judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement;
  usage(events: unknown[]): Usage;
}

export type { RunOutcome };
