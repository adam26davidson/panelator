import { specPathFromIssueBody } from "../spec/link.ts";
import { parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_SPEC = "needs-spec";

/** `specText` is the file content on main, or null when it does not exist there. */
export function specPresentGate(issue: IssueData, specText: string | null): GateResult {
  const path = specPathFromIssueBody(issue.body);
  if (!path) return label(NEEDS_SPEC, "issue body has no `Spec: specs/NNN-slug/spec.md` line");
  if (specText === null) return label(NEEDS_SPEC, `${path} not found on main`);
  const parsed = parseSpec(specText);
  if (parsed.missing.length) return label(NEEDS_SPEC, `${path} is missing: ${parsed.missing.join("; ")}`);
  return pass;
}
