import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.ts";
import { agentsDir } from "../src/config.ts";
import { openIndex } from "../src/events/index.ts";
import { recordEvent } from "../src/events/store.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";
import { applyReflectionResult, type ApplyDeps, type ReflectionResult } from "../src/reflection/apply.ts";
import { buildReflectionInput, groupContacts, openQuestions, periodStart, questionOutcomes, type ReflectionDeps } from "../src/reflection/input.ts";
import { loadMetricDefinitions } from "../src/metrics/definitions.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { readJsonLines } from "../src/filer/input.ts";
import type { StandingDefinition } from "../src/types.ts";

const fixtures = join(import.meta.dirname, "fixtures", "events");
async function world() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "reflection-")));
  await ensureStateDirs(paths);
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith(".jsonl"))) cpSync(join(fixtures, f), join(paths.events, f));
  const repo = mkdtempSync(join(tmpdir(), "reflection-repo-"));
  const w = (rel: string, text: string) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), text); };
  w("docs/charter.md", "# Charter\n\nThe system delivers.\n\nThe system improves itself.\n");
  w("docs/designs/foo.md", "# Foo\n\nParent: docs/product-spec.md\n\n## Children\n\n- `specs/001-a/spec.md`\n- `docs/designs/missing.md`\n");
  w("specs/001-a/spec.md", "# 1\n\nStatus: approved\nIssue: #101\n");
  w("specs/002-b/spec.md", "# 2\n\nStatus: approved\nIssue: #555\n");
  return { paths, repo };
}
const def = (name: string) => ({ name, kind: "standing", actions: ["set_parameter"] }) as unknown as StandingDefinition;
function deps(paths: ReturnType<typeof statePaths>, repo: string): ReflectionDeps {
  return {
    paths, repoDir: repo, botLogin: "bot", reflectionAgents: ["delivery-reflection"], parameters: { all: async () => ({}) } as never,
    metrics: loadMetricDefinitions(join(agentsDir, "metrics"), new Date("2026-10-28")),
    gh: { listOpenIssuesByAuthor: async () => [{ number: 90, title: "Open", labels: ["class:tooling"], createdAt: "2026-10-20T00:00:00Z", author: "bot", body: "", labelEvents: [] }], issueState: async (n: number) => ({ state: n === 121 ? "closed" : "open", labels: n === 122 ? ["abandoned"] : n === 123 ? ["in-progress"] : [], closed_at: null }) },
  };
}
const now = new Date("2026-10-26T00:00:00Z");

describe("reflection input (AC-15)", () => {
  it("builds the common sections from the fixture events and validates", async () => {
    const { paths, repo } = await world();
    const input = await buildReflectionInput(deps(paths, repo), def("delivery-reflection"), new Date("2026-09-01T00:00:00Z"), now) as Record<string, any>;
    expect(validate("reflection-input", input)).toEqual({ ok: true });
    expect(input.period).toEqual({ from: "2026-09-01T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z" });
    expect(input.issues.map((i: { issue: number }) => i.issue)).toEqual([101, 102, 103, 104]);
    const i101 = input.issues[0];
    expect(i101).toMatchObject({ eligible_at: "2026-09-15T09:00:00.000Z", total_cost_usd: 1.5 });
    expect(i101.transitions).toHaveLength(3);
    expect(i101.released).toEqual([{ at: "2026-09-17T08:01:00.000Z", reason: "done" }]);
    expect(input.issues[2].pauses.map((p: { kind: string }) => p.kind)).toEqual(["pause.started", "pause.ended"]);
    expect(input.events_summary.by_kind.merge).toBe(4);
    expect(input.open_bot_issues).toEqual([{ number: 90, title: "Open", labels: ["class:tooling"], age_days: 6 }]);
    expect(input.metrics.metrics.map((m: { name: string }) => m.name)).toHaveLength(9);
    expect(input.charter).toBeUndefined();
  });

  it("lists the open questions with their text", async () => {
    const { paths } = await world();
    const db = openIndex(paths);
    expect(openQuestions(db).map((q) => [q.issue, q.question_comment_id, q.question])).toEqual([[103, 501, "Which audience again?"], [104, 502, ""]]);
    expect(questionOutcomes(db, "2026-01-01T00:00:00Z")).toEqual([
      { month: "2026-09", sent: 2, answered: 1, decide_yourself: 1, median_hours_to_answer: 48 },
      { month: "2026-10", sent: 1, answered: 0, decide_yourself: 0, median_hours_to_answer: null },
    ]);
    db.close();
  });

  it("marks a recurring maintainer contact for the charter reflection", async () => {
    const { paths, repo } = await world();
    const db = openIndex(paths);
    const groups = groupContacts(db, "2026-09-01T00:00:00.000Z", "2026-10-26T00:00:00.000Z");
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "notification", label: "ci", count: 2, recurring: true, first: "2026-09-24T10:00:00.000Z", last: "2026-10-20T16:00:00.000Z", examples: ["main is red", "main is red again"] }),
    ]));
    db.close();
    const input = await buildReflectionInput(deps(paths, repo), def("charter-reflection"), new Date("2026-09-01T00:00:00Z"), now) as Record<string, any>;
    expect(validate("reflection-input", input)).toEqual({ ok: true });
    expect(input.charter).toEqual([{ n: 1, text: "# Charter" }, { n: 2, text: "The system delivers." }, { n: 3, text: "The system improves itself." }]);
    expect(input.console_available).toBe(false);
    expect(input.maintainer_contacts.filter((g: { recurring: boolean }) => g.recurring).length).toBeGreaterThanOrEqual(1);
  });

  it("derives each spec's issue from the commit that added it and the merge events, and flags a missing child (AC-15)", async () => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "reflection-state-")));
    await ensureStateDirs(paths);
    const { repo } = repoPair({ "docs/charter.md": "# Charter\n\nThe system delivers.\n", "docs/designs/foo.md": "# Foo\n\n## Children\n\n- `specs/001-a/spec.md`\n- `docs/designs/missing.md`\n" });
    const add = (rel: string, subject: string) => { mkdirSync(join(repo, rel, ".."), { recursive: true }); writeFileSync(join(repo, rel), "# s\n\nStatus: approved\n"); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", subject); };
    add("specs/001-a/spec.md", "spec 001: a (#22)");
    add("specs/002-b/spec.md", "spec 002: b (#23)");
    add("specs/003-c/spec.md", "spec 003: c, no pull request number");
    const merge = (issue: number, pr: number) => recordEvent(paths, { at: "2026-10-20T00:00:00.000Z", kind: "merge", issue, payload: { issue, pr, cls: "debt", work: "system", at: "2026-10-20T00:00:00.000Z" } });
    await merge(101, 22); await merge(101, 30); await merge(102, 23);
    const input = await buildReflectionInput(deps(paths, repo), def("delivery-reflection"), new Date("2026-09-01T00:00:00Z"), now) as Record<string, any>;
    expect(validate("reflection-input", input)).toEqual({ ok: true });
    expect(input.design_tree.designs).toEqual([{ path: "docs/designs/foo.md", children: [{ path: "specs/001-a/spec.md", exists: true }, { path: "docs/designs/missing.md", exists: false }] }]);
    expect(input.design_tree.specs).toEqual([
      { path: "specs/001-a/spec.md", status: "approved", issue: 101, implemented: true },
      { path: "specs/002-b/spec.md", status: "approved", issue: 102, implemented: false },
      { path: "specs/003-c/spec.md", status: "approved", issue: null, implemented: null },
    ]);
  });

  it("carries the meta sections, with plans and the fate of each filed issue", async () => {
    const { paths, repo } = await world();
    mkdirSync(join(paths.reflections, "delivery-reflection"), { recursive: true });
    const filed = [121, 122, 123, 101].map((issue, index) => ({ index, title: `i${issue}`, kind: "bottleneck", issue }));
    writeFileSync(join(paths.reflections, "delivery-reflection", "k.json"), JSON.stringify({ run_id: "k", agent: "delivery-reflection", at: "2026-10-10T00:00:00.000Z", plan_issue: 120, plan: { title: "t", items: [] }, filed, deferred: [] }));
    const input = await buildReflectionInput(deps(paths, repo), def("meta-reflection"), new Date("2026-09-01T00:00:00Z"), now) as Record<string, any>;
    expect(validate("reflection-input", input)).toEqual({ ok: true });
    expect(input.metric_definitions).toHaveLength(9);
    expect(input.snapshots).toHaveLength(1);
    expect(input.previous_plans[0].filed.map((f: { state: string }) => f.state)).toEqual(["closed", "abandoned", "in progress", "merged"]);
    expect(input.all_plans).toHaveLength(1);
    expect(input.question_outcomes).toHaveLength(2);
  });

  it("starts the period at the last success, or 28 days back", () => {
    expect(periodStart({ last_success: { at: "2026-10-01T00:00:00.000Z", run_id: "r" } }, now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodStart({ last_success: null }, now).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });
});

interface FakeIssue { number: number; title: string; body: string; author: string; labels: string[]; createdAt: string; labelEvents: [] }
function fakeGh(seed: FakeIssue[] = []) {
  const issues = [...seed], closed: number[] = [], comments = new Map<number, string[]>(), calls: string[] = [];
  let next = 200;
  const gh = {
    searchOpenIssuesByMarker: async (m: string) => issues.filter((i) => !closed.includes(i.number) && i.body.includes(m)),
    createIssue: async (title: string, body: string, labels: string[]) => { calls.push("createIssue"); issues.push({ number: ++next, title, body, author: "bot", labels, createdAt: "", labelEvents: [] }); return next; },
    comment: async (n: number, body: string) => { calls.push("comment"); comments.set(n, [...(comments.get(n) ?? []), body]); return { id: 1, created_at: "" }; },
    listComments: async (n: number) => (comments.get(n) ?? []).map((body, id) => ({ id, author: "bot", at: "", body })),
    closeIssue: async (n: number, c: string) => { calls.push("closeIssue"); closed.push(n); comments.set(n, [...(comments.get(n) ?? []), c]); },
    ensureLabels: async () => { calls.push("ensureLabels"); },
    setIssueBody: async (n: number, body: string) => { calls.push("setIssueBody"); issues.find((i) => i.number === n)!.body = body; },
  };
  return { gh, issues, closed, comments, calls };
}
const long = (what: string) => `${what}: change the thing described here because the evidence in issues 101 to 104 shows four fix cycles; success is the rework_per_merge metric falling over the next four weeks, which this item should move.`;
const item = (n: number, over: Record<string, unknown> = {}) => ({ title: `Item ${n}`, body: long(`Item ${n}`), class: "class:tooling", kind: "bottleneck", ...over });
const result = (items: unknown[], extra: Record<string, unknown> = {}): ReflectionResult => ({
  summary: "s", plan: { title: "t", summary: "The summary.", observations: [{ what: "w", evidence: "e" }], items: items as never, metrics_note: "m", open_questions_note: "q", deferred: [] }, ...extra,
});
async function applyWorld(seed: FakeIssue[] = [], tweak: (d: ApplyDeps) => void = () => {}) {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "apply-")));
  await ensureStateDirs(paths);
  const f = fakeGh(seed);
  const d: ApplyDeps = {
    paths, gh: f.gh as never, botLogin: "bot", classes: ["class:product", "class:tooling", "class:bug"], maxIssues: 8, now: () => new Date("2026-10-26T00:00:00Z"),
    actionCtx: { paths, parameters: {} as never, log: new ActionLog(paths.actionsLog, paths), levels: { set_parameter: 1, rerun_workflow: 1 }, gh: {} as never, now: () => new Date("2026-10-26T00:00:00Z") },
  };
  tweak(d);
  return { ...f, d, paths };
}
const delivery = def("delivery-reflection");
const plan = (f: { issues: FakeIssue[] }) => f.issues.find((i) => i.body.includes(":plan -->"))!;

describe("reflection apply (AC-16 to AC-19)", () => {
  it("writes the plan file, creates the plan issue and files each item with its marker", async () => {
    const w = await applyWorld();
    const out = await applyReflectionResult(w.d, delivery, "k1", "run-1", result([item(1), item(2)]));
    expect(out).toMatchObject({ plan_issue: 201, filed: [202, 203], deferred: 0 });
    const p = plan(w);
    expect(p.title).toBe("Delivery plan 2026-10-26");
    expect(p.labels).toEqual(["reflection", "reflection:delivery"]);
    expect(p.body).toMatch(/<!-- panelator-reflection:k1:plan -->$/);
    expect(p.body).toContain("#202 Item 1 (bottleneck)");
    const filed = w.issues[1]!;
    expect(filed.labels).toEqual(["class:tooling", "validated"]);
    expect(filed.body.startsWith("Plan: #201\nKind: bottleneck\n\n")).toBe(true);
    expect(filed.body.endsWith("<!-- panelator-reflection:k1:0 -->")).toBe(true);
    expect(JSON.parse(readFileSync(join(w.paths.reflections, "delivery-reflection", "k1.json"), "utf8"))).toMatchObject({ plan_issue: 201, filed: [{ issue: 202 }, { issue: 203 }] });
    const db = openIndex(w.paths);
    expect(db.prepare("SELECT count(*) AS c FROM events WHERE kind IN ('reflection.plan', 'issue.filed')").get()).toEqual({ c: 4 });
    db.close();
  });

  it("lists the input's open questions in the plan body, whatever the agent's note says", async () => {
    const w = await applyWorld();
    const input = { open_questions: [{ issue: 103, asking_stage: "spec", sent_at: "2026-10-03T10:00:00.000Z", question: "Which audience again?" }] };
    await applyReflectionResult(w.d, delivery, "k", "r", result([], { }), input);
    const section = plan(w).body.split("## Open questions")[1]!.split("## Items")[0]!;
    expect(section).toContain("#103 (spec, sent 2026-10-03T10:00:00.000Z): Which audience again?");
    const w2 = await applyWorld();
    await applyReflectionResult(w2.d, delivery, "k", "r", { ...result([]), plan: { ...result([]).plan, open_questions_note: "none" } }, input);
    expect(plan(w2).body).toContain("Which audience again?");
    expect(plan(w2).body).toContain("none");
  });

  it("still creates the plan issue when there are no items, and says so", async () => {
    const w = await applyWorld();
    await applyReflectionResult(w.d, delivery, "k", "r", result([]));
    expect(plan(w).body).toContain("This plan has no items.");
    expect(w.issues).toHaveLength(1);
  });

  it("files the first eight and defers the rest as over the plan bound", async () => {
    const w = await applyWorld();
    await applyReflectionResult(w.d, delivery, "k", "r", result(Array.from({ length: 12 }, (_, i) => item(i + 1))));
    expect(w.issues.filter((i) => i.labels.includes("validated"))).toHaveLength(8);
    const stored = JSON.parse(readFileSync(join(w.paths.reflections, "delivery-reflection", "k.json"), "utf8"));
    expect(stored.deferred).toEqual([9, 10, 11, 12].map((n) => ({ title: `Item ${n}`, why: "over the plan bound" })));
    expect(plan(w).body).toContain("Item 9: over the plan bound");
  });

  it("counts items found by their marker toward the bound on a retry", async () => {
    const w = await applyWorld();
    const items = Array.from({ length: 12 }, (_, i) => item(i + 1));
    await applyReflectionResult(w.d, delivery, "k", "r", result(items));
    await applyReflectionResult(w.d, delivery, "k", "r", result(items));
    expect(w.issues.filter((i) => i.labels.includes("validated"))).toHaveLength(8);
  });

  it("defers an item with an unknown class, a short body or a metric_change without a rationale, and files the rest", async () => {
    const w = await applyWorld();
    await applyReflectionResult(w.d, delivery, "k", "r", result([
      item(1, { class: "class:nope" }), item(2, { body: "short" }), item(3, { kind: "metric_change" }),
      item(4, { kind: "metric_change", body: `${long("x")}\n\n## Rationale\nBecause.` }), item(5),
    ]));
    expect(w.issues.filter((i) => i.labels.includes("validated")).map((i) => i.title)).toEqual(["Item 4", "Item 5"]);
    const body = plan(w).body;
    expect(body).toContain("Item 1: class class:nope is not a class label");
    expect(body).toContain("Item 2: body is under 200 characters");
    expect(body).toContain("Item 3: a metric_change needs a ## Rationale section");
  });

  it("comments on an existing issue instead of filing, once", async () => {
    const w = await applyWorld([{ number: 90, title: "x", body: "", author: "bot", labels: [], createdAt: "", labelEvents: [] }]);
    await applyReflectionResult(w.d, delivery, "k", "r", result([item(1, { existing_issue: 90 })]));
    await applyReflectionResult(w.d, delivery, "k", "r", result([item(1, { existing_issue: 90 })]));
    expect(w.comments.get(90)).toHaveLength(1);
    expect(w.comments.get(90)![0]).toMatch(/plan #\d+ points here/);
  });

  it("closes the previous plan issue of the same agent with a link to the new one", async () => {
    const w = await applyWorld([
      { number: 50, title: "Delivery plan old", body: "<!-- panelator-reflection:old:plan -->", author: "bot", labels: ["reflection", "reflection:delivery"], createdAt: "", labelEvents: [] },
      { number: 51, title: "Charter plan old", body: "<!-- panelator-reflection:oldc:plan -->", author: "bot", labels: ["reflection", "reflection:charter"], createdAt: "", labelEvents: [] },
    ]);
    await applyReflectionResult(w.d, delivery, "k", "r", result([]));
    expect(w.closed).toEqual([50]);
    expect(w.comments.get(50)![0]).toBe("Superseded by #201.");
  });

  it("strips Spec: lines from an item body so the chain starts at the spec stage", async () => {
    const w = await applyWorld();
    await applyReflectionResult(w.d, delivery, "k", "r", result([item(1, { body: `${long("Smuggle")}\nSpec: specs/011-telegram-conversations/spec.md\n  Spec: specs/012-metrics-reflection/spec.md` })]));
    const filed = w.issues.find((i) => i.title === "Item 1")!;
    expect(filed.body).not.toMatch(/^\s*Spec:/m);
    expect(filed.body).toContain("Smuggle: change the thing");
  });

  it("marks an item that touches the charter", async () => {
    const w = await applyWorld();
    await applyReflectionResult(w.d, delivery, "k", "r", result([item(1, { body: `${long("Amend")} Edit docs/charter.md to add a clause.`, kind: "charter" })]));
    expect(plan(w).body).toContain("charter change: needs the maintainer");
    expect(w.issues.some((i) => i.title === "Item 1")).toBe(true);
  });

  it("creates no second plan issue or item when the same key runs again after a crash", async () => {
    const w = await applyWorld();
    let fail = 1;
    const create = w.gh.createIssue;
    w.gh.createIssue = async (...a: Parameters<typeof create>) => { if (w.issues.length === 1 && fail-- > 0) throw new Error("boom"); return create(...a); };
    await expect(applyReflectionResult(w.d, delivery, "k", "r1", result([item(1), item(2)]))).rejects.toThrow("boom");
    await applyReflectionResult(w.d, delivery, "k", "r2", result([item(1), item(2)]));
    expect(w.issues.filter((i) => i.body.includes(":plan -->"))).toHaveLength(1);
    expect(w.issues.filter((i) => /^Item/.test(i.title))).toHaveLength(2);
  });

  it("refuses an action outside the agent's list, and queues a level 2 request as a finding", async () => {
    const why = "the evidence supports this change";
    const w = await applyWorld([], (d) => { d.actionCtx.levels.set_parameter = 2; });
    await applyReflectionResult(w.d, delivery, "k", "r", result([], { actions: [{ kind: "set_parameter", args: { name: "slots", value: 2 }, why }, { kind: "rerun_workflow", args: { run_id: 1 }, why }] }));
    expect((await new ActionLog(w.paths.actionsLog).list()).map((r) => [r.kind, r.status, r.reason])).toEqual([["set_parameter", "refused", "level 2"], ["rerun_workflow", "refused", "action not allowed"]]);
    expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);
    expect(plan(w).body).toContain("set_parameter");
  });

  it("writes only under the state directory and calls only the GitHub operations the spec names (AC-18)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "reflection", "apply.ts"), "utf8");
    const ops = new Set([...src.matchAll(/\bd\.gh\.(\w+)/g)].map((m) => m[1]));
    expect([...ops].sort()).toEqual(["closeIssue", "comment", "ensureLabels", "listComments", "searchOpenIssuesByMarker", "setIssueBody"]);
    for (const m of src.matchAll(/\b(writeFile|rename|mkdir|rm|unlink|appendFile)\(([^)]*)\)/g)) expect(m[2], m[0]).toMatch(/dir|file|paths/);
    expect(src).not.toMatch(/writeFile\([^)]*(agents|docs)/);
  });
});
