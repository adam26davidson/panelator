import { posix } from "node:path";
import { stripChildren } from "../spec/parse.ts";
import { ROOT, TOP_DESIGNS } from "./design-tree.ts";
import type { ScopeResult } from "./scope.ts";

const DESIGNS = "docs/designs/";
const DECISIONS = "docs/decisions/";

/**
 * The spec PR's scope (AC-21, AC-22): the spec's directory, docs/designs/, docs/decisions/, and the
 * Children section of the parent when it is a top design (a parent under docs/designs/ is allowed in
 * full). With `recordsProductAnswer`, either top design in full. The charter is never allowed, and a
 * parent that is not a top design or under docs/designs/ is a violation whatever the diff.
 */
export function specScopeGate(
  diffFiles: string[],
  specPath: string,
  parentPath: string | null,
  parentBefore: string,
  parentAfter: string,
  recordsProductAnswer = false,
): ScopeResult {
  const specDir = posix.dirname(specPath) + "/";
  parentPath = parentPath === null ? null : posix.normalize(parentPath);
  const parentIsDesign = parentPath !== null && (TOP_DESIGNS.includes(parentPath) || parentPath.startsWith(DESIGNS));
  const violations: string[] = [];
  if (parentPath === null) violations.push(`${specPath}: no Parent line`);
  else if (!parentIsDesign) violations.push(`${parentPath}: not a design`);

  for (const f of diffFiles) {
    if (f === parentPath && !parentIsDesign) continue; // already reported above
    // The charter and the top designs are decided before any prefix allow, so an unvalidated spec path cannot widen them.
    if (f === ROOT) violations.push(`${f}: the charter is never changed by a spec PR`);
    else if (TOP_DESIGNS.includes(f)) {
      if (recordsProductAnswer) continue;
      if (f === parentPath && stripChildren(parentBefore) === stripChildren(parentAfter)) continue;
      violations.push(f === parentPath ? `${f}: changes outside its Children section` : `${f}: outside spec PR scope`);
    } else if (f.startsWith(specDir) || f.startsWith(DESIGNS) || f.startsWith(DECISIONS)) continue;
    else violations.push(`${f}: outside spec PR scope`);
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

/** The design PR's scope (spec 029 AC-2): the spec's design/ directory and nothing else. */
export function designScopeGate(diffFiles: string[], specPath: string): ScopeResult {
  const designDir = posix.dirname(specPath) + "/design/";
  const violations = diffFiles.filter((f) => !f.startsWith(designDir)).map((f) => `${f}: outside design PR scope`);
  return violations.length ? { ok: false, violations } : { ok: true };
}
