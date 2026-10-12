import type { IssueData } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

export function validatedGate(issue: IssueData, validatedLabel: string): GateResult {
  return issue.labels.includes(validatedLabel) ? pass : ignore(`${validatedLabel} label absent`);
}
