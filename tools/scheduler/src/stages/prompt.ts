import type { PlanResult } from "../types.ts";

export interface StageInput {
  issue: { number: number; title: string; body: string };
  spec: string;
  plan?: PlanResult;
  pr?: { number: number; head_sha: string; url: string };
  ci?: string;
  findings?: string;
  fix_input?: string;
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
    result_path: input.result_path,
    profile_instructions: input.profile_instructions,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`unknown placeholder {{${key}}}`);
    return values[key];
  });
}
