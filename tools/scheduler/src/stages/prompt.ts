import type { PlanResult, SpecMode } from "../types.ts";

export interface StageInput {
  issue: { number: number; title: string; body: string };
  spec: string;
  plan?: PlanResult;
  pr?: { number: number; head_sha: string; url: string };
  ci?: string;
  findings?: string;
  fix_input?: string;
  history?: string;
  question?: string;
  answer?: string;
  mode?: SpecMode;
  decide_input?: string;
  spec_problem?: string;
  answered_questions?: string;
  held_work?: string;
  result_path: string;
  profile_instructions: string;
}

const NONE = "(none)";

export function renderPrompt(template: string, input: StageInput): string {
  const values: Record<string, string> = {
    issue: `#${input.issue.number} ${input.issue.title}\n\n${input.issue.body}`,
    spec: input.spec,
    plan: input.plan ? JSON.stringify(input.plan, null, 2) : NONE,
    pr: input.pr ? `#${input.pr.number} ${input.pr.head_sha} ${input.pr.url}` : NONE,
    ci: input.ci ?? NONE,
    findings: input.findings ?? NONE,
    fix_input: input.fix_input ?? NONE,
    history: input.history ?? NONE,
    question: input.question ?? NONE,
    answer: input.answer ?? NONE,
    mode: input.mode ?? NONE,
    decide_input: input.decide_input ?? NONE,
    spec_problem: input.spec_problem ?? NONE,
    answered_questions: input.answered_questions ?? NONE,
    held_work: input.held_work ?? NONE,
    result_path: input.result_path,
    profile_instructions: input.profile_instructions,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder {{${key}}}`);
    return values[key];
  });
}
