import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { standingWorld } from "./helpers/e2e-routes.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";
import { emit } from "../src/standing/events.ts";
import { Scheduler } from "../src/service/loop.ts";
import { record } from "../src/events/store.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { PlanItem, ReflectionResult } from "../src/reflection/apply.ts";

type World = Awaited<ReturnType<typeof standingWorld>>;
const body = "Change the scheduler to remove the measured bottleneck. Evidence: repeated failed runs and long stage durations in the period. Verify that issue_to_merge_days falls without increasing failed runs or quality regressions.";
const item = (i: number, extra: Partial<PlanItem> = {}): PlanItem => ({ title: `Change ${i}`, body, class: "class:tooling", kind: "bottleneck", ...extra });
const result = (items: PlanItem[] = [], actions: ReflectionResult["actions"] = []): ReflectionResult => ({ summary: "Reflection", actions, plan: { title: "Plan", summary: "Measured changes", observations: [], items, metrics_note: "Watch lead time", open_questions_note: "none", deferred: [] } });
async function only(w: World, agent: string) {
  for (const name of Object.keys(w.registry)) await writeAgentState(w.paths, name, { ...(await readAgentState(w.paths, name))!, paused: name !== agent, paused_by: name !== agent ? "maintainer" : null });
}
async function tick(w: World, scheduler = w.scheduler) {
  await scheduler.tick();
  for (let i = 0; i < 2400 && scheduler.active; i++) await new Promise((r) => setTimeout(r, 25));
  expect(scheduler.active).toBe(0);
}
function events(w: World, kind: string) {
  return readdirSync(w.paths.events).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(w.paths.events, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((e) => e.kind === kind);
}
const inputOf = (w: World, index = 0): any => (w.adapter.runs[index]!.input as any).events.input;
const filed = (w: World) => w.issues.filter((i) => i.labels.some((l) => l.name === "validated"));
const planIssue = (w: World) => w.issues.find((i) => i.labels.some((l) => l.name === "reflection"))!;

describe("recorded reflection agents (spec 028)", () => {
  it("delivery waits for ten merges, files three items and an existing-issue comment, applies an action and closes only its recorded predecessor", async () => {
    const r = result([item(0), item(1), item(2), item(3, { existing_issue: 41 })], [{ kind: "set_parameter", args: { name: "system_work_share", value: 0.5 }, why: "Remove the measured delivery bottleneck" }]);
    const w = await standingWorld({ "delivery-reflection": [r] });
    await only(w, "delivery-reflection");
    const old = await w.gh.createIssue("Old plan", "old", ["reflection:delivery"]);
    await record(w.paths, "reflection.plan", "2026-09-30T00:00:00.000Z", { plan: result().plan, plan_key: "old", plan_issue: old, filed: [] }, { agent: "delivery-reflection" });
    // Triage labels do not grant ownership of the predecessor.
    w.issues.push({ number: 42, title: "Collaborator", body: "not a plan", user: { login: "collaborator" }, labels: [{ name: "reflection:delivery" }], created_at: "2026-09-30T00:00:00Z" });
    await appendQuestionLog(w.paths, { issue: 9, at: "2026-09-30T00:00:00.000Z", event: "sent", asking_stage: "spec", question_comment_id: 55 }, "Which direction?");
    for (let n = 0; n < 9; n++) await emit(w.paths, w.registry, "merge", { issue: n + 1 }, new Date("2026-10-01T00:00:00Z"));
    w.setNow(new Date("2026-10-01T00:10:00Z"));
    await tick(w);
    expect(w.adapter.ran).toEqual([]);
    await emit(w.paths, w.registry, "merge", { issue: 10 }, new Date("2026-10-01T00:10:00Z"));
    w.setNow(new Date("2026-10-01T00:20:00Z"));
    await tick(w);
    expect(w.adapter.ran).toEqual(["delivery-reflection"]);
    expect(filed(w)).toHaveLength(3);
    expect(w.comments.get(41)).toHaveLength(1);
    expect(w.closed.has(old)).toBe(true);
    expect(w.issues.some((i) => i.number === 42)).toBe(true);
    expect((await w.parameters.read("system_work_share")).value).toBe(0.5);
    expect(planIssue(w).body).toContain("#9 (spec, sent 2026-09-30T00:00:00.000Z): Which direction?");
    expect(planIssue(w).body).toContain("set_parameter");
    expect((await readAgentState(w.paths, "delivery-reflection"))!.pending_events).toEqual([]);
    expect(events(w, "reflection.plan")).toHaveLength(2);
  }, 90_000);

  it("charter sees recurring contacts and files the automation item", async () => {
    const w = await standingWorld({ "charter-reflection": [result([item(0, { kind: "automate_contact" })])] });
    await only(w, "charter-reflection");
    for (const at of ["2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"]) await record(w.paths, "maintainer.contact", at, { channel: "issue", kind: "question", label: "spec", text: "Recurring setup" });
    w.setNow(new Date("2026-10-09T00:00:00Z"));
    await tick(w);
    expect(inputOf(w).maintainer_contacts).toMatchObject([{ kind: "question", label: "spec", recurring: true, count: 2 }]);
    expect(filed(w)[0]!.body).toContain("Kind: automate_contact");
  }, 90_000);

  it("meta proposes a metric with its rationale, defers one without and refuses a disallowed action", async () => {
    const w = await standingWorld({ "meta-reflection": [result([item(0, { kind: "metric_change", body: `## Rationale\nReplace issue_to_merge_days with a more faithful latency metric.\n${body}` }), item(1, { kind: "metric_change" })], [{ kind: "set_parameter", args: { name: "system_work_share", value: 0.5 }, why: "This action is not permitted for meta-reflection" }])] });
    await only(w, "meta-reflection");
    w.setNow(new Date("2026-11-01T00:00:00Z"));
    await tick(w);
    expect(filed(w)).toHaveLength(1);
    expect(filed(w)[0]!.body).toContain("## Rationale");
    expect(planIssue(w).body).toContain("a metric_change needs a ## Rationale section");
    expect(inputOf(w).metric_definitions.length).toBeGreaterThan(0);
    expect(events(w, "action").some((e) => e.payload.status === "refused")).toBe(true);
    expect(readFileSync(w.paths.findingsQueue, "utf8")).toContain("reflection action refused: set_parameter");
  }, 90_000);

  it("refuses and queues a level-2 action from delivery reflection", async () => {
    const w = await standingWorld({ "delivery-reflection": [result([], [{ kind: "set_parameter", args: { name: "system_work_share", value: 0.5 }, why: "Propose a reviewed parameter change" }])] });
    await only(w, "delivery-reflection");
    const agents = join(w.pair.root, "agents");
    cpSync(w.deps.agentsDir, agents, { recursive: true });
    const actions = join(agents, "actions.yaml");
    writeFileSync(actions, readFileSync(actions, "utf8").replace("set_parameter:\n  level: 1", "set_parameter:\n  level: 2"));
    w.deps.agentsDir = agents;
    w.setNow(new Date("2026-10-09T00:00:00Z"));
    await tick(w);
    expect(events(w, "action").at(-1).payload).toMatchObject({ status: "refused", reason: "level 2" });
    expect(readFileSync(w.paths.findingsQueue, "utf8")).toContain("level 2 action requested");
    expect(planIssue(w).body).toContain("refused (level 2)");
  }, 90_000);

  for (const crash of [false, true]) it(`twelve items: ${crash ? "crash at item 4 then retry" : "one attempt"} files eight and defers four`, async () => {
    const r = result(Array.from({ length: 12 }, (_, i) => item(i)));
    const w = await standingWorld({ "delivery-reflection": [r, r] });
    await only(w, "delivery-reflection");
    w.setNow(new Date("2026-10-09T00:00:00Z"));
    if (crash) w.hooks.failCreateAt = 6;
    await tick(w);
    if (crash) {
      expect(filed(w)).toHaveLength(4);
      expect((await readAgentState(w.paths, "delivery-reflection"))!.failures).toBe(1);
      w.setNow(new Date("2026-10-09T01:00:00Z"));
      await tick(w);
    }
    expect(filed(w)).toHaveLength(8);
    for (const i of filed(w)) expect(planIssue(w).body).toContain(`#${i.number} `);
    expect(events(w, "reflection.plan")[0].payload.deferred).toHaveLength(4);
    expect(events(w, "agent.run").map((e) => e.payload.outcome)).toEqual(crash ? ["failed", "ok"] : ["ok"]);
  }, 120_000);

  for (const restart of [false, true]) it(`reuses the plan and period after ${restart ? "process death with failures zero" : "an apply error"}, at a later clock time`, async () => {
    const r = result([item(0, { existing_issue: 41 }), item(1)]);
    const w = await standingWorld({ "delivery-reflection": [r, r] });
    await only(w, "delivery-reflection");
    w.hooks.failCreateAt = 2;
    w.setNow(new Date("2026-10-09T00:00:00Z"));
    await tick(w);
    const state = (await readAgentState(w.paths, "delivery-reflection"))!;
    const key = state.reflection!.plan_key;
    const number = planIssue(w).number;
    expect(w.comments.get(41)).toHaveLength(1);
    if (restart) await writeAgentState(w.paths, "delivery-reflection", { ...state, failures: 0, running: { run_id: "interrupted", started_at: "2026-10-09T00:00:00.000Z" } });
    w.setNow(new Date("2026-10-09T01:00:00Z"));
    await tick(w, restart ? new Scheduler(w.deps) : w.scheduler);
    expect(planIssue(w).number).toBe(number);
    expect(w.issues.filter((i) => i.labels.some((l) => l.name === "reflection"))).toHaveLength(1);
    expect(w.comments.get(41)).toHaveLength(1);
    expect(planIssue(w).body).toContain(`#${filed(w)[0]!.number} `);
    expect(inputOf(w, 0).period.from).toBe(inputOf(w, 1).period.from);
    expect(events(w, "reflection.plan")[0].payload.plan_key).toBe(key);
    expect(events(w, "agent.run")).toHaveLength(2);
    expect((await readAgentState(w.paths, "delivery-reflection"))!.reflection).toBeUndefined();
  }, 120_000);
});
