import { describe, expect, it } from "vitest";
import {
  branchOf, HISTORY_ENTRY_MAX, HISTORY_MAX_ENTRIES, initialChainState, ledgerOf, MAX_DECIDE_RETURNS, MAX_REPLANS, MAX_RESCUES,
  MAX_SPEC_ANSWERS, MAX_SPEC_REVISIONS, normalizeChainState, transition, VERIFY_PENDING_MAX_H, type LedgerCounts,
} from "../src/chain/machine.ts";
import type { Action, ChainState } from "../src/chain/types.ts";
import { MAX_FIXES } from "../src/gates/index.ts";
import { validate } from "../src/schema/validate.ts";
import type { ImplementResult, PlanResult, Question, ReviewResult } from "../src/types.ts";

const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }] };
const impl: ImplementResult = { pr_number: 3, head_sha: "b".repeat(40), tasks_done: ["T1"] };
const approve: ReviewResult = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
const changes: ReviewResult = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.ts", line: 1, scenario: "s" }], declined_to_judge: [] };
const pr3 = { number: 3, head_sha: "b".repeat(40) };
const AT = "2026-10-27T00:00:00Z";
const fixOk = (sha: string) => ({ type: "stage_ok" as const, stage: "fix" as const, result: { head_sha: sha, addressed: [0] }, scope: { ok: true as const } });

function at(stage: ChainState["stage"], over: Partial<ChainState> = {}): ChainState {
  return { ...initialChainState(1), stage, ...over };
}
const types = (actions: Action[]) => actions.map((a) => a.type);

describe("chain: happy path", () => {
  it("claimed -> plan -> implement -> verify -> review -> merge -> done", () => {
    let s = initialChainState(1);
    let r = transition(s, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    r = transition(r.state, { type: "stage_ok", stage: "plan", result: plan });
    expect(r.state.stage).toBe("implement");
    expect(r.state.plan).toEqual(plan);
    r = transition(r.state, { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } });
    expect(r.state.stage).toBe("verify");
    expect(r.state.pr).toEqual(pr3);
    expect(r.actions).toEqual([{ type: "verify" }]);
    r = transition(r.state, { type: "checks", status: "green", sensitive: false, at: AT });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    r = transition(r.state, { type: "stage_ok", stage: "review", result: approve, security: false });
    expect(r.actions).toEqual([{ type: "merge" }]);
    r = transition(r.state, { type: "merge_result", status: "merged" });
    expect(r.state.stage).toBe("done");
    expect(r.actions).toContainEqual({ type: "label", add: [], remove: ["in-progress"] });
    expect(r.actions).toContainEqual({ type: "done" });
    expect(r.state.history).toEqual([]);
  });
});

describe("chain: plan outcomes", () => {
  it("spec_gap escalates with a rescue plan, no label (C2 stopgap until spec 006 Task 6; AC-19)", () => {
    const r = transition(at("plan"), { type: "stage_ok", stage: "plan", result: { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Q1", "Q2"] } });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "plan", rescues: 1, rescueRun: true });
    expect(r.state.history.at(-1)).toMatch(/^plan: spec gap: [\s\S]*Q2/);
  });
  it("retries a failed plan once at attempt 2", () => {
    const r = transition(at("plan"), { type: "stage_failed", stage: "plan", reason: "timeout" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 2 }]);
    expect(r.state.history).toEqual(["plan attempt 1 failed: timeout"]);
    expect(r.state.rescues).toBe(0);
  });
  it("plan failing twice runs a rescue plan with the history (AC-1, AC-7)", () => {
    const r = transition(at("plan", { planFailures: 1 }), { type: "stage_failed", stage: "plan", reason: "boom" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r.state).toMatchObject({ rescues: 1, rescueRun: true });
    expect(r.state.history.at(-1)).toMatch(/plan.*boom/);
  });
  it("a stage_ok of the rescued stage clears rescueRun", () => {
    const r = transition(at("plan", { rescueRun: true, rescues: 1 }), { type: "stage_ok", stage: "plan", result: plan });
    expect(r.state).toMatchObject({ stage: "implement", rescueRun: false, rescues: 1 });
  });
  it("a stage_failed naming another stage than the current one is invalid", () => {
    expect(() => transition(at("plan"), { type: "stage_failed", stage: "review", reason: "x" })).toThrow(/^invalid event /);
  });
});

describe("chain: history (AC-7)", () => {
  it("every failure is noted, capped and trimmed (AC-7)", () => {
    const long = transition(at("plan"), { type: "stage_failed", stage: "plan", reason: "x".repeat(10_000) });
    expect(long.state.history).toHaveLength(1);
    expect(long.state.history[0]).toHaveLength(HISTORY_ENTRY_MAX);
    expect(long.state.history[0].startsWith("plan attempt 1 failed: xxx")).toBe(true);

    let s = at("verify");
    for (let i = 0; i < 25; i++) s = { ...transition(s, { type: "checks", status: "failed", log: `L${i}`, sensitive: false, at: AT }).state, stage: "verify" };
    expect(s.history).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(s.history[0]).toMatch(/L5$/);
    expect(s.history.at(-1)).toMatch(/L24$/);
  });
  it("notes a scope violation and a changes_requested review", () => {
    const v = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(v.state.history.at(-1)).toContain("web/x.ts: outside plan file scope");
    const c = transition(at("review"), { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(c.state.history.at(-1)).toContain("[AC-1] a.ts:1 s");
  });
});

describe("chain: scope (AC-10, AC-1)", () => {
  it("first violation goes to fix with the violations as input; the second runs a rescue fix", () => {
    const r1 = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(r1.state.stage).toBe("fix");
    expect(r1.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("web/x.ts") });
    const r2 = transition(r1.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: false, violations: ["web/y.ts: outside plan file scope"] } });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("web/y.ts") }]);
    expect(r2.state).toMatchObject({ stage: "fix", rescues: 1, rescueRun: true, pendingFixInput: expect.stringContaining("web/y.ts") });
  });
});

describe("chain: verify (AC-14)", () => {
  it("pending waits, failed goes to fix with the log, green starts review", () => {
    expect(transition(at("verify"), { type: "checks", status: "pending", sensitive: false, at: AT }).actions).toEqual([{ type: "wait", seconds: 60 }]);
    const f = transition(at("verify"), { type: "checks", status: "failed", log: "FAIL x.test.ts", sensitive: false, at: AT });
    expect(f.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("FAIL x.test.ts") });
    expect(f.state.history.at(-1)).toContain("FAIL x.test.ts");
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true, at: AT });
    expect(g.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("a failed check at the fix bound runs a rescue fix with the check as input (AC-1)", () => {
    const r = transition(at("verify", { fixes: 2 }), { type: "checks", status: "failed", log: "FAIL x.test.ts", sensitive: false, at: AT });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("FAIL x.test.ts") }]);
    expect(r.state).toMatchObject({ stage: "fix", rescues: 1, rescueRun: true, pendingFixInput: expect.stringContaining("FAIL x.test.ts") });
  });
});

describe("chain: escalation path (AC-1 to AC-6)", () => {
  it("fix loop exhaustion rescues with a fix run (AC-1)", () => {
    let r = transition(at("review"), { type: "stage_ok", stage: "review", result: changes, security: false });
    r = transition(r.state, fixOk("c".repeat(40)));
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    r = transition(r.state, fixOk("d".repeat(40)));
    expect(r.state.fixes).toBe(2);
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("Review requested changes") }]);
    expect(r.state).toMatchObject({ stage: "fix", rescues: 1, rescueRun: true });
    expect(r.state.pendingFixInput).toContain("Review requested changes");
  });
  it("a failed fix runs a rescue fix that keeps the fix input (AC-1)", () => {
    const r = transition(at("fix", { pendingFixInput: "Review requested changes:\n0. x" }), { type: "stage_failed", stage: "fix", reason: "timeout" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: "Review requested changes:\n0. x" }]);
    expect(r.state).toMatchObject({ rescues: 1, rescueRun: true, pendingFixInput: "Review requested changes:\n0. x" });
    expect(r.state.history).toEqual(["fix attempt 1 failed: timeout", "fix: failed: timeout"]);
  });
  it("review failing twice runs a rescue review, with the security profile on a sensitive chain (AC-1)", () => {
    const r1 = transition(at("review", { sensitive: true }), { type: "stage_failed", stage: "review", reason: "timeout" });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 2, profile: "security" }]);
    const r2 = transition(r1.state, { type: "stage_failed", stage: "review", reason: "timeout" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
    expect(r2.state).toMatchObject({ rescues: 1, rescueRun: true });
  });
  it("implement failing twice runs a rescue implement (AC-1)", () => {
    const r = transition(at("implement", { implementFailures: 1, attempt: 2 }), { type: "stage_failed", stage: "implement", reason: "x" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 1 }]);
    expect(r.state).toMatchObject({ rescues: 1, rescueRun: true });
  });
  it("a failed rescue re-plans: close_pr carries the old PR, counters reset (AC-2, review focus 6)", () => {
    const s = at("implement", { rescueRun: true, rescues: 1, pr: pr3, fixes: 2, implementFailures: 1 });
    const r = transition(s, { type: "stage_failed", stage: "implement", reason: "x" });
    expect(r.actions[0]).toEqual({ type: "close_pr", pr: 3, branch: "issue-1", comment: expect.stringContaining("re-plan") });
    expect(r.actions.at(-1)).toEqual({ type: "run_stage", stage: "plan", attempt: 1 });
    expect(r.actions).toHaveLength(2);
    expect(r.state).toMatchObject({ pr: null, plan: null, fixes: 0, implementFailures: 0, planFailures: 0, scopeViolations: 0, replans: 1, rescueRun: false, stage: "plan" });
  });
  it("a re-plan without a PR closes nothing", () => {
    const r = transition(at("plan", { planFailures: 1, rescues: 1 }), { type: "stage_failed", stage: "plan", reason: "x" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r.state).toMatchObject({ replans: 1, planFailures: 0, rescueRun: false });
  });
  it("a quota failure in a rescue run postpones it without spending it (AC-27)", () => {
    const r = transition(at("plan", { rescueRun: true, rescues: 1 }), { type: "stage_failed", stage: "plan", reason: "429", postpone: true });
    expect(r.state).toMatchObject({ stage: "waiting", resumeStage: "plan", rescueRun: true, rescues: 1, replans: 0 });
    expect(r.state.history).toEqual([]);
    const resumed = transition(r.state, { type: "start" });
    expect(resumed.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(resumed.state).toMatchObject({ stage: "plan", rescueRun: true, rescues: 1 });
  });
  it("the spec stage and the question check can be postponed too (AC-27)", () => {
    const s = transition(at("spec", { track: "spec", specMode: "revise" }), { type: "stage_failed", stage: "spec", reason: "429", postpone: true });
    expect(s.state).toMatchObject({ stage: "waiting", resumeStage: "spec" });
    const resumed = transition(s.state, { type: "start" });
    expect(resumed.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(resumed.state).toMatchObject({ stage: "spec", track: "spec", specMode: "revise" });
    const q = transition(at("question-check"), { type: "stage_failed", stage: "question-check", reason: "429", postpone: true });
    expect(q.state).toMatchObject({ stage: "waiting", resumeStage: "question-check" });
  });
  it("after a re-plan the next bound revises the spec on the spec track (AC-3)", () => {
    const r = transition(at("implement", { rescues: 1, replans: 1, implementFailures: 1, pr: pr3 }), { type: "stage_failed", stage: "implement", reason: "x" });
    expect(r.actions).toEqual([
      { type: "close_pr", pr: 3, branch: "issue-1", comment: expect.stringContaining("x") },
      { type: "run_stage", stage: "spec", attempt: 1 },
    ]);
    expect(r.state).toMatchObject({ stage: "spec", specMode: "revise", specRevisions: 1, track: "spec", pr: null, rescueRun: false });
    expect(branchOf(r.state)).toBe("spec-1");
  });
  it("a failed spec stage retries once in the same mode, then runs the spec-track rescue, then abandons (AC-5)", () => {
    const s = at("spec", { track: "spec", specMode: "revise", rescues: 1, replans: 1, specRevisions: 1 });
    const r1 = transition(s, { type: "stage_failed", stage: "spec", reason: "t1" });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 2 }]);
    expect(r1.state).toMatchObject({ specMode: "revise", track: "spec" });
    const r2 = transition(r1.state, { type: "stage_failed", stage: "spec", reason: "t2" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r2.state).toMatchObject({ specRescues: 1, rescueRun: true, specMode: "revise", track: "spec" });
    const r3 = transition(r2.state, { type: "stage_failed", stage: "spec", reason: "t3" });
    expect(r3.state.stage).toBe("abandoned");
    expect(types(r3.actions)).toEqual(["comment", "label", "finding", "notify", "done"]);
  });
  it("after a spec revision the next bound abandons, in order, issue left open, nobody mentioned (AC-5)", () => {
    const r = transition(at("fix", { rescues: 1, replans: 1, specRevisions: 1, pr: pr3 }), { type: "stage_failed", stage: "fix", reason: "x" });
    expect(r.actions.map((a) => a.type)).toEqual(["close_pr", "comment", "label", "finding", "notify", "done"]);
    expect(r.actions[0]).toEqual({ type: "close_pr", pr: 3, branch: "issue-1", comment: expect.stringContaining("abandoned") });
    expect((r.actions[1] as { text: string }).text).not.toMatch(/@/);
    expect(r.actions[2]).toEqual({ type: "label", add: ["abandoned"], remove: ["in-progress"] });
    expect(r.state.stage).toBe("abandoned");
    expect(r.actions.some((a) => a.type === "release")).toBe(false);
  });
  it("the abandonment comment names the bounds and the history without any @, and the finding carries the history (AC-5, C11)", () => {
    const s = at("fix", { rescues: 1, replans: 1, specRevisions: 1, history: ["review: ping @someone about @types/x", "user@host broke"] });
    const r = transition(s, { type: "stage_failed", stage: "fix", reason: "boom" });
    const text = (r.actions.find((a) => a.type === "comment") as { text: string }).text;
    expect(text).not.toContain("@");
    expect(text).toContain("(at)someone");
    expect(text).toContain("user(at)host broke");
    expect(text).toContain("fix: failed: boom");
    expect(text).toMatch(/rescue 1\/1/);
    expect(text).toMatch(/re-plan 1\/1/);
    expect(text).toMatch(/spec revision 1\/1/);
    expect(text.trimEnd().endsWith("Spec C's re-triage picks this issue up; nothing is needed from the maintainer.")).toBe(true);
    const finding = r.actions.find((a) => a.type === "finding");
    expect(finding).toEqual({
      type: "finding", stage: "fix",
      finding: { what: "issue abandoned after the escalation path", where: "issue #1", evidence: r.state.history.join("\n"), noticed_how: "scheduler escalation" },
    });
    expect(r.state.history[0]).toContain("@someone");
    expect(r.actions.find((a) => a.type === "notify")).toMatchObject({ gate: "abandoned", label: "abandoned" });
  });
  it("the abandonment comment stays within GitHub's comment size with a full history (AC-5)", () => {
    const s = at("fix", { rescues: 1, replans: 1, specRevisions: 1, history: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(HISTORY_ENTRY_MAX, "y")) });
    const r = transition(s, { type: "stage_failed", stage: "fix", reason: "boom" });
    const text = (r.actions.find((a) => a.type === "comment") as { text: string }).text;
    expect(text.length).toBeLessThan(60_000);
    expect(text).toContain("fix: failed: boom");
    expect(text).toMatch(/earlier entries omitted/);
  });
  it("abandonment closes a parked issue PR too (AC-5)", () => {
    const s = at("fix", { track: "spec", specRescues: 1, pr: { number: 12, head_sha: "c".repeat(40) }, parkedPr: { number: 9, head_sha: "d".repeat(40) } });
    const r = transition(s, { type: "stage_failed", stage: "fix", reason: "x" });
    const closes = r.actions.filter((a) => a.type === "close_pr");
    expect(closes).toEqual([
      { type: "close_pr", pr: 12, branch: "spec-1", comment: expect.any(String) },
      { type: "close_pr", pr: 9, branch: "issue-1", comment: expect.any(String) },
    ]);
    expect(types(r.actions)).toEqual(["close_pr", "close_pr", "comment", "label", "finding", "notify", "done"]);
    expect(r.state).toMatchObject({ stage: "abandoned", pr: null, parkedPr: null });
  });
  it("on the spec track the first bound rescues and the second abandons (AC-5)", () => {
    const s = at("review", { track: "spec", fixes: 2, pr: { number: 12, head_sha: "c".repeat(40) } });
    const r1 = transition(s, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("Review requested changes") }]);
    expect(r1.state).toMatchObject({ specRescues: 1, rescues: 0, rescueRun: true, track: "spec" });
    const r2 = transition({ ...r1.state, stage: "review", rescueRun: false }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r2.state.stage).toBe("abandoned");
    expect(r2.actions[0]).toEqual({ type: "close_pr", pr: 12, branch: "spec-1", comment: expect.any(String) });
    expect(r2.state).toMatchObject({ replans: 0, specRevisions: 0 });
  });
  it("the escalation bounds (AC-6)", () => {
    expect([MAX_RESCUES, MAX_REPLANS, MAX_SPEC_REVISIONS, MAX_SPEC_ANSWERS, MAX_DECIDE_RETURNS, VERIFY_PENDING_MAX_H, MAX_FIXES]).toEqual([1, 1, 1, 1, 1, 6, 2]);
    expect([HISTORY_ENTRY_MAX, HISTORY_MAX_ENTRIES]).toEqual([4000, 20]);
  });
});

describe("chain: ledger and claim state (AC-7)", () => {
  const ledger: LedgerCounts = { rescues: 1, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 1, decideReturns: 1, history: ["plan: failed twice: old"] };
  it("a seeded ledger carries counts into a new chain (AC-7)", () => {
    const s = initialChainState(1, null, ledger);
    expect(s).toMatchObject({ ...ledger, stage: "claimed", track: "issue", fixes: 0 });
    expect(ledgerOf(s)).toEqual(ledger);
    expect(s.history).not.toBe(ledger.history);
    const r = transition({ ...s, stage: "plan", planFailures: 1 }, { type: "stage_failed", stage: "plan", reason: "again" });
    expect(r.state).toMatchObject({ replans: 1, rescues: 1, rescueRun: false });
    expect(r.state.history[0]).toBe("plan: failed twice: old");
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
  });
  it("initialChainState keeps a spec problem and defaults every new field", () => {
    expect(initialChainState(4, "spec missing")).toMatchObject({
      issue: 4, specProblem: "spec missing", track: "issue", rescues: 0, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 0, decideReturns: 0,
      rescueRun: false, history: [], specMode: null, question: null, askingStage: null, answer: null, answerQuestionId: null, answerKind: null,
      recordAnswer: false, decideInput: null, parkedPr: null, pendingSince: null, checksRerun: false,
    });
  });
  it("normalizeChainState loads a pre-006 claim state (AC-7)", () => {
    const pre006 = {
      issue: 7, stage: "review", attempt: 1, fixes: 1, scopeViolations: 0, planFailures: 0, implementFailures: 0, securityFinding: true, sensitive: true,
      pr: { number: 9, head_sha: "a".repeat(40) }, plan, pendingFixInput: null, postponedUntil: null, resumeStage: null, conflictPending: false,
    };
    const claim = { issue: 7, slot: 0, worktree: "/w/7", started_at: AT, last_activity_at: AT, run_id: null };
    // C12: the raw pre-006 state does not match the schema; normalized, it does.
    expect(validate("claim", { ...claim, state: pre006 }).ok).toBe(false);
    const s = normalizeChainState(pre006);
    expect("securityFinding" in s).toBe(false);
    const { securityFinding: _dropped, ...kept } = pre006;
    expect(s).toStrictEqual({ ...initialChainState(7), ...kept });
    expect(s).toMatchObject({ stage: "review", fixes: 1, sensitive: true, pr: { number: 9 }, track: "issue", rescues: 0, history: [], parkedPr: null });
    expect(validate("claim", { ...claim, state: s })).toEqual({ ok: true });
    const r = transition(s, { type: "stage_ok", stage: "review", result: approve, security: true });
    expect(r.actions).toEqual([{ type: "merge" }]);
  });
  it("normalizeChainState keeps fields already present and refuses a state without an issue", () => {
    const full = at("fix", { rescues: 1, history: ["h"], track: "spec" });
    expect(normalizeChainState(JSON.parse(JSON.stringify(full)))).toEqual(full);
    expect(() => normalizeChainState({ stage: "plan" })).toThrow(/chain state/);
    expect(() => normalizeChainState(null)).toThrow(/chain state/);
  });
  it("branchOf names the branch by track", () => {
    expect(branchOf(at("plan"))).toBe("issue-1");
    expect(branchOf(at("fix", { track: "spec" }))).toBe("spec-1");
  });
});

describe("chain: review (AC-8, AC-9)", () => {
  it("security findings go to fix, approval merges, no labels (AC-9)", () => {
    const r1 = transition(at("review", { pr: pr3 }), { type: "stage_ok", stage: "review", result: changes, security: true });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("[AC-1] a.ts:1 s") }]);
    expect(r1.state).toMatchObject({ stage: "fix", pendingFixInput: expect.stringContaining("a.ts:1") });
    const r2 = transition({ ...r1.state, stage: "review" }, { type: "stage_ok", stage: "review", result: approve, security: true });
    expect(r2.actions).toEqual([{ type: "merge" }]);
    expect(r2.state.stage).toBe("merge");
    expect([...r1.actions, ...r2.actions].some((a) => a.type === "label")).toBe(false);
  });
  it("an approval that carries findings on a sensitive chain goes to fix, even when the event says security: false (AC-9)", () => {
    const r = transition(at("review", { sensitive: true }), { type: "stage_ok", stage: "review", result: { ...approve, findings_on_pr: changes.findings_on_pr }, security: false });
    expect(r.state.stage).toBe("fix");
    expect(r.state.history.at(-1)).toContain("a.ts:1");
  });
  it("an approval with findings on a non-sensitive chain merges as before", () => {
    const r = transition(at("review"), { type: "stage_ok", stage: "review", result: { ...approve, findings_on_pr: changes.findings_on_pr }, security: false });
    expect(r.actions).toEqual([{ type: "merge" }]);
  });
  it("escalate of kind other is a bound hit with a rescue fix taking the escalation as input (AC-8)", () => {
    const escalation: Question = { kind: "other", question: "The suite cannot run here", options: [{ label: "skip", cost: "less coverage" }], recommendation: "skip" };
    const r = transition(at("review"), { type: "stage_ok", stage: "review", result: { ...approve, verdict: "escalate", escalation }, security: false });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("The suite cannot run here") }]);
    expect(r.state).toMatchObject({ stage: "fix", rescues: 1, rescueRun: true, pendingFixInput: expect.stringContaining("Recommendation: skip") });
  });
});

describe("chain: merge, rebase, liveness, postpone", () => {
  it("not mergeable goes to fix", () => {
    const r = transition(at("merge"), { type: "merge_result", status: "not_mergeable", detail: "conflict in a.ts" });
    expect(r.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("conflict in a.ts") });
  });
  it("rebase conflict before any stage goes to fix (AC-16)", () => {
    const r = transition(at("review"), { type: "rebase_conflict", detail: "CONFLICT a.ts" });
    expect(r.state.stage).toBe("fix");
  });
  it("a rebase conflict marks the fix as conflict-pending, and a successful fix clears it (C1)", () => {
    const r1 = transition(at("review"), { type: "rebase_conflict", detail: "CONFLICT a.ts" });
    expect(r1.state.stage).toBe("fix");
    expect(r1.state.conflictPending).toBe(true);
    const r2 = transition(r1.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [] }, scope: { ok: true } });
    expect(r2.state.stage).toBe("verify");
    expect(r2.state.conflictPending).toBe(false);
  });
  it("a rebase conflict at the fix bound runs a rescue fix that still resolves the conflict (AC-1)", () => {
    const r = transition(at("review", { fixes: 2 }), { type: "rebase_conflict", detail: "CONFLICT a.ts" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("CONFLICT a.ts") }]);
    expect(r.state).toMatchObject({ rescueRun: true, conflictPending: true });
  });
  it("head_moved in merge goes back to verify with the new head (C2)", () => {
    const r = transition(at("merge", { pr: pr3 }), { type: "head_moved", head_sha: "e".repeat(40) });
    expect(r.state.stage).toBe("verify");
    expect(r.state.pr).toEqual({ number: 3, head_sha: "e".repeat(40) });
    expect(r.actions).toEqual([{ type: "verify" }]);
  });
  it("head_moved outside the merge stage is invalid (C2)", () => {
    expect(() => transition(at("review", { pr: pr3 }), { type: "head_moved", head_sha: "e".repeat(40) })).toThrow(/invalid/);
  });
  it("liveness expiry releases with a patch and a comment (AC-15)", () => {
    const r = transition(at("implement"), { type: "liveness_expired" });
    expect(r.state.stage).toBe("released");
    expect(r.actions[0].type).toBe("comment");
    expect(r.actions).toContainEqual({ type: "release", reason: "liveness expired", savePatch: true });
    expect(r.actions.filter((a) => a.type === "comment")).toHaveLength(1);
    const notifies = r.actions.filter((a) => a.type === "notify");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ gate: "liveness", label: "" });
    expect(r.actions.some((a) => a.type === "close_pr" || a.type === "delete_branch")).toBe(false);
  });
  it("liveness on the spec track closes the spec PR, or deletes spec-<issue> without one (AC-21)", () => {
    const withPr = transition(at("verify", { track: "spec", pr: { number: 12, head_sha: "c".repeat(40) } }), { type: "liveness_expired" });
    expect(withPr.actions[0]).toEqual({ type: "close_pr", pr: 12, branch: "spec-1", comment: expect.any(String) });
    expect(types(withPr.actions)).toEqual(["close_pr", "comment", "label", "notify", "release"]);
    expect(withPr.state.stage).toBe("released");
    const without = transition(at("spec", { track: "spec" }), { type: "liveness_expired" });
    expect(without.actions[0]).toEqual({ type: "delete_branch", branch: "spec-1" });
    expect(types(without.actions)).toEqual(["delete_branch", "comment", "label", "notify", "release"]);
  });
  it("postponed strong-tier stage waits with the claim held and resumes the same stage (AC-25)", () => {
    const r1 = transition(at("review"), { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(r1.state.stage).toBe("waiting");
    expect(r1.actions).toEqual([{ type: "wait", seconds: 1800 }]);
    const r2 = transition(r1.state, { type: "start" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
  });
  it("a postponed security review resumes with the security profile (AC-11, AC-25)", () => {
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true, at: AT });
    const w = transition(g.state, { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(w.state.stage).toBe("waiting");
    const r = transition(w.state, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("throws on an event that is invalid for the stage", () => {
    expect(() => transition(at("plan"), { type: "merge_result", status: "merged" })).toThrow(/invalid/);
  });
});
