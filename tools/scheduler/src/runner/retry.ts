import type { Judgement } from "../adapters/types.ts";
import type { Harness, StageDefinition } from "../types.ts";

export type RetryDecision = { kind: "none" } | { kind: "fallback"; model: string; harness: Harness } | { kind: "postpone" };

export function harnessForModel(model: string): Harness {
  return model.includes("/") ? "pi" : "claude";
}

/** AC-25: cost-capped fallback on 429 only; strong tier is postponed, never downgraded. */
export function retryDecision(def: StageDefinition, judgement: Judgement, costSoFar: number, retryCostLimit: number): RetryDecision {
  if (judgement.outcome !== "failed" || judgement.apiErrorStatus !== 429) return { kind: "none" };
  if (def.tier === "strong") return { kind: "postpone" };
  if (!def.fallback || costSoFar > retryCostLimit) return { kind: "none" };
  return { kind: "fallback", model: def.fallback, harness: harnessForModel(def.fallback) };
}
