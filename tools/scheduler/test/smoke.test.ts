import { describe, expect, it } from "vitest";
import { isBounds } from "../src/types.ts";

describe("scheduler package", () => {
  it("loads and exposes the shared type guards", () => {
    expect(isBounds({ timeout_min: 1, max_turns: 1, max_cost_usd: 1 })).toBe(true);
    expect(isBounds({ timeout_min: 1 })).toBe(false);
  });
});
