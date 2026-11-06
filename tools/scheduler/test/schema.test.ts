import { describe, expect, it } from "vitest";
import { initialChainState, ledgerOf } from "../src/chain/machine.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { splitFrontmatter } from "../src/stages/definition.ts";
import { validate } from "../src/schema/validate.ts";

const finding = {
  what: "duplicate pagination code",
  where: "tools/scheduler/src/github/client.ts:40",
  evidence: "two functions with the same loop",
  noticed_how: "while adding the checks call",
};

describe("agent-state schema (spec 045)", () => {
  const base = { last_run: null, next_run: null, pending_events: [], paused: false, paused_by: null, failures: 0 };
  it("accepts an outage with its optional ceiling fields and rejects a malformed one", () => {
    const outage = { since: "2026-11-06T10:00:00.000Z", count: 3, last: "read EHOSTUNREACH", alarmed: false };
    expect(validate("agent-state", base).ok).toBe(true);
    expect(validate("agent-state", { ...base, outage }).ok).toBe(true);
    expect(validate("agent-state", { ...base, outage: { ...outage, ceiling: true, past_ceiling: { since: outage.since, failures: 2 } } }).ok).toBe(true);
    expect(validate("agent-state", { ...base, outage: { since: outage.since } }).ok).toBe(false);
  });
});

describe("result schemas", () => {
  it('accepts settled conversation turns only with a non-empty decision on every asking stage',()=>{
    for(const name of ['plan-result','implement-result','review-result','fix-result','spec-result','design-result'] as const){
      expect(validate(name,{conversation:'settled',decision:'Use second for simplicity',findings:[finding]}).ok).toBe(true);
      expect(validate(name,{conversation:'settled',decision:''}).ok).toBe(false);
      expect(validate(name,{conversation:'settled',decision:'yes',extra:true}).ok).toBe(false);
    }
  });
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

  it("does not know a claim slot field (spec 034 AC-3)", () => {
    const base = { issue: 7, state: initialChainState(7), worktree: "/tmp/wt", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null };
    expect(validate("claim", base).ok).toBe(true);
    expect(validate("claim", { ...base, slot: 0 }).ok).toBe(false);
  });

  it("validates a claim record and its chain state (spec 006 C12)", () => {
    const claim = (state: unknown) => validate("claim", {
      issue: 7, state, worktree: "/tmp/wt", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null,
    }).ok;
    expect(claim({ ...initialChainState(7), stage: "plan" })).toBe(true);
    expect(claim({ stage: "plan" })).toBe(false);
    // Spec 040 AC-7: held work is a list of branch and head entries.
    const entry = { branch: "issue-7", head: "a".repeat(40) };
    expect(claim({ ...initialChainState(7), heldWork: [] })).toBe(true);
    expect(claim({ ...initialChainState(7), heldWork: [entry, { branch: "spec-7", head: "b".repeat(40) }] })).toBe(true);
    expect(claim({ ...initialChainState(7), heldWork: null })).toBe(false);
    expect(claim({ ...initialChainState(7), heldWork: entry })).toBe(false);
    expect(claim({ ...initialChainState(7), heldWork: [{ branch: "issue-7" }] })).toBe(false);
    expect(claim({ ...initialChainState(7), heldWork: [{ ...entry, extra: 1 }] })).toBe(false);
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

describe("spec 029 schemas", () => {
  const q = { kind: "product", question: "Ship it?", options: [{ label: "yes", cost: "c" }], recommendation: "yes" };
  const sha = "a".repeat(40);
  const screen = { name: "home", stories: ["home--default"], renders: ["home.png", "home.mobile.png", "home.tablet.png"] };
  const designed = { verdict: "designed", spec_path: "specs/030-console/spec.md", pr_number: 5, head_sha: sha, screens: [screen], findings: [] };

  it("design-result accepts a full designed result and a question", () => {
    expect(validate("design-result", designed).ok).toBe(true);
    expect(validate("design-result", { verdict: "question", question: q, findings: [] }).ok).toBe(true);
  });
  it("design-result rejects a screen with two renders or no stories, a missing field and an unknown property", () => {
    expect(validate("design-result", { ...designed, screens: [{ ...screen, renders: ["a.png", "b.png"] }] }).ok).toBe(false);
    expect(validate("design-result", { ...designed, screens: [{ ...screen, stories: [] }] }).ok).toBe(false);
    expect(validate("design-result", { ...designed, screens: undefined }).ok).toBe(false);
    expect(validate("design-result", { ...designed, extra: 1 }).ok).toBe(false);
    expect(validate("design-result", { verdict: "question" }).ok).toBe(false);
  });
  it("stage-input accepts spec_path, design_problem and viewports", () => {
    const base = { issue: { number: 1, title: "t", body: "b" }, spec: "s", result_path: "/r", profile_instructions: "p" };
    expect(validate("stage-input", { ...base, spec_path: "specs/030-console/spec.md", design_problem: "missing", viewports: "mobile 390x844" }).ok).toBe(true);
    expect(validate("stage-input", { ...base, spec_path: 3 }).ok).toBe(false);
  });
  it("claim, paused, question log and ledger accept the design stage, track and counters", () => {
    const claim = (state: unknown) => validate("claim", { issue: 7, state, worktree: "/w", started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T00:00:00Z", run_id: null }).ok;
    expect(claim({ ...initialChainState(7), stage: "design", track: "design", designProblem: "x", designRevisions: 1, askingStage: "design", resumeStage: "design" })).toBe(true);
    expect(claim({ ...initialChainState(7), track: "elsewhere" })).toBe(false);
    const ledger = ledgerOf(initialChainState(7));
    expect(validate("escalation-ledger", { ...ledger, designRevisions: 2 }).ok).toBe(true);
    const { designRevisions: _omitted, ...old } = ledger;
    expect(validate("escalation-ledger", old).ok).toBe(true);
    expect(validate("escalation-ledger", { ...ledger, designRevisions: -1 }).ok).toBe(false);
  });
});

describe("standing definition schema", () => {
  const dir = "agents/standing";
  it("accepts every checked-in standing agent", () => {
    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    expect(files).toEqual(expect.arrayContaining(["action-audit.md", "findings-filer.md"]));
    for (const f of files) {
      const fm = parse(splitFrontmatter(readFileSync(join(dir, f), "utf8")).frontmatter);
      expect(validate("standing-definition", fm)).toEqual({ ok: true });
    }
  });
  const fm = {
    name: "test", kind: "standing", trigger: { schedule: "1d", events: ["merge"] }, harness: "claude", model: "test",
    tier: "strong", bounds: { timeout_min: 10, max_turns: 10, max_cost_usd: 1 }, permission: "no-prompt",
    worktree: "none", profile: "none", input: "audit-input", output: "standing-result",
  };
  const { name: _name, ...noName } = fm;
  const P = '"^[a-z][a-z0-9-]*$" {"pattern":"^[a-z][a-z0-9-]*$"}';
  it("accepts the fixture", () => expect(validate("standing-definition", fm)).toEqual({ ok: true }));
  it.each<[string, unknown, string]>([
    ["unknown key", { ...fm, unknown: true }, '/ must NOT have additional properties {"additionalProperty":"unknown"}'],
    ["missing name", noName, `/ must have required property 'name' {"missingProperty":"name"}`],
    ["worktree", { ...fm, worktree: "issue" }, "/worktree must be equal to one of the allowed values"],
    ["effort", { ...fm, effort: 3 }, '/effort must be string {"type":"string"}'],
    ["name pattern", { ...fm, name: "Bad Name" }, `/name must match pattern ${P}`],
    ["empty profile", { ...fm, profile: "" }, `/profile must match pattern ${P}`],
    ["kind", { ...fm, kind: "wrong" }, "/kind must be equal to constant"],
    ["empty trigger", { ...fm, trigger: {} }, '/trigger must NOT have fewer than 1 properties {"limit":1}'],
    ["trigger key", { ...fm, trigger: { schedule: "1d", foo: 1 } }, '/trigger must NOT have additional properties {"additionalProperty":"foo"}'],
    ["empty events", { ...fm, trigger: { events: [] } }, '/trigger/events must NOT have fewer than 1 items {"limit":1}'],
    ["schedule syntax", { ...fm, trigger: { schedule: "soon" } }, "/trigger/schedule must match pattern"],
    ["trigger array", { ...fm, trigger: ["merge"] }, '/trigger must be object {"type":"object"}'],
    ["bounds extra", { ...fm, bounds: { ...fm.bounds, extra: 1 } }, "/bounds must NOT have additional properties"],
    ["bounds missing", { ...fm, bounds: { timeout_min: 10, max_cost_usd: 1 } }, "/bounds must have required property 'max_turns'"],
    ["bounds zero", { ...fm, bounds: { ...fm.bounds, max_cost_usd: 0 } }, "/bounds/max_cost_usd must be > 0"],
  ])("rejects %s", (_n, data, msg) => {
    const r = validate("standing-definition", data);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.startsWith(msg))).toBe(true);
  });
});
