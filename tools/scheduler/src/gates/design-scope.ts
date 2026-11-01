import { posix } from "node:path";
import type { ScopeResult } from "./scope.ts";

/** Spec 029 AC-2: a design PR changes only files under the spec's `design/` directory. */
export function designScopeGate(diffFiles: string[], specPath: string): ScopeResult {
  const designDir = `${posix.dirname(specPath)}/design/`;
  const violations = diffFiles.filter((f) => !f.startsWith(designDir)).map((f) => `${f}: outside the design PR's scope (${designDir})`);
  return violations.length ? { ok: false, violations } : { ok: true };
}
