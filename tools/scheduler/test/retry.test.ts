import { describe, expect, it } from "vitest";
import { afterFallback, retryDecision } from "../src/runner/retry.ts";
import type { StageDefinition } from "../src/types.ts";

const base: StageDefinition = {
  name: "implement", kind: "agent", harness: "claude", model: "claude-sonnet-5-5", fallback: "openai/gpt-6.1-sol", tier: "standard",
  bounds: { timeout_min: 1, max_turns: 1, max_cost_usd: 1 }, permission: "no-prompt", worktree: "issue", profile: "from-issue", input: "stage-input", output: "implement-result", prompt: "",
};
const j429 = { outcome: "failed" as const, reason: "429", apiErrorStatus: 429, finalText: null };

describe("retryDecision (AC-25)", () => {
  it("falls back once on 429 within the cost limit, picking the harness from the model id", () => {
    expect(retryDecision(base, j429, 0.5, 1)).toEqual({ kind: "fallback", model: "openai/gpt-6.1-sol", harness: "pi" });
    expect(retryDecision({ ...base, fallback: "claude-opus-5-5" }, j429, 0.5, 1)).toEqual({ kind: "fallback", model: "claude-opus-5-5", harness: "claude" });
  });
  it("does nothing above the cost limit, without a fallback, or on other failures", () => {
    expect(retryDecision(base, j429, 1.5, 1)).toEqual({ kind: "none" });
    expect(retryDecision({ ...base, fallback: undefined }, j429, 0, 1)).toEqual({ kind: "none" });
    expect(retryDecision(base, { ...j429, apiErrorStatus: 500 }, 0, 1)).toEqual({ kind: "none" });
    expect(retryDecision(base, { ...j429, outcome: "timeout" }, 0, 1)).toEqual({ kind: "none" });
  });
  it("postpones a strong-tier stage instead of downgrading", () => {
    expect(retryDecision({ ...base, name: "review", tier: "strong", fallback: undefined }, j429, 0, 1)).toEqual({ kind: "postpone" });
  });
  it("retries a strong-tier stage once on the model-limit fallback within the cost limit (spec 013 AC-9)", () => {
    const review = { ...base, name: "review" as const, tier: "strong" as const, fallback: undefined };
    expect(retryDecision(review, j429, 0.5, 1, "claude-opus-5-5")).toEqual({ kind: "fallback", model: "claude-opus-5-5", harness: "claude" });
    expect(retryDecision(review, j429, 1.5, 1, "claude-opus-5-5")).toEqual({ kind: "postpone" });
    expect(retryDecision(review, j429, 0, 1, null)).toEqual({ kind: "postpone" });
  });
});

describe("independent strong-tier stages (AC-26)", () => {
  const check: StageDefinition = { ...base, name: "question-check", harness: "pi", model: "openai/gpt-6.1-sol", fallback: "claude-fable-5-1", tier: "strong", independent: true };
  it("fall back on 429 regardless of tier and cost", () => {
    expect(retryDecision(check, j429, 99, 1)).toEqual({ kind: "fallback", model: "claude-fable-5-1", harness: "claude" });
  });
  it("a non-independent strong stage still postpones", () => {
    expect(retryDecision({ ...check, independent: false }, j429, 99, 1)).toEqual({ kind: "postpone" });
    expect(retryDecision({ ...check, independent: undefined }, j429, 0, 1)).toEqual({ kind: "postpone" });
  });
  it("other failures of an independent stage do not fall back", () => {
    expect(retryDecision(check, { ...j429, apiErrorStatus: 500 }, 0, 1)).toEqual({ kind: "none" });
  });
  it("afterFallback postpones a strong stage whose fallback run hit 429, and does nothing otherwise", () => {
    expect(afterFallback(check, j429)).toEqual({ kind: "postpone" });
    expect(afterFallback(check, { ...j429, apiErrorStatus: 500 })).toEqual({ kind: "none" });
    expect(afterFallback(check, { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "x" })).toEqual({ kind: "none" });
    expect(afterFallback(base, j429)).toEqual({ kind: "none" });
  });
});
