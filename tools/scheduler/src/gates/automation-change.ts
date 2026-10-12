import type { ParsedSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { latestLabelActor } from "./authority.ts";
import { ignore, pass, type GateResult } from "./types.ts";

const AUTOMATION_PREFIXES = ["tools/scheduler/", "agents/", ".github/"];

export function touchesAutomation(spec: ParsedSpec): boolean {
  return spec.listedPaths.some((p) => {
    const dir = p.endsWith("/") ? p : p + "/";
    return AUTOMATION_PREFIXES.some((a) => p === a || p.startsWith(a) || a.startsWith(dir));
  });
}

export function automationChangeGate(issue: IssueData, spec: ParsedSpec, maintainer: string, validatedLabel: string): GateResult {
  if (!touchesAutomation(spec)) return pass;
  if (latestLabelActor(issue.labelEvents, validatedLabel) === maintainer) return pass;
  return ignore(`automation change: ${validatedLabel} must be set by the maintainer (process-spec section 5)`);
}
