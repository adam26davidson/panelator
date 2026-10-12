import type { ParsedSpec } from "../spec/parse.ts";
import type { PlanResult } from "../types.ts";
import { isSensitive } from "./sensitive.ts";

const ALWAYS_ALLOWED = [/^schemas\//, /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$/];

function inScope(file: string, scope: string[]): boolean {
  return scope.some((s) => (s.endsWith("/") ? file.startsWith(s) : file === s));
}

export type ScopeResult = { ok: true } | { ok: false; violations: string[] };

export function scopeGate(diffFiles: string[], plan: PlanResult, spec: ParsedSpec, sensitiveGlobs: string[]): ScopeResult {
  const scope = plan.tasks.flatMap((t) => t.files);
  const violations: string[] = [];
  for (const f of diffFiles) {
    const allowed = ALWAYS_ALLOWED.some((re) => re.test(f));
    if (!allowed && !inScope(f, scope)) violations.push(`${f}: outside plan file scope`);
  }
  for (const f of isSensitive(diffFiles, sensitiveGlobs)) {
    if (!inScope(f, spec.listedPaths)) violations.push(`${f}: sensitive path not listed in the spec`);
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}
