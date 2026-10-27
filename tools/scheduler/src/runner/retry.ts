import type { Judgement } from "../adapters/types.ts";
import type { Harness, StageDefinition } from "../types.ts";

export type RetryDecision = { kind: "none" } | { kind: "fallback"; model: string; harness: Harness } | { kind: "postpone" };

export function harnessForModel(model: string): Harness {
  return model.includes("/") ? "pi" : "claude";
}

function rateLimited(judgement: Judgement): boolean {
  return judgement.outcome === "failed" && judgement.apiErrorStatus === 429;
}

/**
 * AC-25: cost-capped fallback on 429 only; strong tier is postponed, never downgraded.
 * AC-26: an independent stage with a fallback falls back on 429 regardless of tier and cost.
 */
export function retryDecision(def: StageDefinition, judgement: Judgement, costSoFar: number, retryCostLimit: number): RetryDecision {
  if (!rateLimited(judgement)) return { kind: "none" };
  if (def.independent && def.fallback) return { kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) };
  if (def.tier === "strong") return { kind: "postpone" };
  if (!def.fallback || costSoFar > retryCostLimit) return { kind: "none" };
  return { kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) };
}

/** AC-26: a strong-tier stage whose fallback run was also rate-limited is postponed. */
export function afterFallback(def: StageDefinition, judgement: Judgement): { kind: "postpone" } | { kind: "none" } {
  return rateLimited(judgement) && def.tier === "strong" ? { kind: "postpone" } : { kind: "none" };
}
