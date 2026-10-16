import { describe, expect, it } from "vitest";
import { initialChainState, transition } from "../src/chain/machine.ts";
import type { ChainState } from "../src/chain/types.ts";
import type { ImplementResult, PlanResult, ReviewResult } from "../src/types.ts";

const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }] };
const impl: ImplementResult = { pr_number: 3, head_sha: "b".repeat(40), tasks_done: ["T1"] };
const approve: ReviewResult = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
const changes: ReviewResult = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.ts", line: 1, scenario: "s" }], declined_to_judge: [] };

function at(stage: ChainState["stage"], over: Partial<ChainState> = {}): ChainState {
  return { ...initialChainState(1), stage, ...over };
}

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
    expect(r.state.pr).toEqual({ number: 3, head_sha: "b".repeat(40) });
    expect(r.actions).toEqual([{ type: "verify" }]);
    r = transition(r.state, { type: "checks", status: "green", sensitive: false });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
    r = transition(r.state, { type: "stage_ok", stage: "review", result: approve, security: false });
    expect(r.actions).toEqual([{ type: "merge" }]);
    r = transition(r.state, { type: "merge_result", status: "merged" });
    expect(r.state.stage).toBe("done");
    expect(r.actions).toContainEqual({ type: "label", add: [], remove: ["in-progress"] });
    expect(r.actions).toContainEqual({ type: "done" });
  });
});

describe("chain: plan outcomes (AC-9)", () => {
  it("spec_gap posts one comment, labels needs-clarification, releases without a patch", () => {
    const r = transition(at("plan"), { type: "stage_ok", stage: "plan", result: { verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Q1", "Q2"] } });
    expect(r.state.stage).toBe("released");
    expect(r.actions.filter((a) => a.type === "comment")).toHaveLength(1);
    expect(r.actions).toContainEqual({ type: "label", add: ["needs-clarification"], remove: ["in-progress"] });
    expect(r.actions).toContainEqual(expect.objectContaining({ type: "notify", gate: "ready", label: "needs-clarification" }));
    expect(r.actions).toContainEqual({ type: "release", reason: "spec_gap", savePatch: false });
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
  });
  it("retries a failed plan once, then needs-human", () => {
    const r1 = transition(at("plan"), { type: "stage_failed", stage: "plan", reason: "timeout" });
    expect(r1.actions).toEqual([{ type: "run_stage", stage: "plan", attempt: 2 }]);
    const r2 = transition(r1.state, { type: "stage_failed", stage: "plan", reason: "timeout" });
    expect(r2.state.stage).toBe("needs-human");
    expect(r2.actions).toContainEqual({ type: "label", add: ["needs-human"], remove: ["in-progress"] });
  });
});

describe("chain: scope (AC-10)", () => {
  it("first violation goes to fix with the violations as input; second goes to needs-human", () => {
    const r1 = transition(at("implement", { plan }), { type: "stage_ok", stage: "implement", result: impl, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(r1.state.stage).toBe("fix");
    expect(r1.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("web/x.ts") });
    const r2 = transition(r1.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: false, violations: ["web/x.ts: outside plan file scope"] } });
    expect(r2.state.stage).toBe("needs-human");
  });
});

describe("chain: verify (AC-14)", () => {
  it("pending waits, failed goes to fix with the log, green starts review", () => {
    expect(transition(at("verify"), { type: "checks", status: "pending", sensitive: false }).actions).toEqual([{ type: "wait", seconds: 60 }]);
    const f = transition(at("verify"), { type: "checks", status: "failed", log: "FAIL x.test.ts", sensitive: false });
    expect(f.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("FAIL x.test.ts") });
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true });
    expect(g.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("a failed check after the fix limit goes to needs-human instead of another fix (AC-13)", () => {
    const r = transition(at("verify", { fixes: 2 }), { type: "checks", status: "failed", log: "FAIL x.test.ts", sensitive: false });
    expect(r.state.stage).toBe("needs-human");
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
    const notifies = r.actions.filter((a) => a.type === "notify");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ gate: "fix-loop" });
  });
});

describe("chain: review (AC-11, AC-13)", () => {
  it("changes_requested goes to fix twice, then needs-human", () => {
    let s = at("review");
    let r = transition(s, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("fix");
    r = transition(r.state, { type: "stage_ok", stage: "fix", result: { head_sha: "c".repeat(40), addressed: [0] }, scope: { ok: true } });
    expect(r.state.fixes).toBe(1);
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("fix");
    r = transition(r.state, { type: "stage_ok", stage: "fix", result: { head_sha: "d".repeat(40), addressed: [0] }, scope: { ok: true } });
    expect(r.state.fixes).toBe(2);
    r = transition({ ...r.state, stage: "review" }, { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("needs-human");
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
  });
  it("a security finding blocks merge even after a later approval", () => {
    const r1 = transition(at("review", { pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "stage_ok", stage: "review", result: changes, security: true });
    expect(r1.state.stage).toBe("needs-human");
    expect(r1.state.securityFinding).toBe(true);
    const labelActions = r1.actions.filter((a) => a.type === "label");
    expect(labelActions).toEqual([
      { type: "label", add: ["security-review", "needs-human"], remove: ["in-progress"] },
      { type: "label", add: ["security-review"], remove: [], target: "pr" },
    ]);
    expect(r1.actions.indexOf(labelActions[1])).toBe(r1.actions.indexOf(labelActions[0]) + 1);
    const r2 = transition({ ...r1.state, stage: "review" }, { type: "stage_ok", stage: "review", result: approve, security: true });
    expect(r2.state.stage).toBe("needs-human");
    expect(r2.actions.find((a) => a.type === "merge")).toBeUndefined();
  });
  it("a failed sensitive review retries once with the security profile (AC-11)", () => {
    const r = transition(at("review", { sensitive: true }), { type: "stage_failed", stage: "review", reason: "timeout" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 2, profile: "security" }]);
  });
  it("judges a changes verdict on a sensitive chain as a security finding even when the event says security: false (AC-11)", () => {
    const r = transition(at("review", { sensitive: true }), { type: "stage_ok", stage: "review", result: changes, security: false });
    expect(r.state.stage).toBe("needs-human");
    expect(r.state.securityFinding).toBe(true);
  });
  it("a second review failure goes to needs-human with one notify and no further run", () => {
    const r = transition(at("review", { attempt: 2 }), { type: "stage_failed", stage: "review", reason: "timeout" });
    expect(r.state.stage).toBe("needs-human");
    const notifies = r.actions.filter((a) => a.type === "notify");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ gate: "review" });
    expect(r.actions.find((a) => a.type === "run_stage")).toBeUndefined();
  });
  it("escalate goes to needs-human", () => {
    const r = transition(at("review"), { type: "stage_ok", stage: "review", result: { ...approve, verdict: "escalate" }, security: false });
    expect(r.state.stage).toBe("needs-human");
  });
});

describe("chain: merge, rebase, liveness, postpone", () => {
  it("not mergeable goes to fix", () => {
    const r = transition(at("merge"), { type: "merge_result", status: "not_mergeable", detail: "conflict in a.ts" });
    expect(r.actions[0]).toMatchObject({ type: "run_stage", stage: "fix", fixInput: expect.stringContaining("conflict in a.ts") });
  });
  it("merge_blocked by a security-review label goes to needs-human, labels security-review and releases (AC-11)", () => {
    const r = transition(at("merge", { pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "merge_blocked", reason: "security-review label present" });
    expect(r.state.stage).toBe("needs-human");
    expect(r.state.securityFinding).toBe(true);
    expect(r.actions).toEqual([
      { type: "label", add: ["security-review", "needs-human"], remove: ["in-progress"] },
      { type: "notify", gate: "sensitive-path", label: "needs-human", text: "security-review label present" },
      { type: "release", reason: "sensitive-path", savePatch: false },
    ]);
    expect(r.actions.find((a) => a.type === "merge")).toBeUndefined();
  });
  it("merge_blocked outside the merge stage is invalid", () => {
    expect(() => transition(at("review"), { type: "merge_blocked", reason: "x" })).toThrow(/invalid/);
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
  it("head_moved in merge goes back to verify with the new head (C2)", () => {
    const r = transition(at("merge", { pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "head_moved", head_sha: "e".repeat(40) });
    expect(r.state.stage).toBe("verify");
    expect(r.state.pr).toEqual({ number: 3, head_sha: "e".repeat(40) });
    expect(r.actions).toEqual([{ type: "verify" }]);
  });
  it("head_moved outside the merge stage is invalid (C2)", () => {
    expect(() => transition(at("review", { pr: { number: 3, head_sha: "b".repeat(40) } }), { type: "head_moved", head_sha: "e".repeat(40) })).toThrow(/invalid/);
  });
  it("liveness expiry releases with a patch and a comment (AC-15)", () => {
    const r = transition(at("implement"), { type: "liveness_expired" });
    expect(r.state.stage).toBe("released");
    expect(r.actions).toContainEqual({ type: "release", reason: "liveness expired", savePatch: true });
    expect(r.actions.filter((a) => a.type === "comment")).toHaveLength(1);
    const notifies = r.actions.filter((a) => a.type === "notify");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ gate: "liveness", label: "" });
  });
  it("postponed strong-tier stage waits with the claim held and resumes the same stage (AC-25)", () => {
    const r1 = transition(at("review"), { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(r1.state.stage).toBe("waiting");
    expect(r1.actions).toEqual([{ type: "wait", seconds: 1800 }]);
    const r2 = transition(r1.state, { type: "start" });
    expect(r2.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1 }]);
  });
  it("a postponed security review resumes with the security profile (AC-11, AC-25)", () => {
    const g = transition(at("verify"), { type: "checks", status: "green", sensitive: true });
    const w = transition(g.state, { type: "stage_failed", stage: "review", reason: "429", postpone: true });
    expect(w.state.stage).toBe("waiting");
    const r = transition(w.state, { type: "start" });
    expect(r.actions).toEqual([{ type: "run_stage", stage: "review", attempt: 1, profile: "security" }]);
  });
  it("throws on an event that is invalid for the stage", () => {
    expect(() => transition(at("plan"), { type: "merge_result", status: "merged" })).toThrow(/invalid/);
  });
});
