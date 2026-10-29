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
  decision?: string;
  mode?: SpecMode;
  decide_input?: string;
  spec_problem?: string;
  answered_questions?: string;
  held_work?: string;
  result_path: string;
  profile_instructions: string;
}

export function renderReplyPrompt(input:{answer:string;mode:string;result_path:string;conversation?:boolean;stage:string}):string {
 return [input.answer,`Continue ${input.stage} in ${input.mode} mode.`,input.conversation?'This is a conversation turn: read only; change nothing in the worktree. Answer using what you learned before asking. Return a follow-up escalation only when the reply asks a question or requests detail (follow_up: true, reply_quote copied exactly, at least 15 characters); otherwise return {"conversation":"settled","decision":"the decision in the maintainer’s terms, with its reasons","findings":[]}.':'Continue your work with the answer, following the stage result schema.',`Write the result to ${input.result_path}. If you have no write tool return the JSON as your final response.`].join('\n\n');
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
    decision: input.decision ?? NONE,
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
