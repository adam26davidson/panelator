import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { adapterFor } from "../src/adapters/index.ts";

describe("fakeAdapter", () => {
  const a = fakeAdapter({ events: [{ type: "x" }], scriptPath: "/s.ts" });
  it("builds a node command and judges on exit code only", () => {
    const { argv } = a.buildCommand({ runId: "r", stage: "plan", attempt: 1, issue: 1, prompt: "p", model: "fake", bounds: { timeout_min: 1, max_turns: 1, max_cost_usd: 1 }, worktree: "/w", sessionId: "s", resultPath: "/r.json", profile: null });
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe("/s.ts");
    expect(a.judge([], 0, false).outcome).toBe("ok");
    expect(a.judge([], 1, false).outcome).toBe("failed");
    expect(a.judge([], 0, true).outcome).toBe("timeout");
  });
  it("adapterFor returns claude, pi, or the supplied fake", () => {
    expect(adapterFor("claude").harness).toBe("claude");
    expect(adapterFor("pi").harness).toBe("pi");
    expect(adapterFor("fake", a)).toBe(a);
    expect(() => adapterFor("fake")).toThrow(/fake adapter/);
  });
});
