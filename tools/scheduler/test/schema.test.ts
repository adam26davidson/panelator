import { describe, expect, it } from "vitest";
import { initialChainState } from "../src/chain/machine.ts";
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

  it("includes the error params in the error string", () => {
    const r = validate("plan-result", {
      verdict: "ready",
      domain: "backend",
      tasks: [{ id: "T1", description: "add module", files: ["a.ts"] }],
      nope: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain('"additionalProperty":"nope"');
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

  it("accepts chain and standing agent names in usage records (008 AC-3)", () => {
    const rec = (stage: string) => validate("usage-record", {
      run_id: "r1", issue: 1, stage, attempt: 1, outcome: "ok", harness: "claude", model: "claude-fable-5-1",
      cost_usd: 0.1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      turns: 1, tool_calls: 0, wall_seconds: 2.5, started_at: "2026-10-12T00:00:00Z", ended_at: "2026-10-12T00:00:02Z",
      events_path: "runs/r1/events.jsonl",
    }).ok;
    expect(rec("spec")).toBe(true);
    expect(rec("question-check")).toBe(true);
    expect(rec("action-audit")).toBe(true);
    expect(rec("")).toBe(false);
  });

  it("validates a claim record and its chain state (spec 006 C12)", () => {
    const claim = (state: unknown) => validate("claim", {
      issue: 7, slot: 0, state, worktree: "/tmp/wt", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null,
    }).ok;
    expect(claim({ ...initialChainState(7), stage: "plan" })).toBe(true);
    expect(claim({ stage: "plan" })).toBe(false);
    expect(claim({ ...initialChainState(7), stage: "needs-human" })).toBe(false);
    expect(claim({ ...initialChainState(7), history: ["x".repeat(4001)] })).toBe(false);
  });

  it("reports unknown schema names", () => {
    // @ts-expect-error unknown name on purpose
    expect(() => validate("nope", {})).toThrow(/unknown schema/);
  });
});

describe("spec 006 schemas", () => {
  const q = { kind: "technical", question: "WAMR or wasm3?", options: [{ label: "WAMR", cost: "keeps AOT" }, { label: "wasm3", cost: "slower" }], recommendation: "WAMR" };
  const sha = "a".repeat(40);

  it("review escalate requires an escalation object (AC-8, review focus 3)", () => {
    expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(false);
    expect(validate("review-result", { verdict: "escalate", findings_on_pr: [], declined_to_judge: [], escalation: q }).ok).toBe(true);
    expect(validate("review-result", { verdict: "approve", findings_on_pr: [], declined_to_judge: [] }).ok).toBe(true);
  });

  it("spec-result: revised needs spec_path, pr_number, head_sha; question needs question (AC-21)", () => {
    const revised = { verdict: "revised", spec_path: "specs/006-no-human-stops/spec.md", pr_number: 3, head_sha: sha };
    expect(validate("spec-result", revised).ok).toBe(true);
    expect(validate("spec-result", { ...revised, spec_path: undefined }).ok).toBe(false);
    expect(validate("spec-result", { ...revised, spec_path: "docs/x.md" }).ok).toBe(false);
    expect(validate("spec-result", { verdict: "question", question: q }).ok).toBe(true);
    expect(validate("spec-result", { verdict: "question" }).ok).toBe(false);
  });

  it("question-check-result is send or decide_yourself with reasoning (AC-12)", () => {
    expect(validate("question-check-result", { verdict: "send", reasoning: "needs the maintainer" }).ok).toBe(true);
    expect(validate("question-check-result", { verdict: "decide_yourself", reasoning: "r" }).ok).toBe(true);
    expect(validate("question-check-result", { verdict: "maybe", reasoning: "r" }).ok).toBe(false);
    expect(validate("question-check-result", { verdict: "send" }).ok).toBe(false);
  });

  it("question options need label and cost", () => {
    expect(validate("question", q).ok).toBe(true);
    expect(validate("question", { ...q, options: [{ label: "x" }] }).ok).toBe(false);
  });

  it("plan, implement and fix results may carry an escalation instead of their fields, never of kind other (AC-17)", () => {
    expect(validate("implement-result", { escalation: { ...q, kind: "capability" } }).ok).toBe(true);
    expect(validate("implement-result", { escalation: { ...q, kind: "other" } }).ok).toBe(false);
    expect(validate("implement-result", { tasks_done: [] }).ok).toBe(false);
    expect(validate("fix-result", { escalation: q, findings: [finding] }).ok).toBe(true);
    expect(validate("fix-result", { escalation: { ...q, kind: "other" } }).ok).toBe(false);
    expect(validate("fix-result", { addressed: [] }).ok).toBe(false);
    expect(validate("implement-result", { pr_number: 1, head_sha: sha, tasks_done: [] }).ok).toBe(true);
  });

  it("a plan result holding only an escalation validates; spec_gap still needs questions (AC-17, review focus 9)", () => {
    expect(validate("plan-result", { escalation: q }).ok).toBe(true);
    expect(validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [] }).ok).toBe(false);
    expect(validate("plan-result", { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["why?"] }).ok).toBe(true);
  });

  const ledger = { rescues: 1, specRescues: 0, replans: 1, specRevisions: 2, specAnswers: 0, decideReturns: 1, history: ["plan attempt 1 failed: x"] };
  const paused = {
    issue: 7, phase: "paused", state: { stage: "waiting" }, question: q, asking_stage: "plan", nonce: "abc123",
    question_comment_id: 99, asked_at: "2026-10-27T10:00:00Z", reminded: false, answer: null, reply_comment_id: null,
  };

  it("paused requires phase, nonce, question_comment_id and asked_at, the last two nullable", () => {
    expect(validate("paused", paused).ok).toBe(true);
    expect(validate("paused", { ...paused, phase: "pausing", question_comment_id: null, asked_at: null }).ok).toBe(true);
    for (const k of ["phase", "nonce", "question_comment_id", "asked_at"]) {
      const { [k]: _omit, ...rest } = paused as Record<string, unknown>;
      expect(validate("paused", rest).ok, k).toBe(false);
    }
    expect(validate("paused", { ...paused, phase: "later" }).ok).toBe(false);
  });

  it("escalation-ledger round-trips a full record and rejects a partial one", () => {
    expect(validate("escalation-ledger", ledger).ok).toBe(true);
    expect(validate("escalation-ledger", JSON.parse(JSON.stringify(ledger))).ok).toBe(true);
    const { history: _h, ...partial } = ledger;
    expect(validate("escalation-ledger", partial).ok).toBe(false);
  });

  it("question-log-entry accepts question_comment_id and reply_comment_id", () => {
    const e = { issue: 7, at: "2026-10-27T10:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 99, reply_comment_id: 101, question: q, answer: "WAMR" };
    expect(validate("question-log-entry", e).ok).toBe(true);
    expect(validate("question-log-entry", { ...e, event: "guessed" }).ok).toBe(false);
  });
});
