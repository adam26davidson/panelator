import { specPathFromIssueBody } from "../spec/link.ts";
import { parseChildren, parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { label, pass, type GateResult } from "./types.ts";

export const NEEDS_SPEC = "needs-spec";

/**
 * `specText` is the file content on main, or null when it does not exist there.
 * `readRepoFile` reads any repo-relative file on main, null when absent (AC-23).
 */
export function specPresentGate(issue: IssueData, specText: string | null, readRepoFile: (path: string) => string | null): GateResult {
  const path = specPathFromIssueBody(issue.body);
  if (!path) return label(NEEDS_SPEC, "issue body has no `Spec: specs/NNN-slug/spec.md` line");
  if (specText === null) return label(NEEDS_SPEC, `${path} not found on main`);
  const parsed = parseSpec(specText);
  if (parsed.missing.length) return label(NEEDS_SPEC, `${path} is missing: ${parsed.missing.join("; ")}`);
  if (!parsed.parent) return label(NEEDS_SPEC, `${path} has no Parent: line`);
  const parentText = readRepoFile(parsed.parent);
  if (parentText === null) return label(NEEDS_SPEC, `Parent ${parsed.parent} of ${path} not found on main`);
  if (!(parseChildren(parentText) ?? []).includes(path)) {
    return label(NEEDS_SPEC, `Parent ${parsed.parent} does not list ${path} in its Children section`);
  }
  return pass;
}
