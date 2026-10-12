import { describe, expect, it } from "vitest";
import { retryDecision } from "../src/runner/retry.ts";
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
});
