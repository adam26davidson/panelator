import { describe, expect, it } from "vitest";
import { standingWorld } from "./helpers/e2e-routes.ts";
import { emit } from "../src/standing/events.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";
import { record } from "../src/events/store.ts";
import { openIndex } from "../src/events/index.ts";
import { readJsonLines } from "../src/filer/input.ts";
import type { LogEntry } from "../src/actions/log.ts";
import { planMarker } from "../src/reflection/apply.ts";

// Spec 028 section 6: the three reflection agents, end to end on recorded worlds (fake adapter, mocked GitHub).
const T0 = new Date("2026-10-01T00:00:00Z");
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const BOT = "panelator-pipeline[bot]";
const why = "applied by the reflection to remove a bottleneck";
const long = (s: string) => `${s}. Why: the evidence (issue 12, merged_per_week) shows the stage loops. How to tell it worked: issue_to_merge_days should fall.`.padEnd(220, ".");
const item = (i: number, over: Record<string, unknown> = {}) => ({ title: `Item ${i}`, body: long(`Change ${i}`), class: "class:tooling", kind: "bottleneck", ...over });
const plan = (items: unknown[], over: Record<string, unknown> = {}) => ({ title: "Plan", summary: "A summary", observations: [{ what: "w", evidence: "e" }], items, metrics_note: "m", open_questions_note: "none", deferred: [], ...over });
const result = (items: unknown[], extra: Record<string, unknown> = {}, planOver: Record<string, unknown> = {}) => ({ summary: "reflected", plan: plan(items, planOver), ...extra });

async function reflectionWorld(only: string, results: unknown[]) {
  const w = await standingWorld({ [only]: results as never[] });
  for (const name of Object.keys(w.registry)) await writeAgentState(w.paths, name, { ...(await readAgentState(w.paths, name))!, paused: name !== only, paused_by: name !== only ? "maintainer" : null });
  w.setNow(T0);
  const idle = async () => { for (let i = 0; i < 6000 && w.scheduler.active; i++) await new Promise((r) => setTimeout(r, 25)); };
  const tick = async () => { await w.scheduler.tick(); await idle(); };
  const state = async () => (await readAgentState(w.paths, only))!;
  const planIssues = () => [...w.issues, ...w.closed.values()].filter((i) => i.labels.some((l) => l.name === "reflection"));
  const validated = () => w.issues.filter((i) => i.labels.some((l) => l.name === "validated"));
  const events = (kind: string) => { const db = openIndex(w.paths, { readOnly: true }); try { return (db.prepare("SELECT payload, agent FROM events WHERE kind = ? ORDER BY at, rowid").all(kind) as { payload: string; agent: string }[]).map((r) => ({ ...JSON.parse(r.payload), agent: r.agent })); } finally { db.close(); } };
  return { ...w, idle, tick, state, planIssues, validated, events };
}

describe("end to end: delivery reflection (spec 028 AC-1, AC-4, AC-6)", () => {
  it("is woken by ten merges and not nine; files items, comments on an existing issue, applies a parameter and closes the previous plan", async () => {
    const w = await reflectionWorld("delivery-reflection", [result(
      [item(0), item(1), item(2), item(3, { existing_issue: 5 })],
      { actions: [{ kind: "set_parameter", args: { name: "system_work_share", value: 0.5 }, why }, { kind: "rerun_workflow", args: { run_id: 9 }, why }] },
    )]);
    w.issues.push({ number: 5, title: "known", body: "b", user: { login: BOT }, labels: [], created_at: T0.toISOString() });
    w.issues.push({ number: 7, title: "Delivery plan", body: `old\n${planMarker("delivery-reflection-0")}`, user: { login: BOT }, labels: [{ name: "reflection" }, { name: "reflection:delivery" }], created_at: T0.toISOString() });
    await record(w.paths, "reflection.plan", day(-6), { plan: plan([]), plan_key: "delivery-reflection-0", plan_issue: 7, filed: [] }, { agent: "delivery-reflection" });
    const merge = (n: number) => emit(w.paths, w.registry, "merge", { issue: n, pr: n }, T0);
    for (let n = 1; n <= 9; n++) await merge(n);
    await w.tick();
    expect(w.adapter.ran).toEqual([]);
    await merge(10);
    await w.tick();
    expect(w.adapter.ran).toEqual(["delivery-reflection"]);
    expect((await w.state()).last_run?.outcome).toBe("ok");
    expect((await w.state()).reflection).toBeUndefined();
    expect((await w.state()).pending_events).toEqual([]);
    const [created] = w.planIssues().filter((i) => i.number >= 100);
    expect(created!.labels.map((l) => l.name)).toEqual(["reflection", "reflection:delivery"]);
    expect(created!.body).toContain("Item 3");
    expect(w.validated()).toHaveLength(3);
    expect(w.closed.has(7)).toBe(true);
    expect((w.comments.get(5) as { body: string }[]).map((c) => c.body)).toEqual([expect.stringContaining(`#${created!.number}`)]);
    const rows = await readJsonLines<LogEntry>(w.paths.actionsLog);
    expect(rows.find((r) => r.kind === "set_parameter")).toMatchObject({ status: "applied", agent: "delivery-reflection" });
    expect(rows.find((r) => r.kind === "rerun_workflow")).toMatchObject({ status: "refused" });
    expect(created!.body).toContain("- set_parameter");
    const plans = w.events("reflection.plan");
    expect(plans.at(-1)).toMatchObject({ plan_issue: created!.number, filed: expect.arrayContaining([5]) });
    expect(w.events("metrics.snapshot")).toEqual([expect.objectContaining({ metrics: expect.arrayContaining([expect.objectContaining({ goal: expect.any(String), rationale: expect.any(String) })]) })]);
    expect(w.events("agent.run")).toEqual([expect.objectContaining({ outcome: "ok", events_received: 10 })]);
  }, 150_000);
});

describe("end to end: charter and meta reflection (spec 028 AC-2, AC-3, AC-9)", () => {
  it("charter: the input marks a recurring contact and the result files the automation item", async () => {
    let prompt = "";
    const w = await reflectionWorld("charter-reflection", [(run: { prompt: string }) => { prompt = run.prompt; return result([item(0, { kind: "automate_contact", title: "Automate the spec question" })]); }]);
    await record(w.paths, "maintainer.contact", day(2), { channel: "issue", kind: "question", label: "spec", text: "first" });
    await record(w.paths, "maintainer.contact", day(3), { channel: "issue", kind: "question", label: "spec", text: "second" });
    w.setNow(day(8));
    await w.tick();
    expect(prompt).toContain('"recurring":true');
    const [filed] = w.validated();
    expect(filed!.title).toBe("Automate the spec question");
    expect(filed!.body).toContain("Kind: automate_contact");
  }, 150_000);

  it("meta: a metric_change with a rationale is filed and one without is deferred", async () => {
    const w = await reflectionWorld("meta-reflection", [result([
      item(0, { kind: "metric_change", title: "Add a metric", body: `## Rationale\nIt drives the cadence decision.\n${long("Add metric x replacing y")}` }),
      item(1, { kind: "metric_change", title: "Add another" }),
    ])]);
    w.setNow(day(31));
    await w.tick();
    expect(w.validated().map((i) => i.title)).toEqual(["Add a metric"]);
    const [p] = w.planIssues();
    expect(p!.body).toContain("Add another: a metric_change needs a ## Rationale section");
  }, 150_000);
});

describe("end to end: bounds, crashes and retries (spec 028 AC-6, AC-7, AC-10)", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => item(i));
  it("files eight of twelve and defers four", async () => {
    const w = await reflectionWorld("charter-reflection", [result(twelve)]);
    w.setNow(day(8));
    await w.tick();
    expect(w.validated()).toHaveLength(8);
    expect(w.planIssues()[0]!.body).toContain("Item 11: over the plan bound");
  }, 150_000);

  it("a crash at item 4 is retried at a later time: items 4 to 7 filed, 8 to 11 deferred, one plan issue, two agent.run events, the same period", async () => {
    const w = await reflectionWorld("charter-reflection", [result(twelve), result(twelve)]);
    w.hooks.failCreateAt = 6;
    w.setNow(day(8));
    await w.tick();
    const failed = await w.state();
    expect(failed).toMatchObject({ failures: 1 });
    expect(failed.reflection).toBeDefined();
    expect(w.validated()).toHaveLength(4);
    w.hooks.failCreateAt = 0;
    w.setNow(new Date(day(8).getTime() + 3_600_000));
    await w.tick();
    expect(w.validated()).toHaveLength(8);
    expect(w.planIssues()).toHaveLength(1);
    const body = w.planIssues()[0]!.body;
    for (const i of w.validated()) expect(body).toContain(`#${i.number} `);
    expect(body).toContain("Item 8: over the plan bound");
    expect((await w.state()).reflection).toBeUndefined();
    expect(w.events("agent.run").map((e) => e.outcome)).toEqual(["failed", "ok"]);
    expect(w.events("reflection.plan")).toEqual([expect.objectContaining({ plan_key: failed.reflection!.plan_key })]);
    expect(Date.parse(failed.reflection!.period_from)).toBe(day(8).getTime() - 28 * 86_400_000);
  }, 150_000);

  it("a process death after the plan issue (failures still 0, running and reflection set) creates no second plan issue", async () => {
    const w = await reflectionWorld("charter-reflection", [result([item(0), item(1)]), result([item(0), item(1)])]);
    w.hooks.failCreateAt = 2;
    w.setNow(day(8));
    await w.tick();
    const s = await w.state();
    await writeAgentState(w.paths, "charter-reflection", { ...s, failures: 0, running: { run_id: "standing-charter-reflection-1-0", started_at: day(8).toISOString() } });
    w.hooks.failCreateAt = 0;
    w.setNow(new Date(day(8).getTime() + 3_600_000));
    await w.tick();
    expect(w.planIssues()).toHaveLength(1);
    expect(w.validated()).toHaveLength(2);
    expect(w.planIssues()[0]!.body).toContain("Item 1");
    expect((await w.state()).last_run?.outcome).toBe("ok");
  }, 150_000);

  it("a collaborator's issue labelled reflection:charter is not closed as a predecessor", async () => {
    const w = await reflectionWorld("charter-reflection", [result([])]);
    w.issues.push({ number: 8, title: "not mine", body: "x", user: { login: "collab" }, labels: [{ name: "reflection:charter" }], created_at: T0.toISOString() });
    await record(w.paths, "reflection.plan", day(1), { plan: plan([]), plan_key: "charter-reflection-0", plan_issue: 8, filed: [] }, { agent: "charter-reflection" });
    w.setNow(day(8));
    await w.tick();
    expect(w.closed.has(8)).toBe(false);
    expect(w.planIssues().filter((i) => i.number >= 100)).toHaveLength(1);
  }, 150_000);
});
