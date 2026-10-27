export type Harness = "claude" | "pi" | "fake";
export type Tier = "strong" | "standard";
export type AgentStageName = "plan" | "implement" | "review" | "fix" | "spec" | "question-check";
export type StageName = AgentStageName | "verify" | "merge";

export interface Bounds {
  timeout_min: number;
  max_turns: number;
  max_cost_usd: number;
}

export function isBounds(x: unknown): x is Bounds {
  if (typeof x !== "object" || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.timeout_min === "number" &&
    typeof b.max_turns === "number" &&
    typeof b.max_cost_usd === "number"
  );
}

export interface StageDefinition {
  name: AgentStageName;
  kind: "agent";
  harness: Exclude<Harness, "fake">;
  model: string;
  fallback?: string;
  /** AC-26: an independent stage may name a fallback even on the strong tier. */
  independent?: boolean;
  tier: Tier;
  effort?: string;
  bounds: Bounds;
  permission: "no-prompt";
  worktree: "issue" | "fresh";
  profile: "from-issue" | "none" | string;
  input: string;
  output: string;
  prompt: string;
}

/** A labelling event from the issue timeline, oldest first. */
export interface LabelEvent {
  label: string;
  actor: string;
  action: "labeled" | "unlabeled";
  at: string;
}

export interface IssueData {
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  labelEvents: LabelEvent[];
  createdAt: string;
}

export type SpecMode = "write" | "answer" | "revise" | "decide" | "record";
export type AskingStage = "plan" | "implement" | "review" | "fix" | "spec" | "verify";

export interface Question {
  kind: "product" | "technical" | "capability" | "other";
  question: string;
  options: { label: string; cost: string }[];
  recommendation: string;
}

/** A plan, implement or fix result that carries only an escalation (AC-17). Never of kind "other". */
export interface EscalationOnly {
  escalation: Question;
  findings?: Finding[];
}

export interface SpecResult {
  verdict: "revised" | "question";
  spec_path?: string;
  pr_number?: number;
  head_sha?: string;
  question?: Question;
  findings?: Finding[];
}

export interface QuestionCheckResult {
  verdict: "send" | "decide_yourself";
  reasoning: string;
  findings?: Finding[];
}

export interface PlanTask {
  id: string;
  description: string;
  files: string[];
}

export interface PlanResult {
  verdict: "ready" | "spec_gap";
  domain: string;
  tasks: PlanTask[];
  questions?: string[];
  escalation?: Question;
  findings?: Finding[];
}

export type PlanOutcome = PlanResult | EscalationOnly;

export interface ImplementResult {
  pr_number: number;
  head_sha: string;
  tasks_done: string[];
  escalation?: Question;
  findings?: Finding[];
}

export type ImplementOutcome = ImplementResult | EscalationOnly;

export interface ReviewFinding {
  criterion: string;
  file: string;
  line: number;
  scenario: string;
}

export interface ReviewResult {
  verdict: "approve" | "changes_requested" | "escalate";
  findings_on_pr: ReviewFinding[];
  declined_to_judge: string[];
  escalation?: Question;
  findings?: Finding[];
}

export interface FixResult {
  head_sha: string;
  addressed: number[];
  escalation?: Question;
  findings?: Finding[];
}

export type FixOutcome = FixResult | EscalationOnly;

export interface Finding {
  what: string;
  where: string;
  evidence: string;
  suspected_cause?: string;
  noticed_how: string;
  security?: boolean;
}

export interface Profile {
  name: string;
  dir: string;
  skillsDir: string;
  instructions: string;
  tools: string[];
  credentialHook?: string;
  reviewCriteria?: string;
}
