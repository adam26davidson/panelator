import { describe, expect, it } from "vitest";
import {
  branchOf, HISTORY_ENTRY_MAX, HISTORY_MAX_ENTRIES, initialChainState, ledgerOf, MAX_CHAIN_ERRORS, MAX_DECIDE_RETURNS, MAX_REPLANS, MAX_RESCUES,
  MAX_SPEC_ANSWERS, MAX_SPEC_REVISIONS, normalizeChainState, transition, VERIFY_PENDING_MAX_H, type LedgerCounts,
} from "../src/chain/machine.ts";
import type { Action, ChainEvent, ChainStage, ChainState } from "../src/chain/types.ts";
import { MAX_FIXES } from "../src/gates/index.ts";
import { validate } from "../src/schema/validate.ts";
import { formatQuestion, questionBody, questionMarker } from "../src/chain/question.ts";
import type { AgentStageName, ImplementResult, PlanResult, Question, ReviewResult, SpecResult } from "../src/types.ts";

const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }] };
const impl: ImplementResult = { pr_number: 3, head_sha: "b".repeat(40), tasks_done: ["T1"] };
const approve: ReviewResult = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
const changes: ReviewResult = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.ts", line: 1, scenario: "s" }], declined_to_judge: [] };
const pr3 = { number: 3, head_sha: "b".repeat(40) };
const AT = "2026-10-27T00:00:00Z";
const fixOk = (sha: string) => ({ type: "stage_ok" as const, stage: "fix" as const, result: { head_sha: sha, addressed: [0] }, scope: { ok: true as const } });
const q: Question = { kind: "technical", question: "Which cache?", options: [{ label: "lru", cost: "memory" }, { label: "none", cost: "latency" }], recommendation: "lru" };
const qProduct: Question = { ...q, kind: "product", question: "Ship widget X?" };
const qCapability: Question = { ...q, kind: "capability", question: "No GPU on this runner" };
const qOther: Question = { ...q, kind: "other", question: "The suite cannot run here" };
const revised: SpecResult = { verdict: "revised", spec_path: "specs/010-x/spec.md", pr_number: 8, head_sha: "f".repeat(40) };
const pr8 = { number: 8, head_sha: "f".repeat(40) };
const plusH = (h: number) => new Date(Date.parse(AT) + h * 3_600_000).toISOString();

function at(stage: ChainState["stage"], over: Partial<ChainState> = {}): ChainState {
  return { ...initialChainState(1), stage, ...over };
}
const types = (actions: Action[]) => actions.map((a) => a.type);

describe('asking session conversation',()=>{
 it('resumes plan before recording a product answer and records only after settled',()=>{
  const s=at('paused',{question:qProduct,askingStage:'plan',resumeSession:{harness:'claude',model:'m',session_id:'session',worktree:'/tmp/w'}});
  const reply=transition(s,{type:'answered',answer:'why not the second one?',questionId:42});
  expect(reply.state.stage).toBe('plan');expect(reply.actions).toEqual([{type:'run_stage',stage:'plan',attempt:1,conversation:true}]);
  const settled=transition(reply.state,{type:'stage_ok',stage:'plan',result:{conversation:'settled',decision:'Use second for simplicity'} as never});
  expect(settled.state.stage).toBe('spec');expect(settled.state.specMode).toBe('record');expect(settled.state.decision).toBe('Use second for simplicity');expect(settled.state.answer).toContain('why not the second one?');
 });
 it('retries an invalid turn once without counting any bound',()=>{
  const s=transition(at('paused',{question:qProduct,askingStage:'review',resumeSession:{harness:'pi',model:'m',session_id:'s',worktree:'/w'}}),{type:'answered',answer:'second',questionId:4}).state;
  const retry=transition(s,{type:'stage_failed',stage:'review',reason:'invalid'});expect(retry.state.conversation?.retried).toBe(true);expect(retry.state.history).toEqual(s.history);
  const end=transition(retry.state,{type:'stage_failed',stage:'review',reason:'invalid'});expect(end.state.stage).toBe('spec');expect(end.state.decision).toBeNull();
 });
 it('carries held work through a conversation turn, its failed retry and the settled route (spec 011 AC-3, AC-7)',()=>{
  const held={branch:'issue-1',head:'a'.repeat(40)};
  const session={harness:'claude' as const,model:'m',session_id:'s',worktree:'/w'};
  const s=at('paused',{question:q,askingStage:'implement',heldWork:held,resumeSession:session});
  const turn=transition(s,{type:'answered',answer:'why not the second?',questionId:9});
  expect(turn.state).toMatchObject({stage:'implement',heldWork:held});expect(turn.state.conversation?.next.heldWork).toEqual(held);
  const failed=transition(turn.state,{type:'stage_failed',stage:'implement',reason:'invalid'});
  expect(failed.state).toMatchObject({heldWork:held});expect(failed.state.conversation?.retried).toBe(true);
  const settled=transition(failed.state,{type:'stage_ok',stage:'implement',result:{conversation:'settled',decision:'second'} as never});
  expect(settled.state).toMatchObject({stage:'spec',specMode:'record',heldWork:held});
 });
 it('carries held work into a session resume; the resumed stage failing clears it (spec 011 AC-3, AC-7)',()=>{
  const held={branch:'issue-1',head:'a'.repeat(40)};
  const s=at('paused',{question:qCapability,askingStage:'implement',heldWork:held,plan,resumeSession:{harness:'claude',model:'m',session_id:'s',worktree:'/w'}});
  const r=transition(s,{type:'answered',answer:'done, the token is set',questionId:9});
  expect(r.state).toMatchObject({stage:'implement',heldWork:held});expect(r.state.conversation??null).toBeNull();expect(r.state.resumeSession).not.toBeNull();
  expect(transition(r.state,{type:'stage_failed',stage:'implement',reason:'boom'}).state.heldWork).toBeNull();
 });
});

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
  it("spec_gap goes to the spec stage in answer mode once; the second escalates (AC-1, AC-19)", () => {
    const gap = { type: "stage_ok" as const, stage: "plan" as const, result: { verdict: "spec_gap" as const, domain: "backend", tasks: [], questions: ["Q1", "Q2"] } };
    const r1 = transition(at("plan"), gap);
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r1.state).toMatchObject({ stage: "spec", specMode: "answer", track: "spec", specAnswers: 1, rescues: 0 });
    expect(r1.state.specProblem).toMatch(/gaps in the spec:\n1\. Q1\n2\. Q2/);
    expect(r1.actions.some((a) => a.type === "label")).toBe(false);
    const r2 = transition(at("plan", { specAnswers: 1 }), gap);
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r2.state).toMatchObject({ stage: "plan", track: "issue", rescues: 1, rescueRun: true, specAnswers: 1 });
    expect(r2.state.history.at(-1)).toMatch(/^plan: spec gap after an answered gap: [\s\S]*Q2/);
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
    // C5: on a sensitive diff the normal review runs first; the security review follows its approval.
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true, at: AT });
    expect(g.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    expect(g.state).toMatchObject({ sensitive: true, securityPass: false });
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
    const r1 = transition(at("review", { sensitive: true, securityPass: true }), { type: "stage_failed", stage: "review", reason: "timeout" });
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
  it("the abandonment cap measures the rendered entries, with their prefix and indented lines (AC-5)", () => {
    // Each entry is 4000 characters of which 2000 are newlines; rendered, each newline gains a three-space indent.
    const history = Array.from({ length: 20 }, () => "a\n".repeat(HISTORY_ENTRY_MAX / 2));
    const r = transition(at("fix", { rescues: 1, replans: 1, specRevisions: 1, history }), { type: "stage_failed", stage: "fix", reason: "boom" });
    const text = (r.actions.find((a) => a.type === "comment") as { text: string }).text;
    expect(text.length).toBeLessThan(60_000);
    expect(text).toContain("fix: failed: boom");
    expect(text).toMatch(/\(\d+ earlier entries omitted\)/);
  });
  it("a close_pr comment carries at most HISTORY_ENTRY_MAX characters of the reason (AC-2)", () => {
    const s = at("implement", { rescueRun: true, rescues: 1, pr: pr3 });
    const r = transition(s, { type: "stage_failed", stage: "implement", reason: "x".repeat(10_000) });
    const close = r.actions[0] as Extract<Action, { type: "close_pr" }>;
    expect(close.type).toBe("close_pr");
    expect(close.comment.startsWith("Closed by the scheduler to re-plan: rescue run failed: xxx")).toBe(true);
    expect(close.comment.length).toBe("Closed by the scheduler to re-plan: ".length + HISTORY_ENTRY_MAX);
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
  const ledger: LedgerCounts = {
    rescues: 1, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 1, decideReturns: 1, history: ["plan: failed twice: old"], pendingAnswer: null, chainFailures: null, chainErrors: 0,
  };
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
  it("a seeded ledger's history is trimmed to the last HISTORY_MAX_ENTRIES entries, each capped (AC-7)", () => {
    const long: LedgerCounts = { ...ledger, history: Array.from({ length: 25 }, (_, i) => `e${i}`.padEnd(HISTORY_ENTRY_MAX + 10, "z")) };
    const s = initialChainState(1, null, long);
    expect(s.history).toHaveLength(HISTORY_MAX_ENTRIES);
    expect(s.history[0].startsWith("e5z")).toBe(true);
    expect(s.history.at(-1)!.startsWith("e24z")).toBe(true);
    expect(s.history.every((e) => e.length === HISTORY_ENTRY_MAX)).toBe(true);
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
  it("liveness on the spec track also closes a parked issue PR (AC-21, AC-18)", () => {
    const r = transition(at("review", { track: "spec", pr: { number: 12, head_sha: "c".repeat(40) }, parkedPr: pr3 }), { type: "liveness_expired" });
    expect(r.actions.slice(0, 2)).toEqual([
      { type: "close_pr", pr: 12, branch: "spec-1", comment: expect.any(String) },
      { type: "close_pr", pr: 3, branch: "issue-1", comment: expect.any(String) },
    ]);
    expect(types(r.actions)).toEqual(["close_pr", "close_pr", "comment", "label", "notify", "release"]);
    expect(r.state).toMatchObject({ stage: "released", pr: null, parkedPr: null });
    const noSpecPr = transition(at("spec", { track: "spec", parkedPr: pr3 }), { type: "liveness_expired" });
    expect(noSpecPr.actions.slice(0, 2)).toEqual([
      { type: "delete_branch", branch: "spec-1" },
      { type: "close_pr", pr: 3, branch: "issue-1", comment: expect.any(String) },
    ]);
  });
  it("liveness_expired is invalid in the ended stages (AC-27)", () => {
    for (const stage of ["done", "released", "abandoned", "paused"] as const) {
      expect(() => transition(at(stage, { question: q, askingStage: "plan" }), { type: "liveness_expired" })).toThrow(/^invalid event liveness_expired /);
    }
  });
  it("postponed strong-tier stage waits with the claim held and resumes the same stage (AC-25)", () => {
    const r1 = transition(at("review"), { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(r1.state.stage).toBe("waiting");
    expect(r1.actions).toEqual([{ type: "wait", seconds: 1800 }]);
    const r2 = transition(r1.state, { type: "start" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
  });
  it("a postponed security review resumes with the security profile (AC-11, AC-25)", () => {
    const w = transition(at("review", { sensitive: true, securityPass: true, pr: pr3 }), { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(w.state.stage).toBe("waiting");
    const r = transition(w.state, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("throws on an event that is invalid for the stage", () => {
    expect(() => transition(at("plan"), { type: "merge_result", status: "merged" })).toThrow(/invalid/);
  });
});

const HEAD = "d".repeat(40);
const specOk = (result: SpecResult, scope: { ok: true } | { ok: false; violations: string[] } = { ok: true }) => ({
  type: "stage_ok" as const, stage: "spec" as const, result, scope, ...(result.verdict === "question" ? { head: HEAD } : {}),
});
const checkSays = (verdict: "send" | "decide_yourself", reasoning = "r") => ({ type: "stage_ok" as const, stage: "question-check" as const, result: { verdict, reasoning } });
const answered = (answer = "use lru", questionId = 5) => ({ type: "answered" as const, answer, questionId });
const reviewEscalates = (escalation: Question) => ({ type: "stage_ok" as const, stage: "review" as const, result: { ...approve, verdict: "escalate" as const, escalation }, security: false });

describe("chain: spec stage and spec track (AC-4, AC-19, AC-21, AC-22)", () => {
  it("a claimed issue with a spec problem starts at the spec stage in write mode on the spec track (AC-19, AC-21)", () => {
    const r = transition(initialChainState(1, "specs/010-x/spec.md not found on main"), { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r.state).toMatchObject({ specMode: "write", track: "spec" });
    expect(branchOf(r.state)).toBe("spec-1");
  });
  it("a claimed issue without a spec problem starts at plan on the issue track", () => {
    const r = transition(initialChainState(1), { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r.state.track).toBe("issue");
  });
  it("every transition into the spec stage sets the spec track (AC-21, review focus 12)", () => {
    const cases: [string, ChainState, Parameters<typeof transition>[1], string][] = [
      ["claimed start", initialChainState(1, "spec missing"), { type: "start" }, "write"],
      ["plan spec_gap", at("plan"), { type: "stage_ok", stage: "plan", result: { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Q"] } }, "answer"],
      ["escalate revise", at("implement", { rescues: 1, replans: 1, implementFailures: 1 }), { type: "stage_failed", stage: "implement", reason: "x" }, "revise"],
      ["answered from plan", at("paused", { question: q, askingStage: "plan" }), answered(), "record"],
      ["answered from review (product)", at("paused", { question: qProduct, askingStage: "review", pr: pr3 }), answered(), "record"],
      ["decide_yourself for spec", at("question-check", { question: q, askingStage: "spec", specMode: "answer" }), checkSays("decide_yourself"), "decide"],
      ["spec-track rescue of spec", at("spec", { attempt: 2, specMode: "answer" }), { type: "stage_failed", stage: "spec", reason: "x" }, "answer"],
      ["waiting resume", at("waiting", { resumeStage: "spec", specMode: "record" }), { type: "start" }, "record"],
      ["spec-present failure after merge", at("merge", { track: "spec", pr: pr8 }), { type: "merge_result", status: "merged", specGate: { ok: false, gate: "spec-present", reason: "no Parent" } }, "write"],
    ];
    for (const [name, state, event, mode] of cases) {
      const r = transition(state, event);
      expect(r.state.stage, name).toBe("spec");
      expect(r.state.track, name).toBe("spec");
      expect(r.state.specMode, name).toBe(mode);
      expect(branchOf(r.state), name).toBe("spec-1");
      expect(r.actions.at(-1), name).toMatchObject({ type: "run_stage", stage: "spec" });
    }
  });
  it("a revised spec goes through verify on the spec track, then back to plan after merge (AC-4)", () => {
    let r = transition(at("spec", { specMode: "revise", track: "spec" }), specOk(revised));
    expect(r.state).toMatchObject({ track: "spec", stage: "verify", pr: { number: 8 }, specMode: null, fixes: 0, scopeViolations: 0 });
    expect(r.actions).toEqual([{ type: "verify" }]);
    r = transition({ ...r.state, stage: "merge" }, { type: "merge_result", status: "merged", specGate: { ok: true } });
    expect(r.state).toMatchObject({ track: "issue", stage: "plan", pr: null, plan: null, specProblem: null, specMode: null });
    expect(r.actions).toEqual([{ type: "delete_branch", branch: "spec-1" }, { type: "run_stage", stage: "plan", attempt: 1 }]);
  });
  it("a spec-track merge resets the stage counters and is not the end of the chain (AC-4)", () => {
    const s = at("merge", { track: "spec", pr: pr8, fixes: 2, scopeViolations: 1, planFailures: 1, implementFailures: 1, specProblem: "gap", answerQuestionId: 5, answerKind: "technical" });
    const r = transition(s, { type: "merge_result", status: "merged", specGate: { ok: true } });
    expect(r.state).toMatchObject({ fixes: 0, scopeViolations: 0, planFailures: 0, implementFailures: 0, specProblem: null, answer: null, answerQuestionId: null, answerKind: null });
    expect(r.actions.some((a) => a.type === "done" || a.type === "label")).toBe(false);
  });
  it("after a spec-track merge, a spec-present failure reruns the spec stage within bounds and a UI failure parks the issue (AC-4)", () => {
    const failed = { type: "merge_result" as const, status: "merged" as const, specGate: { ok: false as const, gate: "spec-present" as const, reason: "spec lacks a Parent: line" } };
    const r1 = transition(at("merge", { track: "spec", pr: pr8 }), failed);
    expect(r1.actions).toEqual([{ type: "delete_branch", branch: "spec-1" }, { type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r1.state).toMatchObject({ stage: "spec", specMode: "write", specProblem: "spec lacks a Parent: line", rescueRun: true, specRescues: 1, pr: null, track: "spec" });
    expect(r1.state.history.at(-1)).toBe("spec: spec-present failed after merge: spec lacks a Parent: line");
    const r2 = transition(at("merge", { track: "spec", pr: pr8, specRescues: 1 }), failed);
    expect(r2.state.stage).toBe("abandoned");
    expect(types(r2.actions)).toEqual(["delete_branch", "comment", "label", "finding", "notify", "done"]);

    const ui = transition(at("merge", { track: "spec", pr: pr8 }), { type: "merge_result", status: "merged", specGate: { ok: false, gate: "ui-design", reason: "spec E will provide the design stage: no design/" } });
    expect(ui.state).toMatchObject({ stage: "released", pr: null });
    expect(types(ui.actions)).toEqual(["delete_branch", "comment", "label", "notify", "release"]);
    expect((ui.actions[1] as { text: string }).text).toContain("no design/");
    expect(ui.actions[2]).toEqual({ type: "label", add: ["needs-design-stage"], remove: ["in-progress"] });
    expect(ui.actions.at(-1)).toEqual({ type: "release", reason: expect.any(String), savePatch: false });
    expect(ui.actions.some((a) => a.type === "finding")).toBe(false);
  });
  it("a merged record PR restores the parked issue PR and runs a fix (AC-18)", () => {
    const s = at("merge", { track: "spec", pr: pr8, parkedPr: pr3, fixes: 1, answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product", specProblem: null });
    const r = transition(s, { type: "merge_result", status: "merged", specGate: { ok: true } });
    expect(r.actions).toEqual([
      { type: "delete_branch", branch: "spec-1" },
      { type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("question #5") },
    ]);
    expect(r.state).toMatchObject({ stage: "fix", track: "issue", pr: pr3, parkedPr: null, fixes: 0, answerQuestionId: null, answerKind: null });
    expect(r.state.pendingFixInput).toBe(
      "Apply the maintainer's decision to question #5, now recorded on main. Read it in the spec and the top designs, then change this PR to follow it.",
    );
    expect(branchOf(r.state)).toBe("issue-1");
  });
  it("a spec PR scope violation goes to one fix, the second escalates (AC-22)", () => {
    const r1 = transition(at("spec", { track: "spec", specMode: "write" }), specOk(revised, { ok: false, violations: ["web/x.ts: outside the spec PR's scope"] }));
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("web/x.ts") }]);
    expect(r1.state).toMatchObject({ stage: "fix", track: "spec", pr: pr8, scopeViolations: 1 });
    expect(r1.state.history.at(-1)).toContain("web/x.ts");
    const r2 = transition(r1.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: false, violations: ["docs/charter.md: charter"] } });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("docs/charter.md") }]);
    expect(r2.state).toMatchObject({ specRescues: 1, rescues: 0, rescueRun: true, track: "spec" });
  });
  it("a postponed spec stage resumes in the same mode on the spec track", () => {
    const w = transition(at("spec", { track: "spec", specMode: "answer", attempt: 2, rescueRun: true, specRescues: 1 }), { type: "stage_failed", stage: "spec", reason: "429", postpone: true });
    expect(w.state).toMatchObject({ stage: "waiting", resumeStage: "spec", specMode: "answer" });
    const r = transition(w.state, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 2 }]);
    expect(r.state).toMatchObject({ stage: "spec", track: "spec", specMode: "answer", rescueRun: true, specRescues: 1 });
  });
});

describe("chain: questions (AC-8, AC-12 to AC-15, AC-17)", () => {
  it("a review escalation of kind technical goes to the question check (AC-8, AC-12)", () => {
    const r = transition(at("review", { pr: pr3 }), reviewEscalates(q));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "question-check", question: q, askingStage: "review", rescues: 0, history: [] });
  });
  it("an implement result with a capability escalation goes to the question check (AC-17)", () => {
    const r = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: { escalation: qCapability }, head: HEAD });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "question-check", question: qCapability, askingStage: "implement", pr: null, implementFailures: 0, scopeViolations: 0 });
    const p = transition(at("plan"), { type: "stage_ok", stage: "plan", result: { escalation: qProduct }, head: HEAD });
    expect(p.state).toMatchObject({ stage: "question-check", askingStage: "plan", plan: null });
    const f = transition(at("fix", { pr: pr3, fixes: 1, pendingFixInput: "fix it" }), { type: "stage_ok", stage: "fix", result: { escalation: q }, head: HEAD });
    expect(f.state).toMatchObject({ stage: "question-check", askingStage: "fix", fixes: 1, pr: pr3, pendingFixInput: "fix it" });
  });
  it("a spec question of kind technical goes to the question check, keeping the spec track and mode", () => {
    const r = transition(at("spec", { track: "spec", specMode: "write" }), specOk({ verdict: "question", question: q }));
    expect(r.state).toMatchObject({ stage: "question-check", askingStage: "spec", question: q, track: "spec", specMode: "write" });
  });
  it("checks pending six hours re-run and investigate first, then ask (AC-17)", () => {
    const pending = (at: string) => ({ type: "checks" as const, status: "pending" as const, sensitive: false, at, pending: ["ci/test", "ci/lint"] });
    let r = transition(at("verify", { pr: pr3 }), pending(AT));
    expect(r.actions).toEqual([{ type: "wait", seconds: 60 }]);
    expect(r.state.pendingSince).toBe(AT);
    r = transition(r.state, pending(plusH(5.99)));
    expect(r.actions).toEqual([{ type: "wait", seconds: 60 }]);
    expect(r.state.pendingSince).toBe(AT);
    r = transition(r.state, pending(plusH(6)));
    expect(r.actions).toEqual([
      { type: "rerun_checks", sha: pr3.head_sha },
      { type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.any(String) },
    ]);
    expect(r.state.pendingFixInput).toBe(
      `Required checks ci/test, ci/lint have been pending for 6 hours on ${pr3.head_sha}; the scheduler has re-run those it could. Investigate why they never report: the workflow files and triggers that should produce them, and whether each check has a run. Fix the cause if it is in this repository; otherwise change nothing and say so. If a check is obsolete (nothing produces it any more and nothing it guards remains), record a finding that names its \`required_checks\` entry in agents/scheduler.yaml for removal, a change agents make in their own reviewed PR; do not edit that file here.`,
    );
    expect(r.state).toMatchObject({ stage: "fix", checksRerun: true, pendingSince: null });
    // The fix ran; verify starts a new window.
    const t1 = plusH(10);
    r = transition({ ...r.state, stage: "verify" }, pending(t1));
    expect(r.state.pendingSince).toBe(t1);
    r = transition(r.state, pending(plusH(16)));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "question-check", askingStage: "verify", pendingSince: null });
    expect(r.state.question?.kind).toBe("capability");
    expect(r.state.question?.question).toContain("A required check never reported on PR #3");
    // C9: the maintainer is offered only what agents cannot do; dropping the check is the fix input's agent action.
    expect(r.state.question?.options.map((o) => o.label)).toEqual(["fixed, re-check"]);
    expect(r.state.question?.options.every((o) => o.cost.length > 0)).toBe(true);
    expect(r.state.question?.recommendation.length).toBeGreaterThan(0);
  });
  it("green and failed checks clear the pending window and the re-run flag", () => {
    const s = at("verify", { pr: pr3, pendingSince: AT, checksRerun: true });
    const g = transition(s, { type: "checks", status: "green", sensitive: false, at: plusH(1) });
    expect(g.state).toMatchObject({ stage: "review", pendingSince: null, checksRerun: false });
    const f = transition(s, { type: "checks", status: "failed", log: "FAIL", sensitive: false, at: plusH(1) });
    expect(f.state).toMatchObject({ stage: "fix", pendingSince: null, checksRerun: false });
  });
  it("send pauses with a single pause action (AC-13)", () => {
    const r = transition(at("question-check", { question: q, askingStage: "spec", track: "spec" }), checkSays("send"));
    expect(r.actions).toEqual([{ type: "pause", question: q, asking: "spec" }]);
    expect(r.state.stage).toBe("paused");
    expect(r.state).toMatchObject({ question: q, askingStage: "spec", decideReturns: 0 });
  });
  it("a question from a stage resumed with a reply is a follow-up: paused at once, nothing counted (AC-15)", () => {
    const reply = "Question #5: Which GPU do you mean? Tell me more.";
    const followUp = (question: Question): Question => ({ ...question, follow_up: true, reply_quote: "which GPU  do you\nmean?" });
    const s = at("implement", { answer: reply, answerQuestionId: 5, answerQuestionIds: [5], answerKind: "capability", plan });
    const r = transition(s, { type: "stage_ok", stage: "implement", result: { escalation: followUp(qCapability) }, head: HEAD });
    expect(r.actions).toEqual([{ type: "pause", question: followUp(qCapability), asking: "implement" }]);
    expect(r.state).toMatchObject({ stage: "paused", askingStage: "implement", decideReturns: 0, implementFailures: 0, rescues: 0, fixes: 0 });
    expect(r.state.history).toEqual([]);
    const rv = transition(at("review", { pr: pr3, answer: reply }), reviewEscalates(followUp(q)));
    expect(rv.actions).toEqual([{ type: "pause", question: followUp(q), asking: "review" }]);
    const sp = transition(at("spec", { track: "spec", specMode: "answer", answer: reply }), specOk({ verdict: "question", question: followUp(qProduct) }));
    expect(sp.actions).toEqual([{ type: "pause", question: followUp(qProduct), asking: "spec" }]);
    expect(sp.state).toMatchObject({ track: "spec", specMode: "answer" });
  });
  it("with a reply present, a question that is not a marked follow-up quoting the reply goes to the question check (C2)", () => {
    const reply = "Question #5: Use lru.";
    for (const question of [q, { ...q, follow_up: true, reply_quote: "something the maintainer never wrote" }]) {
      const r = transition(at("implement", { answer: reply, answerQuestionIds: [5], answerKind: "technical", plan }), { type: "stage_ok", stage: "implement", result: { escalation: question }, head: HEAD });
      expect(r.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 1 }]);
      expect(r.state).toMatchObject({ stage: "question-check", askingStage: "implement", answer: reply });
    }
  });
  it("a review follow-up of kind other pauses: the follow-up row comes first (T-minor 2)", () => {
    const fu: Question = { ...qOther, follow_up: true, reply_quote: "What breaks if we skip it?" };
    const r = transition(at("review", { pr: pr3, answer: "Question #5: What breaks if we skip it?" }), reviewEscalates(fu));
    expect(r.actions).toEqual([{ type: "pause", question: fu, asking: "review" }]);
  });
  it("in decide mode any question marked new_blocker goes to the check; an unmarked one fails the run (C3, CM2)", () => {
    const decide = { decideInput: "pick lru", decidedQuestion: q, plan };
    const escalates = (question: Question) => ({ type: "stage_ok" as const, stage: "implement" as const, result: { escalation: question }, head: HEAD });
    for (const question of [{ ...qCapability, new_blocker: true }, { ...qProduct, new_blocker: true }, { ...q, question: "Which eviction policy?", new_blocker: true }]) {
      const r = transition(at("implement", decide), escalates(question));
      expect(r.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 1 }]);
      expect(r.state).toMatchObject({ question, askingStage: "implement", decideInput: "pick lru", decidedQuestion: q });
    }
    for (const question of [q, qProduct]) {
      const r = transition(at("implement", decide), escalates(question));
      expect(r.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 2 }]);
      expect(r.state.history).toEqual(["implement attempt 1 failed: escalated in decide mode"]);
    }
    // The check returning the same question again is the second decide_yourself: a bound hit.
    const again = transition(at("question-check", { ...decide, question: { ...q, new_blocker: true }, askingStage: "implement", decideReturns: 1 }), checkSays("decide_yourself", "same question"));
    expect(again.state).toMatchObject({ decideReturns: 2, rescues: 1, rescueRun: true });
    // decide_yourself keeps the question it sent back; a spec question of kind other is kept the same way.
    const d = transition(at("question-check", { question: qProduct, askingStage: "plan" }), checkSays("decide_yourself", "decide"));
    expect(d.state).toMatchObject({ stage: "plan", decidedQuestion: qProduct, decideInput: "decide" });
    const o = transition(at("spec", { track: "spec", specMode: "write" }), specOk({ verdict: "question", question: qOther }));
    expect(o.state.decidedQuestion).toEqual(qOther);
    const settled = transition(d.state, { type: "stage_ok", stage: "plan", result: plan });
    expect(settled.state).toMatchObject({ decideInput: null, decidedQuestion: null });
  });
  it("decide mode is checked before the follow-up rule (Tm1)", () => {
    const fu: Question = { ...q, follow_up: true, reply_quote: "Which cache do you mean?" };
    const r = transition(at("implement", { plan, decideInput: "d", decidedQuestion: q, answer: "Question #5: Which cache do you mean?" }), { type: "stage_ok", stage: "implement", result: { escalation: fu }, head: HEAD });
    expect(r.state.history).toEqual(["implement attempt 1 failed: escalated in decide mode"]);
  });
  it("a follow-up quote must be at least 15 characters of the latest reply as written, and a question or a request (Tm1)", () => {
    const state = at("implement", { plan, answer: "Question #5: Use lru.\n\nQuestion #6: Fine. Which size do you suggest?", answerQuestionIds: [5, 6], answerKind: "capability" });
    const toCheck = (quote: string) => {
      const r = transition(state, { type: "stage_ok", stage: "implement", result: { escalation: { ...qCapability, follow_up: true, reply_quote: quote } }, head: HEAD });
      return r.state.stage;
    };
    expect(toCheck("Which size do you suggest?")).toBe("paused");
    expect(toCheck("which size do  you\nsuggest")).toBe("paused"); // a request word, whitespace and case aside
    expect(toCheck("size?")).toBe("question-check"); // too short
    expect(toCheck("Fine. Which size do you")).toBe("question-check"); // neither a question mark nor a request word first
    expect(toCheck("Question #6: Fine. Which size")).toBe("question-check"); // the prefix is not the reply
    expect(toCheck("Use lru. What else?")).toBe("question-check"); // not in the latest reply
  });
  it("an answer ends decide mode (Tm2)", () => {
    const r = transition(at("paused", { question: qCapability, askingStage: "implement", plan, decideInput: "d", decidedQuestion: q }), answered());
    expect(r.state).toMatchObject({ stage: "implement", decideInput: null, decidedQuestion: null });
  });
  it("decide_yourself reruns the asker in decide mode; the second one escalates (AC-14)", () => {
    const r1 = transition(at("question-check", { question: q, askingStage: "implement", plan }), checkSays("decide_yourself", "pick lru"));
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 1 }]);
    expect(r1.state).toMatchObject({ stage: "implement", decideInput: "pick lru", decideReturns: 1, question: null });
    const ok = transition(r1.state, { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } });
    expect(ok.state).toMatchObject({ stage: "verify", decideInput: null });
    const r2 = transition(at("question-check", { question: q, askingStage: "implement", decideReturns: 1 }), checkSays("decide_yourself", "again"));
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 1 }]);
    expect(r2.state).toMatchObject({ decideReturns: 2, rescues: 1, rescueRun: true, decideInput: null });
    expect(r2.state.history.at(-1)).toBe("implement: decide_yourself: again");
    const rv = transition(at("question-check", { question: q, askingStage: "review", sensitive: true, securityPass: true, pr: pr3 }), checkSays("decide_yourself", "decide"));
    expect(rv.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
    const fx = transition(at("question-check", { question: q, askingStage: "fix", pr: pr3, pendingFixInput: "fix it" }), checkSays("decide_yourself", "decide"));
    expect(fx.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: "fix it" }]);
    expect(fx.state.decideInput).toBe("decide");
  });
  it("decide_yourself for the spec stage reruns it in decide mode on the spec track (AC-14)", () => {
    const r = transition(at("question-check", { question: q, askingStage: "spec", track: "spec", specMode: "write" }), checkSays("decide_yourself", "decide it"));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "spec", specMode: "decide", decideInput: "decide it", track: "spec", decideReturns: 1 });
    const ok = transition(r.state, specOk(revised));
    expect(ok.state).toMatchObject({ stage: "verify", decideInput: null, specMode: null });
  });
  it("decide_yourself for verify escalates with a rescue fix (AC-14)", () => {
    const r = transition(at("question-check", { question: qCapability, askingStage: "verify", pr: pr3 }), checkSays("decide_yourself", "drop the check yourself"));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("drop the check yourself") }]);
    expect(r.state).toMatchObject({ stage: "fix", rescues: 1, rescueRun: true, decideReturns: 1, decideInput: null });
    expect(r.state.history.at(-1)).toBe("fix: decide_yourself: drop the check yourself");
  });
  it("a question in decide mode counts as a failed run (AC-14)", () => {
    const rv = transition(at("review", { pr: pr3, decideInput: "decide" }), reviewEscalates(q));
    expect(rv.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 2 }]);
    expect(rv.state.history).toEqual(["review attempt 1 failed: escalated in decide mode"]);
    expect(rv.state.decideInput).toBe("decide");
    const im = transition(at("implement", { decideInput: "decide" }), { type: "stage_ok", stage: "implement", result: { escalation: q }, head: HEAD });
    expect(im.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 2 }]);
    expect(im.state).toMatchObject({ implementFailures: 1, decideInput: "decide" });
    const fx = transition(at("fix", { pr: pr3, decideInput: "decide", pendingFixInput: "fix it" }), { type: "stage_ok", stage: "fix", result: { escalation: q }, head: HEAD });
    expect(fx.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: "fix it" }]);
    expect(fx.state).toMatchObject({ rescues: 1, rescueRun: true });
    for (const kind of [qProduct, qOther]) {
      const sp = transition(at("spec", { track: "spec", specMode: "decide", decideInput: "decide" }), specOk({ verdict: "question", question: kind }));
      expect(sp.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 2 }]);
      expect(sp.state).toMatchObject({ specMode: "decide", decideReturns: 0 });
      expect(sp.state.history).toEqual(["spec attempt 1 failed: escalated in decide mode"]);
    }
    // A failed run inside a rescue escalates at once.
    const rescued = transition(at("plan", { decideInput: "decide", rescueRun: true, rescues: 1 }), { type: "stage_ok", stage: "plan", result: { escalation: q }, head: HEAD });
    expect(rescued.state).toMatchObject({ replans: 1, stage: "plan" });
  });
  it("a spec question of kind other counts as a decide_yourself (AC-14)", () => {
    const r1 = transition(at("spec", { track: "spec", specMode: "write" }), specOk({ verdict: "question", question: qOther }));
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r1.state).toMatchObject({ stage: "spec", specMode: "decide", decideInput: "kind other is not a question for the maintainer", decideReturns: 1, track: "spec" });
    const r2 = transition(at("spec", { track: "spec", specMode: "write", decideReturns: 1 }), specOk({ verdict: "question", question: qOther }));
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r2.state).toMatchObject({ decideReturns: 2, specRescues: 1, rescueRun: true, specMode: "write" });
    expect(r2.state.history.at(-1)).toBe("spec: decide_yourself: kind other is not a question for the maintainer");
  });
  it("a review escalation of kind other stays a bound hit even with a reply as input (AC-8)", () => {
    const r = transition(at("review", { pr: pr3, answer: "a", decideInput: "d" }), reviewEscalates(qOther));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("The suite cannot run here") }]);
    expect(r.state).toMatchObject({ rescues: 1, rescueRun: true, decideInput: null });
  });
  it("a failing question check retries once, then escalates the asking stage (AC-12)", () => {
    const s = at("question-check", { question: q, askingStage: "plan" });
    const r1 = transition(s, { type: "stage_failed", stage: "question-check", reason: "timeout" });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "question-check", attempt: 2 }]);
    expect(r1.state).toMatchObject({ question: q, askingStage: "plan", rescues: 0 });
    const r2 = transition(r1.state, { type: "stage_failed", stage: "question-check", reason: "timeout" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 1 }]);
    expect(r2.state).toMatchObject({ stage: "plan", rescues: 1, rescueRun: true });
    expect(r2.state.history.at(-1)).toBe("plan: question check failed twice: timeout");
    const v = transition(at("question-check", { question: qCapability, askingStage: "verify", attempt: 2, pr: pr3 }), { type: "stage_failed", stage: "question-check", reason: "timeout" });
    expect(v.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.stringContaining("timeout") }]);
    expect(v.state).toMatchObject({ rescues: 1, rescueRun: true });
    const sp = transition(at("question-check", { question: q, askingStage: "spec", attempt: 2, track: "spec", specMode: "answer" }), { type: "stage_failed", stage: "question-check", reason: "t" });
    expect(sp.state).toMatchObject({ stage: "spec", specRescues: 1, specMode: "answer", track: "spec" });
  });
});

describe("chain: answers (AC-18)", () => {
  it("answers route by asking stage and kind (AC-18)", () => {
    const sp = transition(at("paused", { question: qProduct, askingStage: "spec", track: "spec", specMode: "answer" }), answered());
    expect(sp.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(sp.state).toMatchObject({ specMode: "answer", answer: "Question #5: use lru", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product", question: null });
    expect(sp.state.pendingAnswer).toEqual({ ids: [5], kind: "product", text: "Question #5: use lru" });

    for (const [question, asking] of [[q, "plan"], [qProduct, "plan"], [q, "implement"], [qProduct, "implement"]] as const) {
      const r = transition(at("paused", { question, askingStage: asking }), answered());
      expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
      expect(r.state).toMatchObject({ stage: "spec", specMode: "record", track: "spec", parkedPr: null, answerKind: question.kind });
    }

    const rp = transition(at("paused", { question: qProduct, askingStage: "review", pr: pr3 }), answered());
    expect(rp.state).toMatchObject({ stage: "spec", specMode: "record", track: "spec", parkedPr: pr3, pr: null, answerKind: "product" });
    const fp = transition(at("paused", { question: qProduct, askingStage: "fix", pr: pr3 }), answered());
    expect(fp.state).toMatchObject({ stage: "spec", specMode: "record", parkedPr: pr3, pr: null });

    const rt = transition(at("paused", { question: q, askingStage: "review", pr: pr3 }), answered());
    expect(rt.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: expect.any(String) }]);
    expect(rt.state).toMatchObject({ stage: "fix", recordAnswer: true, pr: pr3, track: "issue" });
    expect(rt.state.pendingFixInput).toBe(
      "Record the maintainer's decision as an ADR under docs/decisions/, marked (maintainer answer, question #5), then apply it:\nWhich cache?\nAnswer: use lru",
    );

    const vc = transition(at("paused", { question: qCapability, askingStage: "verify", pr: pr3, pendingSince: AT, checksRerun: true }), answered("re-check now"));
    expect(vc.actions).toEqual([{ type: "verify" }]);
    expect(vc.state).toMatchObject({ stage: "verify", pendingSince: null, recordAnswer: false, answer: "Question #5: re-check now", answerKind: "capability", pendingAnswer: null });

    const ic = transition(at("paused", { question: qCapability, askingStage: "implement", plan }), answered());
    expect(ic.actions).toEqual([{ type: "run_stage", stage: "implement", attempt: 1 }]);
    expect(ic.state).toMatchObject({ recordAnswer: false, answer: "Question #5: use lru", track: "issue", pendingAnswer: null });
    const fc = transition(at("paused", { question: qCapability, askingStage: "fix", pr: pr3, pendingFixInput: "fix it" }), answered());
    expect(fc.actions).toEqual([{ type: "run_stage", stage: "fix", attempt: 1, fixInput: "fix it" }]);
    const rc = transition(at("paused", { question: qCapability, askingStage: "review", pr: pr3, sensitive: true, securityPass: true }), answered());
    expect(rc.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("on the spec track a review or fix decision is recorded by a fix on the spec PR, never by parking it", () => {
    for (const question of [q, qProduct]) {
      const r = transition(at("paused", { question, askingStage: "review", track: "spec", pr: pr8 }), answered());
      expect(r.state).toMatchObject({ stage: "fix", track: "spec", pr: pr8, parkedPr: null, recordAnswer: false, answerQuestionId: 5, answerKind: question.kind });
      expect(r.state.pendingFixInput).toContain("(maintainer answer, question #5)");
    }
  });
  it("an answer at the fix bound escalates; the re-plan records the unrecorded answer first (AC-18, T4)", () => {
    const r = transition(at("paused", { question: q, askingStage: "review", fixes: 2, rescues: 1, pr: pr3 }), answered());
    expect(r.actions).toEqual([
      { type: "close_pr", pr: 3, branch: "issue-1", comment: expect.any(String) },
      { type: "run_stage", stage: "spec", attempt: 1 },
    ]);
    expect(r.state).toMatchObject({
      stage: "spec", specMode: "record", track: "spec", replans: 1, pr: null, recordAnswer: false,
      answer: "Question #5: use lru", answerQuestionIds: [5], answerKind: "technical", pendingAnswer: { ids: [5], kind: "technical", text: "Question #5: use lru" },
    });
    // After that spec PR merges, plan runs with the answer recorded and gone from the ledger.
    const merged = transition({ ...r.state, stage: "merge", pr: pr8 }, { type: "merge_result", status: "merged", specGate: { ok: true } });
    expect(merged.actions.at(-1)).toEqual({ type: "run_stage", stage: "plan", attempt: 1 });
    expect(merged.state).toMatchObject({ pendingAnswer: null, answer: null, answerQuestionIds: [], answerKind: null, track: "issue" });
  });
  it("answer fields clear on the resumed stage's success, and when verify moves on (AC-18)", () => {
    const answeredState = { answer: "a", answerQuestionId: 5, answerKind: "capability" as const };
    const im = transition(at("implement", { ...answeredState, plan }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } });
    expect(im.state).toMatchObject({ answer: null, answerQuestionId: null, answerKind: null });
    const fx = transition(at("fix", { answer: "a", answerQuestionId: 5, answerKind: "technical", recordAnswer: true, pr: pr3 }), fixOk("c".repeat(40)));
    expect(fx.state).toMatchObject({ answer: null, answerQuestionId: null, answerKind: null, recordAnswer: false });
    for (const status of ["green", "failed"] as const) {
      const v = transition(at("verify", { ...answeredState, pr: pr3 }), { type: "checks", status, sensitive: false, at: AT, log: "x" });
      expect(v.state).toMatchObject({ answer: null, answerQuestionId: null, answerKind: null });
    }
    const pend = transition(at("verify", { ...answeredState, pr: pr3 }), { type: "checks", status: "pending", sensitive: false, at: AT });
    expect(pend.state).toMatchObject({ answer: "a", answerQuestionId: 5 });
    // On the spec track the spec stage's success clears the reply, but the question id and kind stay for the spec PR until it merges.
    const sp = transition(at("spec", { track: "spec", specMode: "record", answer: "a", answerQuestionId: 5, answerKind: "product" }), specOk(revised));
    expect(sp.state).toMatchObject({ answer: null, answerQuestionId: 5, answerKind: "product", specMode: null });
    const spFix = transition({ ...sp.state, stage: "fix" }, fixOk("c".repeat(40)));
    expect(spFix.state).toMatchObject({ answerQuestionId: 5, answerKind: "product" });
  });
});

describe("chain: answer chains and unrecorded answers (final review T3, T4, T-minor 3)", () => {
  it("a follow-up's reply adds to the first: every id, both texts, the strongest kind routes (T3)", () => {
    // A product question from review, a follow-up of kind capability, then the second reply.
    const first = transition(at("paused", { question: qProduct, askingStage: "review", pr: pr3 }), answered("Which widget do you mean?", 5));
    expect(first.state).toMatchObject({ stage: "spec", specMode: "record", answerQuestionIds: [5], answerKind: "product", recordIds: [5], recordKind: "product" });
    const asked = { ...first.state, stage: "paused" as const, question: { ...qCapability, follow_up: true, reply_quote: "Which widget do you mean?" }, askingStage: "spec" as const };
    const second = transition(asked, answered("The clock widget.", 6));
    expect(second.state).toMatchObject({
      stage: "spec", specMode: "record", answerQuestionId: 6, answerQuestionIds: [5, 6], answerKind: "product", recordIds: [5, 6], recordKind: "product",
      answer: "Question #5: Which widget do you mean?\n\nQuestion #6: The clock widget.",
      pendingAnswer: { ids: [5, 6], kind: "product", text: "Question #5: Which widget do you mean?\n\nQuestion #6: The clock widget." },
    });
    // A capability follow-up's reply after an unrecorded technical one keeps the technical route: the fix records an ADR with both marks.
    const tech = {
      ...at("paused", { question: { ...qCapability, follow_up: true, reply_quote: "lru, but which size?" }, askingStage: "review", pr: pr3 }),
      answer: "Question #5: lru, but which size?", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "technical" as const, recordIds: [5], recordKind: "technical" as const,
    };
    const r = transition(tech, answered("1000 entries", 6));
    expect(r.state).toMatchObject({ stage: "fix", recordAnswer: true, answerQuestionIds: [5, 6], recordIds: [5, 6], answerKind: "technical" });
    expect(r.state.pendingFixInput).toContain("marked (maintainer answer, question #5), (maintainer answer, question #6)");
    expect(r.state.pendingFixInput).toContain("No GPU on this runner\nAnswer: 1000 entries");
  });
  it("on a spec PR that recorded a product answer, a later capability answer is not a decision to record (Task 6 minor, TI1)", () => {
    const pending = { ids: [5], kind: "product" as const, text: "Question #5: yes" };
    const s = at("paused", { track: "spec", pr: pr8, question: qCapability, askingStage: "review", answer: null, answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product", recordIds: [], pendingAnswer: pending });
    const r = transition(s, answered("the runner is back", 6));
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    expect(r.state).toMatchObject({ answerQuestionIds: [5, 6], answerKind: "product", recordIds: [], recordKind: null, answer: "Question #6: the runner is back" });
    expect(r.state.pendingAnswer).toEqual(pending);
  });
  it("two answers on one spec PR: the second must be recorded on its own, whatever marks the PR already carries (TI1)", () => {
    const pending = { ids: [5], kind: "product" as const, text: "Question #5: yes" };
    const s = at("paused", { track: "spec", pr: pr8, question: q, askingStage: "review", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product", recordIds: [], pendingAnswer: pending });
    const r = transition(s, answered("use lru", 6));
    expect(r.state).toMatchObject({ stage: "fix", recordIds: [6], recordKind: "technical", answerQuestionIds: [5, 6] });
    expect(r.state.pendingFixInput).toContain("marked (maintainer answer, question #6), then apply it");
    expect(r.state.pendingFixInput).not.toContain("question #5)");
    expect(r.state.pendingAnswer).toEqual({ ids: [5, 6], kind: "product", text: "Question #5: yes\n\nQuestion #6: use lru" });
    // The fix that records it clears what was to record; the spec PR keeps the product kind for its scope.
    const done = transition(r.state, fixOk("c".repeat(40)));
    expect(done.state).toMatchObject({ recordIds: [], recordKind: null, answerKind: "product" });
  });
  it("two questions in a row from the spec stage: both answers are to record, and its revised result clears them (TI1, Tm5)", () => {
    const pending = { ids: [5], kind: "product" as const, text: "Question #5: yes" };
    const s = at("paused", { track: "spec", specMode: "write", question: q, askingStage: "spec", answer: "Question #5: yes", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product", recordIds: [5], recordKind: "product", pendingAnswer: pending });
    const r = transition(s, answered("use lru", 6));
    expect(r.state).toMatchObject({ stage: "spec", specMode: "write", recordIds: [5, 6], recordKind: "product" });
    expect(r.state.pendingAnswer?.ids).toEqual([5, 6]);
    const ok = transition(r.state, specOk(revised));
    expect(ok.state).toMatchObject({ recordIds: [], recordKind: null, answerQuestionIds: [5, 6] });
  });
  it("a claim seeded with an unrecorded answer starts at the spec stage in record mode with the answer (T4)", () => {
    const ledger = { ...ledgerOf(initialChainState(1)), replans: 1, pendingAnswer: { ids: [5], kind: "product" as const, text: "Question #5: yes" } };
    const s = initialChainState(1, null, ledger);
    const r = transition(s, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "spec", attempt: 1 }]);
    expect(r.state).toMatchObject({ stage: "spec", specMode: "record", track: "spec", answer: "Question #5: yes", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "product" });
    // With a spec problem the spec stage writes the spec and records the answer in the same PR.
    const w = transition(initialChainState(1, "spec missing", ledger), { type: "start" });
    expect(w.state).toMatchObject({ specMode: "write", answerQuestionIds: [5], answerKind: "product" });
    // A ledger written before T4 and C7 loads with the new fields defaulted.
    const old = { rescues: 1, specRescues: 0, replans: 0, specRevisions: 0, specAnswers: 0, decideReturns: 0, history: [] };
    expect(initialChainState(1, null, old)).toMatchObject({ pendingAnswer: null, chainFailures: null, chainErrors: 0 });
    expect(ledgerOf(initialChainState(1, null, old))).toEqual({ ...old, pendingAnswer: null, chainFailures: null, chainErrors: 0 });
  });
  it("a liveness release keeps the unrecorded answer in the ledger (T4)", () => {
    const pending = { ids: [5], kind: "technical" as const, text: "Question #5: lru" };
    const r = transition(at("fix", { pr: pr3, recordAnswer: true, answer: "Question #5: lru", answerQuestionIds: [5], answerKind: "technical", pendingAnswer: pending }), { type: "liveness_expired" });
    expect(r.state.stage).toBe("released");
    expect(ledgerOf(r.state).pendingAnswer).toEqual(pending);
  });
  it("the issue PR's merge and a merged spec PR clear the unrecorded answer; capability answers never set it (T4)", () => {
    const pending = { ids: [5], kind: "technical" as const, text: "Question #5: lru" };
    expect(transition(at("merge", { pr: pr3, pendingAnswer: pending }), { type: "merge_result", status: "merged" }).state.pendingAnswer).toBeNull();
    const ui = transition(at("merge", { track: "spec", pr: pr8, pendingAnswer: pending }), { type: "merge_result", status: "merged", specGate: { ok: false, gate: "ui-design", reason: "x" } });
    expect(ui.state.pendingAnswer).toBeNull();
    expect(transition(at("paused", { question: qCapability, askingStage: "implement", plan }), answered()).state.pendingAnswer).toBeNull();
  });
  it("a re-plan or a spec revision drops the answer fields the closed PR was applying (T-minor 3)", () => {
    const applying = { answer: "Question #5: retry", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "capability" as const, decideInput: "d", decidedQuestion: q };
    const replan = transition(at("fix", { pr: pr3, rescues: 1, rescueRun: true, pendingFixInput: "x", ...applying }), { type: "stage_failed", stage: "fix", reason: "boom" });
    expect(replan.state).toMatchObject({ stage: "plan", replans: 1, answer: null, answerQuestionId: null, answerQuestionIds: [], answerKind: null, decideInput: null, decidedQuestion: null });
    const revise = transition(at("fix", { pr: pr3, rescues: 1, replans: 1, rescueRun: true, pendingFixInput: "x", ...applying }), { type: "stage_failed", stage: "fix", reason: "boom" });
    expect(revise.state).toMatchObject({ stage: "spec", specMode: "revise", answer: null, answerQuestionIds: [], answerKind: null });
  });
});

describe("chain: two reviews on a sensitive diff (final review C5)", () => {
  it("the normal review's approval runs the security review; its approval merges", () => {
    const s = at("review", { pr: pr3, sensitive: true });
    const n = transition(s, { type: "stage_ok", stage: "review", result: approve, security: false, sensitive: true });
    expect(n.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
    expect(n.state).toMatchObject({ stage: "review", securityPass: true });
    const sec = transition(n.state, { type: "stage_ok", stage: "review", result: approve, security: true, sensitive: true });
    expect(sec.actions).toEqual([{ type: "merge" }]);
    expect(sec.state.securityPass).toBe(false);
  });
  it("findings from either review go to the fix loop, and the next round starts with the normal review again", () => {
    for (const [pass, result] of [[false, changes], [true, changes], [false, { ...approve, findings_on_pr: changes.findings_on_pr }]] as const) {
      const r = transition(at("review", { pr: pr3, sensitive: true, securityPass: pass }), { type: "stage_ok", stage: "review", result, security: pass, sensitive: true });
      expect(r.state).toMatchObject({ stage: "fix", securityPass: false });
      const back = transition({ ...r.state, stage: "verify" }, { type: "checks", status: "green", sensitive: true, at: AT });
      expect(back.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    }
  });
  it("a diff the driver found sensitive gets the security review even when verify did not mark it", () => {
    const r = transition(at("review", { pr: pr3 }), { type: "stage_ok", stage: "review", result: approve, security: false, sensitive: true });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
});

describe("chain: the question check words the question (final review C10)", () => {
  it("on send, the check's question, options and recommendation are what pauses; the asking stage's kind stays", () => {
    const worded: Question = { kind: "technical", question: "Keep the cache in memory or on disk?", options: [{ label: "memory", cost: "lost on restart" }], recommendation: "memory" };
    const r = transition(at("question-check", { question: qProduct, askingStage: "plan" }), { type: "stage_ok", stage: "question-check", result: { verdict: "send", reasoning: "r", question: worded } });
    const sent = { ...worded, kind: "product" as const };
    expect(r.actions).toEqual([{ type: "pause", question: sent, asking: "plan" }]);
    expect(r.state.question).toEqual(sent);
  });
});

describe("chain: repeated chain errors (final review C7)", () => {
  it("the first chain_error releases with the error, a finding and a history entry; the next abandons", () => {
    const s = at("implement", { plan, chainFailures: { count: 3, last: "boom (at)x" } });
    const r = transition(s, { type: "chain_error", error: "GitHub said @someone 500" });
    expect(r.state).toMatchObject({ stage: "released", chainErrors: 1, chainFailures: null });
    expect(r.state.history.at(-1)).toBe("chain error in implement (counted): GitHub said @someone 500");
    expect(types(r.actions)).toEqual(["comment", "label", "finding", "notify", "release"]);
    const comment = r.actions[0] as Extract<Action, { type: "comment" }>;
    expect(comment.text).toContain("GitHub said (at)someone 500");
    expect(comment.text).not.toContain("@");
    expect(r.actions[2]).toMatchObject({ type: "finding", stage: "implement", finding: { evidence: "GitHub said @someone 500" } });
    expect(r.actions[3]).toMatchObject({ type: "notify", gate: "chain_error" });
    expect(ledgerOf(r.state)).toMatchObject({ chainErrors: 1, chainFailures: null });
    const again = transition({ ...initialChainState(1, null, ledgerOf(r.state)), stage: "verify", pr: pr3 }, { type: "chain_error", error: "boom" });
    expect(again.state.stage).toBe("abandoned");
    expect(again.actions.find((a) => a.type === "comment")).toMatchObject({ text: expect.stringContaining("chain-error release 1/1") });
    expect(again.actions.find((a) => a.type === "finding")).toMatchObject({ stage: "fix" });
  });
  it("a chain_error on the spec track closes the spec PR like a liveness release", () => {
    const r = transition(at("fix", { track: "spec", pr: pr8, parkedPr: pr3 }), { type: "chain_error", error: "boom" });
    expect(types(r.actions).slice(0, 2)).toEqual(["close_pr", "close_pr"]);
    expect(r.state).toMatchObject({ pr: null, parkedPr: null });
  });
  it("MAX_CHAIN_ERRORS is one (AC-6)", () => {
    expect(MAX_CHAIN_ERRORS).toBe(1);
  });
});

describe("chain: formatQuestion (AC-13)", () => {
  it("formatQuestion: heading, mention, nonce last", () => {
    const text = formatQuestion(q, "m", "n1");
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(["### Question for the maintainer", "@m"]);
    expect(lines.at(-1)).toBe("<!-- panelator-question:n1 -->");
    expect(lines).toContain("Which cache?");
    expect(lines).toContain("1. lru — memory");
    expect(lines).toContain("2. none — latency");
    expect(lines).toContain("Recommendation: lru");
    expect(lines).toContain("Reply in a comment on this issue; the scheduler resumes on your reply.");
    expect(text.indexOf("Which cache?")).toBeLessThan(text.indexOf("1. lru"));
    expect(text.indexOf("2. none")).toBeLessThan(text.indexOf("Recommendation:"));
    expect(text.indexOf("Recommendation:")).toBeLessThan(text.indexOf("Reply in a comment"));
    expect(text.match(/@/g)).toHaveLength(1);
  });
  it("formatQuestion is the question body followed by the marker (C9)", () => {
    expect(formatQuestion(q, "m", "n1")).toBe(`${questionBody(q, "m")}\n\n${questionMarker("n1")}`);
    expect(questionMarker("abc")).toBe("<!-- panelator-question:abc -->");
  });
});

const headOf = (e: ChainEvent) => (e as { head?: string }).head;

describe("chain: every event in every stage (AC-27)", () => {
  const STAGES: ChainStage[] = [
    "claimed", "plan", "implement", "verify", "review", "fix", "merge", "spec", "question-check", "done", "released", "waiting", "paused", "abandoned",
  ];
  const AGENT: AgentStageName[] = ["plan", "implement", "review", "fix", "spec", "question-check"];
  const ENDED: ChainStage[] = ["done", "released", "abandoned", "paused"];
  const EVENTS_FAILED: ChainEvent[] = AGENT.flatMap((stage): ChainEvent[] => [
    { type: "stage_failed", stage, reason: "boom" },
    { type: "stage_failed", stage, reason: "429", postpone: true },
  ]);
  const scopeBad = { ok: false as const, violations: ["web/x.ts: outside scope"] };
  const EVENTS: ChainEvent[] = [
    { type: "start" },
    { type: "stage_ok", stage: "plan", result: plan },
    { type: "stage_ok", stage: "plan", result: { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Q"] } },
    { type: "stage_ok", stage: "plan", result: { escalation: q }, head: HEAD },
    { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } },
    { type: "stage_ok", stage: "implement", result: impl, scope: scopeBad },
    { type: "stage_ok", stage: "implement", result: { escalation: qCapability }, head: HEAD },
    { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: true } },
    { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: scopeBad },
    { type: "stage_ok", stage: "fix", result: { escalation: qProduct }, head: HEAD },
    { type: "stage_ok", stage: "review", result: approve, security: false },
    { type: "stage_ok", stage: "review", result: changes, security: true },
    { type: "stage_ok", stage: "review", result: { ...approve, verdict: "escalate", escalation: q }, security: false },
    { type: "stage_ok", stage: "review", result: { ...approve, verdict: "escalate", escalation: qOther }, security: false },
    { type: "stage_ok", stage: "spec", result: revised, scope: { ok: true } },
    { type: "stage_ok", stage: "spec", result: revised, scope: scopeBad },
    { type: "stage_ok", stage: "spec", result: { verdict: "question", question: qProduct }, head: HEAD },
    { type: "stage_ok", stage: "spec", result: { verdict: "question", question: qOther }, head: HEAD },
    { type: "stage_ok", stage: "question-check", result: { verdict: "send", reasoning: "r" } },
    { type: "stage_ok", stage: "question-check", result: { verdict: "decide_yourself", reasoning: "r" } },
    ...EVENTS_FAILED,
    { type: "checks", status: "green", sensitive: false, at: AT },
    { type: "checks", status: "failed", log: "FAIL", sensitive: false, at: AT },
    { type: "checks", status: "pending", sensitive: false, at: AT, pending: ["ci/test"] },
    { type: "merge_result", status: "merged" },
    { type: "merge_result", status: "merged", specGate: { ok: true } },
    { type: "merge_result", status: "merged", specGate: { ok: false, gate: "spec-present", reason: "no Parent" } },
    { type: "merge_result", status: "merged", specGate: { ok: false, gate: "ui-design", reason: "no design" } },
    { type: "merge_result", status: "not_mergeable", detail: "conflict" },
    { type: "head_moved", head_sha: "e".repeat(40) },
    { type: "rebase_conflict", detail: "CONFLICT a.ts" },
    answered(),
    { type: "liveness_expired" },
    { type: "chain_error", error: "boom" },
  ];

  // Spec section 4, "Valid events", written out.
  function VALID(stage: ChainStage, e: ChainEvent): boolean {
    switch (e.type) {
      case "start": return stage === "claimed" || stage === "waiting";
      case "stage_ok":
      case "stage_failed": return e.stage === stage;
      case "checks": return stage === "verify";
      case "merge_result":
      case "head_moved": return stage === "merge";
      case "rebase_conflict": return ["plan", "implement", "review", "fix", "verify", "merge"].includes(stage);
      case "answered": return stage === "paused";
      case "liveness_expired":
      case "chain_error": return !ENDED.includes(stage);
    }
  }

  // A state that makes each stage's transitions meaningful: a PR, a plan, a pending question, a saved spec mode, a stage to resume.
  function fixture(stage: ChainStage, track: "issue" | "spec", variant: Partial<ChainState>): ChainState {
    return at(stage, {
      track, pr: track === "spec" ? pr8 : pr3, plan, specMode: "write", question: q, askingStage: "implement", resumeStage: "plan", pendingFixInput: "fix it",
      ...variant,
    });
  }
  // Ledger and history variants: a fresh issue, and one with every bound but abandonment used.
  const VARIANTS: Partial<ChainState>[] = [
    {},
    { rescues: 1, specRescues: 1, replans: 1, specRevisions: 1, specAnswers: 1, decideReturns: 1, fixes: 2, attempt: 2, planFailures: 1, implementFailures: 1, scopeViolations: 1, rescueRun: true },
    { answer: "a", answerQuestionId: 5, answerQuestionIds: [5], answerKind: "technical", decideInput: "d", parkedPr: pr3, pendingSince: AT, checksRerun: true, specProblem: "spec missing" },
    { pendingAnswer: { ids: [5], kind: "product", text: "Question #5: yes" }, securityPass: true, sensitive: true, decidedQuestion: q, recordIds: [5], recordKind: "product", chainErrors: 1, chainFailures: { count: 3, last: "x" } },
  ];

  it("every event in every stage: valid pairs never throw, invalid pairs throw the invalid-event error, nothing waits on a human but paused (AC-27)", () => {
    let valid = 0;
    let invalidPairs = 0;
    for (const stage of STAGES) {
      for (const track of stage === "spec" ? (["spec"] as const) : (["issue", "spec"] as const)) {
        for (const variant of VARIANTS) {
          const state = fixture(stage, track, variant);
          for (const event of EVENTS) {
            const label = `${stage}/${track}/${JSON.stringify(variant)}: ${JSON.stringify(event)}`;
            if (VALID(stage, event)) {
              valid++;
              let r: ReturnType<typeof transition> | undefined;
              expect(() => { r = transition(state, event); }, label).not.toThrow();
              expect(r!.state.stage as string, label).not.toBe("needs-human");
              expect(STAGES, label).toContain(r!.state.stage);
              const labels = r!.actions.filter((a): a is Extract<Action, { type: "label" }> => a.type === "label");
              expect(labels.some((a) => a.add.includes("needs-human")), label).toBe(false);
              if (r!.state.stage === "spec") expect(r!.state.track, label).toBe("spec");
              // Nothing waits on a human but paused: only a pause action stops for the maintainer.
              if (r!.state.stage === "paused") expect(r!.actions.map((a) => a.type), label).toEqual(["pause"]);
            } else {
              invalidPairs++;
              let err: unknown = null;
              try {
                transition(state, event);
              } catch (e) {
                err = e;
              }
              expect(err, label).toBeInstanceOf(Error);
              expect((err as Error).message, label).toMatch(/^invalid event /);
            }
          }
        }
      }
    }
    expect(valid).toBeGreaterThan(200);
    expect(invalidPairs).toBeGreaterThan(valid);
  });
  it("a postponed stage_failed in a rescue run leaves rescueRun true and every counter unchanged (AC-27)", () => {
    const counters = (s: ChainState) => ({
      rescues: s.rescues, specRescues: s.specRescues, replans: s.replans, specRevisions: s.specRevisions, specAnswers: s.specAnswers, decideReturns: s.decideReturns,
      fixes: s.fixes, planFailures: s.planFailures, implementFailures: s.implementFailures, scopeViolations: s.scopeViolations, attempt: s.attempt, history: s.history,
    });
    for (const stage of AGENT) {
      const s = fixture(stage, stage === "spec" ? "spec" : "issue", { rescueRun: true, rescues: 1, specRescues: 1, fixes: 1, attempt: 2, history: ["h"] });
      const r = transition(s, { type: "stage_failed", stage, reason: "429", postpone: true });
      expect(r.state, stage).toMatchObject({ stage: "waiting", resumeStage: stage, rescueRun: true });
      expect(counters(r.state), stage).toEqual(counters(s));
      expect(r.actions, stage).toEqual([{ type: "wait", seconds: 1800 }]);
    }
  });
  it("held work is carried, set or cleared by every valid pair, and cleared only when something is discarded (spec 011 AC-7)", () => {
    const heldVariants: ChainState["heldWork"][] = [null, { branch: "issue-1", head: "a".repeat(40) }, { branch: "spec-1", head: "a".repeat(40) }];
    const ledger = (s: ChainState) => s.rescues + s.specRescues + s.replans + s.specRevisions;
    let carried = 0;
    let cleared = 0;
    let set = 0;
    for (const stage of STAGES) {
      for (const track of stage === "spec" ? (["spec"] as const) : (["issue", "spec"] as const)) {
        for (const variant of VARIANTS) {
          for (const heldWork of heldVariants) {
            const state = fixture(stage, track, { ...variant, heldWork });
            for (const event of EVENTS) {
              if (!VALID(stage, event)) continue;
              const label = `${stage}/${track}/${JSON.stringify(variant)}/${JSON.stringify(heldWork)}: ${JSON.stringify(event)}`;
              const r = transition(state, event);
              const after = r.state.heldWork;
              if (event.type === "stage_ok" && headOf(event) !== undefined && r.state.stage !== "abandoned" && r.state.stage !== "released") {
                // A question routed from a plan, implement, fix or spec result records the new head, replacing any held work.
                if (after !== null && (r.state.stage === "question-check" || r.state.stage === "paused" || (r.state.stage === "spec" && r.state.specMode === "decide"))) {
                  expect(after, label).toEqual({ branch: track === "spec" ? "spec-1" : "issue-1", head: headOf(event) });
                  set++;
                  continue;
                }
              }
              if (["released", "abandoned", "done"].includes(r.state.stage) || event.type === "liveness_expired" || event.type === "chain_error") {
                expect(after, label).toBeNull();
                if (heldWork) cleared++;
                continue;
              }
              if (after === heldWork) { if (heldWork) carried++; continue; }
              // Cleared: only by a bound PR, the asking stage's failure, or an escalation (rescue, re-plan, spec revision).
              expect(after, label).toBeNull();
              cleared++;
              const bound = event.type === "stage_ok" && (event.stage === "implement" || event.stage === "fix" || event.stage === "spec") && r.state.pr !== null && heldWork!.branch === (track === "spec" ? "spec-1" : "issue-1");
              const askerFailed = (event.type === "stage_failed" && !event.postpone && event.stage === state.askingStage)
                // An unmarked question in decide mode counts as a failed run.
                || (event.type === "stage_ok" && headOf(event) !== undefined && state.decideInput !== null && event.stage === state.askingStage);
              expect(bound || askerFailed || ledger(r.state) > ledger(state) || r.state.stage === "abandoned", label).toBe(true);
            }
          }
        }
      }
    }
    expect(carried).toBeGreaterThan(50);
    expect(cleared).toBeGreaterThan(50);
    expect(set).toBeGreaterThan(5);
  });
  describe("held work (spec 011)", () => {
    const held = { branch: "issue-1", head: "a".repeat(40) };
    it("a stage_ok that raises a question without a head throws; review's does not", () => {
      expect(() => transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: { escalation: qCapability } })).toThrow(/without a head/);
      expect(() => transition(at("plan"), { type: "stage_ok", stage: "plan", result: { escalation: qProduct } })).toThrow(/without a head/);
      expect(() => transition(at("spec", { track: "spec", specMode: "write" }), { type: "stage_ok", stage: "spec", result: { verdict: "question", question: qOther } })).toThrow(/without a head/);
      expect(() => transition(at("review", { pr: pr3 }), reviewEscalates(qProduct))).not.toThrow();
    });
    it("a question records the branch and head; a second question replaces the held head", () => {
      const r = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: { escalation: qCapability }, head: HEAD });
      expect(r.state.heldWork).toEqual({ branch: "issue-1", head: HEAD });
      const again = transition(at("implement", { plan, heldWork: held }), { type: "stage_ok", stage: "implement", result: { escalation: qCapability }, head: "9".repeat(40) });
      expect(again.state.heldWork).toEqual({ branch: "issue-1", head: "9".repeat(40) });
      const sp = transition(at("spec", { track: "spec", specMode: "write" }), specOk({ verdict: "question", question: qProduct }));
      expect(sp.state.heldWork).toEqual({ branch: "spec-1", head: HEAD });
    });
    it("a kind-other spec question sent straight back to decide records the work", () => {
      const r = transition(at("spec", { track: "spec", specMode: "write" }), specOk({ verdict: "question", question: qOther }));
      expect(r.state).toMatchObject({ stage: "spec", specMode: "decide", heldWork: { branch: "spec-1", head: HEAD } });
    });
    it("a PR bound on the held branch clears it; a spec PR on spec-1 with work on issue-1 carries it", () => {
      const bound = transition(at("implement", { plan, heldWork: held }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: true } });
      expect(bound.state.heldWork).toBeNull();
      const record = transition(at("spec", { track: "spec", specMode: "record", heldWork: held }), specOk(revised));
      expect(record.state.heldWork).toEqual(held);
    });
    it("the asking stage's failure clears it; the question check's first failure and a postponement carry it", () => {
      const failed = transition(at("implement", { plan, heldWork: held, askingStage: "implement" }), { type: "stage_failed", stage: "implement", reason: "boom" });
      expect(failed.state.heldWork).toBeNull();
      const qc = at("question-check", { question: qCapability, askingStage: "implement", heldWork: held });
      expect(transition(qc, { type: "stage_failed", stage: "question-check", reason: "boom" }).state).toMatchObject({ stage: "question-check", attempt: 2, heldWork: held });
      expect(transition(qc, { type: "stage_failed", stage: "question-check", reason: "429", postpone: true }).state.heldWork).toEqual(held);
      expect(transition(qc, { type: "stage_ok", stage: "question-check", result: { verdict: "send", reasoning: "r" } }).state).toMatchObject({ stage: "paused", heldWork: held });
    });
    it("a spec PR merging on the spec track carries held work back to the issue track", () => {
      const r = transition(at("merge", { track: "spec", pr: pr8, heldWork: held }), { type: "merge_result", status: "merged", specGate: { ok: true } });
      expect(r.state).toMatchObject({ stage: "plan", track: "issue", heldWork: held });
    });
  });
  it("rebase_conflict is invalid in the spec stage and the question check", () => {
    expect(() => transition(at("spec", { track: "spec" }), { type: "rebase_conflict", detail: "x" })).toThrow(/^invalid event rebase_conflict /);
    expect(() => transition(at("question-check", { question: q, askingStage: "plan" }), { type: "rebase_conflict", detail: "x" })).toThrow(/^invalid event rebase_conflict /);
  });
});
