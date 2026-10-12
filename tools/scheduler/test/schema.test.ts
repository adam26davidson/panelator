import { describe, expect, it } from "vitest";
import { validate } from "../src/schema/validate.ts";

const finding = {
  what: "duplicate pagination code",
  where: "tools/scheduler/src/github/client.ts:40",
  evidence: "two functions with the same loop",
  noticed_how: "while adding the checks call",
};

describe("result schemas", () => {
  it("accepts a ready plan result", () => {
    const r = validate("plan-result", {
      verdict: "ready",
      domain: "backend",
      tasks: [{ id: "T1", description: "add module", files: ["tools/scheduler/src/a.ts"] }],
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a plan result whose task has no files", () => {
    const r = validate("plan-result", {
      verdict: "ready",
      domain: "backend",
      tasks: [{ id: "T1", description: "add module" }],
    });
    expect(r.ok).toBe(false);
  });

  it("requires questions on a spec_gap verdict", () => {
    expect(validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [] }).ok).toBe(false);
    expect(
      validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["which port?"] }).ok,
    ).toBe(true);
  });

  it("accepts an implement result", () => {
    expect(
      validate("implement-result", { pr_number: 12, head_sha: "a".repeat(40), tasks_done: ["T1"], findings: [finding] }).ok,
    ).toBe(true);
  });

  it("rejects a review finding without an AC or rule criterion (style nit)", () => {
    const base = { verdict: "changes_requested", declined_to_judge: [] };
    const good = { ...base, findings_on_pr: [{ criterion: "AC-10", file: "x.ts", line: 3, scenario: "diff touches y" }] };
    const rule = { ...base, findings_on_pr: [{ criterion: "rule:AGENTS.md pnpm test", file: "x.ts", line: 3, scenario: "tests not run" }] };
    const nit = { ...base, findings_on_pr: [{ criterion: "style", file: "x.ts", line: 3, scenario: "prefer const" }] };
    expect(validate("review-result", good).ok).toBe(true);
    expect(validate("review-result", rule).ok).toBe(true);
    const r = validate("review-result", nit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/criterion/);
  });

  it("rejects a fix result with a short sha", () => {
    expect(validate("fix-result", { head_sha: "abc", addressed: [0] }).ok).toBe(false);
  });

  it("validates a usage record with null cost", () => {
    const ok = validate("usage-record", {
      run_id: "r1", issue: 1, stage: "plan", attempt: 1, outcome: "ok", harness: "pi", model: "openai/gpt-6.1-sol",
      cost_usd: null, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      turns: 1, tool_calls: 0, wall_seconds: 2.5, started_at: "2026-10-12T00:00:00Z", ended_at: "2026-10-12T00:00:02Z",
      events_path: "runs/r1/events.jsonl",
    });
    expect(ok.ok).toBe(true);
  });

  it("validates a claim record", () => {
    expect(
      validate("claim", {
        issue: 7, slot: 0, state: { stage: "plan" }, worktree: "/tmp/wt", started_at: "2026-10-12T00:00:00Z",
        last_activity_at: "2026-10-12T00:00:00Z", run_id: null,
      }).ok,
    ).toBe(true);
  });

  it("reports unknown schema names", () => {
    // @ts-expect-error unknown name on purpose
    expect(() => validate("nope", {})).toThrow(/unknown schema/);
  });
});
