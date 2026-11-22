/** The `console-state` document (schemas/scheduler/console-state.json, spec 051 AC-2). */
export interface Question {
  question_comment_id: number;
  issue: number;
  kind: string;
  text: string;
  options: string[];
  asked_at: string;
  status: "open" | "reminded" | "answered";
  answered_at?: string;
  question_url: string;
  decision_url?: string;
  telegram_url?: string;
}
interface Stage {
  name: string;
  status: "done" | "running" | "pending" | "failed";
}
export interface Claim {
  issue: number;
  title: string;
  stage: string;
  stages: Stage[];
  model: string;
  started_at: string;
  elapsed_s: number;
  cost_usd: number;
  pr?: number;
}
interface Bucket {
  bucket: string;
  value: number | null;
  n: number;
}
export interface Metric {
  name: string;
  goal: string;
  unit: string;
  direction: "lower" | "higher";
  introduced: string;
  description: string;
  rationale: string;
  status: "active" | "replaced" | "retired";
  replaced_by?: string;
  overlap_days_left?: number;
  buckets: Bucket[];
}
export interface ActionEntry {
  id: string;
  at: string;
  agent: string;
  kind: string;
  args: Record<string, unknown>;
  why: string;
  status: "pending" | "applied" | "refused" | "failed" | "undone";
  reason?: string;
  undo: { kind: string; args: Record<string, unknown> } | null;
  undoes?: string;
}
export interface Agent {
  name: string;
  last_run: string | null;
  next_run: string | null;
  cost_30d_usd: number;
  paused: boolean;
  paused_by: string | null;
}
export interface Parameter {
  name: string;
  type: "number" | "boolean" | "string" | "duration";
  value: unknown;
  mode: "auto" | "locked";
  min?: number;
  max?: number;
  description: string;
  at: string | null;
  set_by: string | null;
}
export interface ChangeEntry {
  id: number;
  kind: string;
  args: Record<string, unknown>;
  at: string;
  status: "pending" | "applied" | "refused";
  action_id?: string;
  reason?: string;
}
export interface ConsoleState {
  generated_at: string;
  /** owner/name of the repository, for links to issues and pull requests. */
  repo: string;
  tick_s: number;
  questions: Question[];
  current: Claim[];
  next_tick_at: string | null;
  up_next: { issue: number; title: string; class: string }[];
  tiles: {
    merged_per_week: number | null;
    issue_to_merge_days: number | null;
    rework_per_merge: number | null;
    aws: { actual_usd: number | null; forecast_usd: number | null; cap_usd: number | null };
  };
  metrics: { from: string; to: string; computed_at: string; metrics: Metric[] } | null;
  actions: ActionEntry[];
  agents: Agent[];
  parameters: Parameter[];
  changes: ChangeEntry[];
}

/** `GET /state`: the latest snapshot and its age (spec 051 AC-6). */
export interface StateResponse {
  login?: string;
  snapshot: ConsoleState | null;
  received_at: string | null;
  age_s: number | null;
}
export interface SentChange {
  id: number;
  kind: string;
  args: Record<string, unknown>;
  at: string;
}
