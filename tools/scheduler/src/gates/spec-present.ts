import { specPathFromIssueBody } from "../spec/link.ts";
import { parseChildren, parseSpec } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";
import { ignore, pass, type GateResult } from "./types.ts";

/**
 * Spec 006 AC-19: a failure labels nothing; the shortlist makes the issue eligible and its chain starts at the spec stage with the reason.
 * `specText` is the file content on main, or null when it does not exist there.
 * `readRepoFile` reads any repo-relative file on main, null when absent (AC-23).
 */
export function specPresentGate(issue: IssueData, specText: string | null, readRepoFile: (path: string) => string | null): GateResult {
  const path = specPathFromIssueBody(issue.body);
  if (!path) return ignore("issue body has no `Spec: specs/NNN-slug/spec.md` line");
  if (specText === null) return ignore(`${path} not found on main`);
  const parsed = parseSpec(specText);
  if (parsed.missing.length) return ignore(`${path} is missing: ${parsed.missing.join("; ")}`);
  if (!parsed.parent) return ignore(`${path} has no Parent: line`);
  const parentText = readRepoFile(parsed.parent);
  if (parentText === null) return ignore(`Parent ${parsed.parent} of ${path} not found on main`);
  if (!(parseChildren(parentText) ?? []).includes(path)) {
    return ignore(`Parent ${parsed.parent} does not list ${path} in its Children section`);
  }
  return pass;
}
