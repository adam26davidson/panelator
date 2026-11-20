import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { record } from "../src/events/store.ts";
import { buildReflectionInput, type ReflectionDeps } from "../src/reflection/input.ts";
import { loadMetricDefinitions } from "../src/metrics/definitions.ts";
import { validate } from "../src/schema/validate.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { initializeAgents } from "../src/standing/state.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { KINDS } from "../src/actions/index.ts";
import { git } from "./helpers/repo-pair.ts";
import type { IssueData } from "../src/types.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const FROM = new Date("2026-11-03T12:00:00.000Z");
const registry = () => loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, Object.keys(KINDS));

async function world() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "reflection-")));
  await ensureStateDirs(paths);
  return paths;
}
const issueData = (number: number, over: Partial<IssueData> = {}): IssueData => ({ number, title: `t${number}`, author: "bot", body: "", labels: [], labelEvents: [], createdAt: "2026-10-01T00:00:00Z", state: "open", ...over });
function deps(paths: ReturnType<typeof statePaths>, over: Partial<ReflectionDeps> = {}, issues: IssueData[] = []): ReflectionDeps {
  return {
    paths, botLogin: "bot", parameters: { all: async () => ({}) } as never, metrics: loadMetricDefinitions(join(agentsDir, "metrics")), agentsDir,
    reflectionAgents: ["delivery-reflection", "charter-reflection", "meta-reflection"], now: () => NOW,
    gh: { listIssues: async () => issues, issue: async (n: number) => issues.find((i) => i.number === n) ? { number: n, author: "bot", state: "open", labels: issues.find((i) => i.number === n)!.labels, closedAt: null, pullRequests: [] } : null },
    ...over,
  };
}
const merge = (paths: ReturnType<typeof statePaths>, issue: number, pr: number, at = "2026-11-05T10:00:00.000Z") => record(paths, "merge", at, { issue, pr, cls: "class:tooling", at, work: "system" }, { issue });

describe("reflection input (spec 028 AC-5)", () => {
  it("carries every qualifying issue in issue order: 70 timelines, no cap", async () => {
    const paths = await world();
    for (let n = 70; n >= 1; n--) await merge(paths, n, 1000 + n);
    const def = registry()["delivery-reflection"]!;
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const input = await buildReflectionInput(deps(paths), def, "run-1", FROM, root);
    expect((input.issues as { issue: number }[]).map((i) => i.issue)).toEqual(Array.from({ length: 70 }, (_, i) => i + 1));
    expect(validate("reflection-input", input)).toEqual({ ok: true });
  });

  it("builds the timeline of an issue from its events and records the run's metrics.snapshot", async () => {
    const paths = await world();
    await record(paths, "issue.eligible", "2026-11-04T00:00:00.000Z", { rank: 1, work: "system", cls: "class:tooling", stops_pipeline: false, validated_at: "2026-11-04T00:00:00.000Z", created_at: "2026-11-03T00:00:00.000Z" }, { issue: 7 });
    await record(paths, "issue.claimed", "2026-11-04T01:00:00.000Z", {}, { issue: 7 });
    await record(paths, "pause.started", "2026-11-04T02:00:00.000Z", { stage: "spec", reason: "question" }, { issue: 7 });
    const input = await buildReflectionInput(deps(paths), registry()["delivery-reflection"]!, "run-1", FROM, mkdtempSync(join(tmpdir(), "root-")));
    const [t] = input.issues as { issue: number; eligible_at: string; claimed_at: string[]; pauses: unknown[] }[];
    expect(t).toMatchObject({ issue: 7, eligible_at: "2026-11-04T00:00:00.000Z", claimed_at: ["2026-11-04T01:00:00.000Z"] });
    expect(t!.pauses).toHaveLength(1);
    const { openIndex } = await import("../src/events/index.ts");
    const db = openIndex(paths, { readOnly: true });
    expect((db.prepare("SELECT count(*) AS c FROM events WHERE kind = 'metrics.snapshot' AND run_id = 'run-1'").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("lists an open question although nothing else is pending, and drops an answered one", async () => {
    const paths = await world();
    await appendQuestionLog(paths, { issue: 9, at: "2026-11-05T00:00:00.000Z", event: "sent", asking_stage: "spec", question_comment_id: 55 }, "Should we ship X?");
    await appendQuestionLog(paths, { issue: 10, at: "2026-11-05T00:00:00.000Z", event: "sent", asking_stage: "plan", question_comment_id: 56 }, "Y?");
    await appendQuestionLog(paths, { issue: 10, at: "2026-11-06T00:00:00.000Z", event: "answered", asking_stage: "plan", question_comment_id: 56 });
    const input = await buildReflectionInput(deps(paths), registry()["delivery-reflection"]!, "r", FROM, mkdtempSync(join(tmpdir(), "root-")));
    expect(input.open_questions).toEqual([{ issue: 9, stage: "spec", sent_at: "2026-11-05T00:00:00.000Z", question: "Should we ship X?" }]);
  });

  it("matches answers to the question comment, not merely the issue and stage", async () => {
    const paths = await world();
    await appendQuestionLog(paths, { issue: 9, at: "2026-11-05T00:00:00.000Z", event: "sent", asking_stage: "spec", question_comment_id: 55 }, "First question?");
    await appendQuestionLog(paths, { issue: 9, at: "2026-11-05T01:00:00.000Z", event: "sent", asking_stage: "spec", question_comment_id: 56 }, "Follow-up?");
    await appendQuestionLog(paths, { issue: 9, at: "2026-11-06T00:00:00.000Z", event: "answered", asking_stage: "spec", question_comment_id: 55 });
    const input = await buildReflectionInput(deps(paths), registry()["delivery-reflection"]!, "r", FROM, mkdtempSync(join(tmpdir(), "root-")));
    expect(input.open_questions).toEqual([{ issue: 9, stage: "spec", sent_at: "2026-11-05T01:00:00.000Z", question: "Follow-up?" }]);
  });

  it("groups maintainer contacts by kind and label and marks a recurring kind (charter reflection)", async () => {
    const paths = await world();
    const c = (at: string, label: string, text: string) => record(paths, "maintainer.contact", at, { channel: "issue", kind: "question", label, text });
    await c("2026-11-04T00:00:00.000Z", "spec", "a"); await c("2026-11-05T00:00:00.000Z", "spec", "b"); await c("2026-11-06T00:00:00.000Z", "plan", "c");
    const root = mkdtempSync(join(tmpdir(), "root-"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/charter.md"), "# Charter\n\nFirst clause.\n\nSecond clause.\n");
    const input = await buildReflectionInput(deps(paths), registry()["charter-reflection"]!, "r", FROM, root);
    expect(input.maintainer_contacts).toEqual([
      { kind: "question", label: "spec", count: 2, first: "2026-11-04T00:00:00.000Z", last: "2026-11-05T00:00:00.000Z", examples: ["a", "b"], recurring: true },
      { kind: "question", label: "plan", count: 1, first: "2026-11-06T00:00:00.000Z", last: "2026-11-06T00:00:00.000Z", examples: ["c"], recurring: false },
    ]);
    expect((input.charter as { n: number }[]).map((x) => x.n)).toEqual([1, 2, 3]);
    expect(validate("reflection-input", input)).toEqual({ ok: true });
  });

  it("shows a plan's abandoned issue as abandoned in previous_plans, and lists open bot issues", async () => {
    const paths = await world();
    await record(paths, "issue.released", "2026-11-05T00:00:00.000Z", { reason: "abandoned" }, { issue: 41 });
    const plan = { title: "T", summary: "s", observations: [], items: [], metrics_note: "", open_questions_note: "", deferred: [] };
    await record(paths, "reflection.plan", "2026-11-01T00:00:00.000Z", { plan, plan_key: "delivery-reflection-1", plan_issue: 40, filed: [41, 42] }, { agent: "delivery-reflection" });
    const input = await buildReflectionInput(deps(paths, {}, [issueData(41, { state: "closed", labels: ["abandoned"] }), issueData(42, { labels: ["in-progress"] }), issueData(43, { author: "someone" })]), registry()["delivery-reflection"]!, "r", FROM, mkdtempSync(join(tmpdir(), "root-")));
    const [p] = input.previous_plans as { plan_issue: number; filed: { issue: number; state: string }[] }[];
    expect(p!.filed).toEqual([{ issue: 41, state: "abandoned" }, { issue: 42, state: "in progress" }]);
    expect((input.open_bot_issues as { number: number }[]).map((i) => i.number)).toEqual([42]);
  });

  it("derives design_tree from a fixture repository: the adding commit's (#N), the merge events, planned children", async () => {
    const paths = await world();
    const root = mkdtempSync(join(tmpdir(), "repo-"));
    git(root, "init", "-q", "-b", "main");
    const put = (p: string, c: string) => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); };
    put("docs/charter.md", "# Charter\n");
    put("docs/delivery-system-design.md", "Parent: docs/charter.md\n## Children\n- `docs/designs/x.md`\n");
    put("docs/designs/x.md", "Parent: docs/delivery-system-design.md\n## Children\n- `specs/010-a/spec.md`\n- `docs/designs/missing.md`\n- planned: nolink\n  title: No link\n  brief: b\n- planned: dead\n  title: Dead one\n  brief: b\n  issue: #99\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "init");
    put("specs/010-a/spec.md", "# 010. A\n\nStatus: written\n");
    put("specs/011-b/spec.md", "# 011. B\n\nStatus: written\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "spec 010: a (#500)");
    await merge(paths, 17, 500, "2026-10-01T00:00:00.000Z");
    await merge(paths, 17, 510, "2026-11-05T00:00:00.000Z");
    const input = await buildReflectionInput(deps(paths, {}, [issueData(99, { state: "closed", labels: ["abandoned"] })]), registry()["delivery-reflection"]!, "r", FROM, root);
    const tree = input.design_tree as { designs: { path: string; children: Record<string, unknown>[] }[]; specs: Record<string, unknown>[] };
    expect(tree.specs.find((s) => s.path === "specs/010-a/spec.md")).toMatchObject({ status: "written", issue: 17, implemented: true });
    // spec 011 was added by the same commit, whose (#500) names issue 17 too: both derive from the commit.
    const x = tree.designs.find((d) => d.path === "docs/designs/x.md")!;
    expect(x.children).toContainEqual({ kind: "file", path: "docs/designs/missing.md", exists: false });
    expect(x.children).toContainEqual({ kind: "planned", slug: "nolink", title: "No link", issue: null, done: false, dead: false });
    expect(x.children).toContainEqual({ kind: "planned", slug: "dead", title: "Dead one", issue: 99, done: false, dead: true });
    expect(validate("reflection-input", input)).toEqual({ ok: true });
  });
  it("sets implemented false when only the spec's own PR merged, and null with no issue", async () => {
    const paths = await world();
    const root = mkdtempSync(join(tmpdir(), "repo-"));
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "specs/020-c"), { recursive: true });
    writeFileSync(join(root, "specs/020-c/spec.md"), "Status: written\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "spec 020 (#600)");
    mkdirSync(join(root, "specs/021-d"), { recursive: true });
    writeFileSync(join(root, "specs/021-d/spec.md"), "Status: written\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "no number here");
    await merge(paths, 30, 600, "2026-10-01T00:00:00.000Z");
    const input = await buildReflectionInput(deps(paths), registry()["delivery-reflection"]!, "r", FROM, root);
    const specs = (input.design_tree as { specs: Record<string, unknown>[] }).specs;
    expect(specs.find((s) => s.path === "specs/020-c/spec.md")).toMatchObject({ issue: 30, implemented: false });
    expect(specs.find((s) => s.path === "specs/021-d/spec.md")).toMatchObject({ issue: null, implemented: null });
  });
});

import { readFileSync } from "node:fs";
import { applyReflectionResult, planMarker, itemMarker, commentMarker, type ApplyDeps, type ReflectionResult, type PlanItem } from "../src/reflection/apply.ts";
import { openIndex } from "../src/events/index.ts";

interface FakeIssue { number: number; title: string; body: string; labels: string[]; author: string; state: "open" | "closed"; comments: { author: string; body: string }[] }
function fakeGh(seed: FakeIssue[] = []) {
  const issues = new Map(seed.map((i) => [i.number, i]));
  let next = 100;
  const called = new Set<string>();
  const failAt = { create: 0, n: 0 };
  const tap = <T extends (...a: never[]) => unknown>(name: string, fn: T) => ((...a: never[]) => { called.add(name); return fn(...a); }) as T;
  const gh = {
    createIssue: tap("createIssue", async (title: string, body: string, labels: string[]) => {
      if (failAt.create && ++failAt.n === failAt.create) throw new Error("boom");
      const number = next++;
      issues.set(number, { number, title, body, labels, author: "bot", state: "open", comments: [] });
      return number;
    }),
    comment: tap("comment", async (n: number, body: string) => { issues.get(n)!.comments.push({ author: "bot", body }); return { id: 1, created_at: "x" }; }),
    listComments: tap("listComments", async (n: number) => (issues.get(n)?.comments ?? []).map((c, i) => ({ id: i, author: c.author, at: "x", body: c.body }))),
    closeIssue: tap("closeIssue", async (n: number, c: string) => { if (c) issues.get(n)!.comments.push({ author: "bot", body: c }); issues.get(n)!.state = "closed"; }),
    setIssueBody: tap("setIssueBody", async (n: number, body: string) => { issues.get(n)!.body = body; }),
    searchOpenIssuesByMarker: tap("searchOpenIssuesByMarker", async (m: string) => [...issues.values()].filter((i) => i.state === "open" && i.body.includes(m)).map((i) => issueData(i.number, { author: i.author, body: i.body, labels: i.labels }))),
    issue: tap("issue", async (n: number) => { const i = issues.get(n); return i ? { number: n, author: i.author, state: i.state, labels: i.labels, closedAt: null, pullRequests: [] } : null; }),
  };
  return { gh: gh as unknown as ApplyDeps["gh"], issues, called, failAt };
}
const body = (extra = "") => `What: change X. Why: evidence from issue 12 and the merged_per_week metric shows a slow stage. How to tell: issue_to_merge_days should fall. ${extra}`.padEnd(220, ".");
const item = (i: number, over: Partial<PlanItem> = {}): PlanItem => ({ title: `Item ${i}`, body: body(), class: "class:tooling", kind: "bottleneck", ...over });
const resultOf = (items: PlanItem[], over: Partial<ReflectionResult["plan"]> = {}): ReflectionResult => ({ summary: "s", plan: { title: "T", summary: "The summary", observations: [{ what: "obs", evidence: "ev" }], items, metrics_note: "m", open_questions_note: "none", deferred: [], ...over } });
async function applyWorld(over: Partial<ApplyDeps> = {}, seed: FakeIssue[] = []) {
  const paths = await world();
  const f = fakeGh(seed);
  let clock = NOW.getTime();
  let directCalls = 0;
  const base: ApplyDeps = { paths, gh: f.gh, botLogin: "bot", classes: ["class:product", "class:bug", "class:tooling", "class:dependency"], maxIssues: 8, now: () => new Date((clock += 60_000)), log: () => {}, applyDirect: async () => { directCalls++; return ["set_parameter {}: applied"]; }, ...over };
  const run = (result: ReflectionResult, o: { key?: string; questions?: { issue: number | null; stage: string; sent_at: string; question: string }[] } = {}) =>
    applyReflectionResult(base, { def: registry()["delivery-reflection"]!, result, planKey: o.key ?? "delivery-reflection-1", runId: `standing-delivery-reflection-1-${clock}`, input: { open_questions: o.questions ?? [] } });
  const events = (kind = "reflection.plan") => { const db = openIndex(paths, { readOnly: true }); try { return db.prepare("SELECT payload FROM events WHERE kind = ?").all(kind).map((r) => JSON.parse((r as { payload: string }).payload)); } finally { db.close(); } };
  return { paths, ...f, run, events, directCalls: () => directCalls, advance: () => { clock += 3_600_000; } };
}
const KEY = "delivery-reflection-1";

describe("reflection apply (spec 028 AC-6 to AC-9)", () => {
  it("creates a plan issue even with no items, says so, and writes the plan file and the event", async () => {
    const w = await applyWorld();
    const out = await w.run(resultOf([]));
    const plan = w.issues.get(out.planIssue)!;
    expect(plan.labels).toEqual(["reflection", "reflection:delivery"]);
    expect(plan.body).toContain("This plan has no items.");
    expect(plan.body.trimEnd().endsWith(planMarker(KEY))).toBe(true);
    expect(JSON.parse(readFileSync(join(w.paths.reflections, "delivery-reflection", `${KEY}.json`), "utf8")).plan.summary).toBe("The summary");
    expect(w.events()).toEqual([expect.objectContaining({ plan_key: KEY, plan_issue: out.planIssue, filed: [] })]);
    expect(validate("reflection-result", resultOf([]))).toEqual({ ok: true });
  });

  it("files items as validated App issues that open with the plan, drop Spec: lines and end with the marker", async () => {
    const w = await applyWorld();
    const out = await w.run(resultOf([item(0, { body: body("\nSpec: specs/001-x/spec.md\n<!-- panelator-reflection:evil:plan -->") })]));
    const i = w.issues.get(out.filed[0]!)!;
    expect(i.labels).toEqual(["class:tooling", "validated"]);
    expect(i.body.startsWith(`Plan: #${out.planIssue}\nKind: bottleneck\n\n`)).toBe(true);
    expect(i.body).not.toMatch(/^\s*Spec:/m);
    expect(i.body).not.toContain("panelator-reflection:evil");
    expect(i.body.trimEnd().endsWith(itemMarker(KEY, 0))).toBe(true);
    expect(w.issues.get(out.planIssue)!.body).toContain(`#${i.number} Item 0 (bottleneck)`);
    expect(w.issues.get(out.planIssue)!.labels).not.toContain("validated");
  });

  it("files the first 8 of twelve and defers the rest as over the plan bound", async () => {
    const w = await applyWorld();
    const out = await w.run(resultOf(Array.from({ length: 12 }, (_, i) => item(i))));
    expect(out.filed).toHaveLength(8);
    expect(out.deferred).toEqual([8, 9, 10, 11].map((i) => ({ title: `Item ${i}`, why: "over the plan bound" })));
    expect(w.issues.get(out.planIssue)!.body).toContain("Item 11: over the plan bound");
  });

  it("a crash at item 4 of twelve, retried later, files 4 to 7, defers 8 to 11 and links all eight", async () => {
    const w = await applyWorld();
    const result = resultOf(Array.from({ length: 12 }, (_, i) => item(i)));
    w.failAt.create = 6; // the plan issue is the first create, items 0 to 3 the next four, item 4 the sixth
    await expect(w.run(result)).rejects.toThrow("boom");
    w.advance();
    const out = await w.run(result);
    expect(out.filed).toHaveLength(8);
    const body = w.issues.get(out.planIssue)!.body;
    for (const n of out.filed) expect(body).toContain(`#${n} `);
    for (let i = 0; i < 8; i++) expect(body).toContain(`Item ${i} (`);
    expect(out.deferred.map((d) => d.title)).toEqual(["Item 8", "Item 9", "Item 10", "Item 11"]);
    expect([...w.issues.values()].filter((i) => i.labels.includes("validated"))).toHaveLength(8);
    expect([...w.issues.values()].filter((i) => i.labels.includes("reflection"))).toHaveLength(1);
    expect(w.events()).toHaveLength(1);
  });

  it("a crash after the plan issue creates no second plan issue and the rewritten body names the items of both attempts", async () => {
    const w = await applyWorld();
    const result = resultOf([item(0), item(1), item(2)]);
    w.failAt.create = 3; // plan, item 0, then item 1 fails
    await expect(w.run(result)).rejects.toThrow("boom");
    w.advance();
    const out = await w.run(result);
    expect([...w.issues.values()].filter((i) => i.labels.includes("reflection"))).toHaveLength(1);
    const body = w.issues.get(out.planIssue)!.body;
    for (const n of out.filed) expect(body).toContain(`#${n} `);
    expect(out.filed).toHaveLength(3);
    // the item found by its marker was left as it was
    expect(w.issues.get(out.filed[0]!)!.body).toContain(`Plan: #${out.planIssue}`);
  });

  it("counts all existing items of the key before creating anything on a changed retry", async () => {
    const w = await applyWorld();
    await w.run(resultOf(Array.from({ length: 8 }, (_, i) => item(i))));
    w.advance();
    const out = await w.run(resultOf([item(0, { class: "invalid" }), ...Array.from({ length: 8 }, (_, i) => item(i + 1))]));
    expect([...w.issues.values()].filter((i) => i.labels.includes("validated"))).toHaveLength(8);
    expect(out.deferred).toContainEqual({ title: "Item 8", why: "over the plan bound" });
  });

  it("applies the direct actions once per plan key, and lists them in the plan", async () => {
    const w = await applyWorld();
    const result = resultOf([item(0), item(1)]);
    w.failAt.create = 3;
    await expect(w.run(result)).rejects.toThrow("boom");
    w.advance();
    const out = await w.run(result);
    expect(w.directCalls()).toBe(1);
    expect(w.issues.get(out.planIssue)!.body).toContain("- set_parameter {}: applied");
  });

  it("comments once on an existing_issue, even across a retry", async () => {
    const w = await applyWorld({}, [{ number: 5, title: "old", body: "b", labels: [], author: "bot", state: "open", comments: [] }]);
    const result = resultOf([item(0, { existing_issue: 5 })]);
    await w.run(result);
    w.advance();
    await w.run(result);
    const comments = w.issues.get(5)!.comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.trimEnd().endsWith(commentMarker(KEY, 0))).toBe(true);
  });

  it("lists an open question from the input although the agent's note says none", async () => {
    const w = await applyWorld();
    const out = await w.run(resultOf([], { open_questions_note: "none" }), { questions: [{ issue: 9, stage: "spec", sent_at: "2026-11-05T00:00:00.000Z", question: "Should we ship X?" }] });
    expect(w.issues.get(out.planIssue)!.body).toContain("- #9 (spec, sent 2026-11-05T00:00:00.000Z): Should we ship X?");
  });

  it("closes the previous plan by its recorded number, and leaves a collaborator's issue labelled reflection:delivery", async () => {
    const w = await applyWorld({}, [
      { number: 7, title: "Delivery plan", body: "x", labels: ["reflection", "reflection:delivery"], author: "bot", state: "open", comments: [] },
      { number: 8, title: "fake", body: "x", labels: ["reflection:delivery"], author: "collab", state: "open", comments: [] },
      { number: 9, title: "fake2", body: "x", labels: ["reflection:delivery"], author: "collab", state: "open", comments: [] },
    ]);
    await record(w.paths, "reflection.plan", "2026-11-01T00:00:00.000Z", { plan: resultOf([]).plan, plan_key: "delivery-reflection-0", plan_issue: 7, filed: [] }, { agent: "delivery-reflection" });
    const out = await w.run(resultOf([]));
    expect(w.issues.get(7)!.state).toBe("closed");
    expect(w.issues.get(7)!.comments[0]!.body).toContain(`#${out.planIssue}`);
    expect(w.issues.get(8)!.state).toBe("open");
    expect(w.issues.get(out.planIssue)!.state).toBe("open");
    // a predecessor recorded as a collaborator's issue is kept
    const w2 = await applyWorld({}, [{ number: 8, title: "fake", body: "x", labels: ["reflection:delivery"], author: "collab", state: "open", comments: [] }]);
    await record(w2.paths, "reflection.plan", "2026-11-01T00:00:00.000Z", { plan: resultOf([]).plan, plan_key: "delivery-reflection-0", plan_issue: 8, filed: [] }, { agent: "delivery-reflection" });
    await w2.run(resultOf([]));
    expect(w2.issues.get(8)!.state).toBe("open");
  });

  it("files a charter-change item and marks it in the plan; defers bad class, short body and a metric_change without rationale", async () => {
    const w = await applyWorld();
    const out = await w.run(resultOf([
      item(0, { body: body("Change docs/charter.md clause 3.") }),
      item(1, { class: "class:nonsense" }), item(2, { body: "short" }),
      item(3, { kind: "metric_change" }), item(4, { kind: "metric_change", body: `## Rationale\nwhy.\n${body()}` }),
    ]));
    expect(out.filed).toHaveLength(2);
    expect(w.issues.get(out.planIssue)!.body).toContain("charter change: needs the maintainer");
    expect(out.deferred.map((d) => d.why)).toEqual(["class class:nonsense is not a class label", "body is under 200 characters", "a metric_change needs a ## Rationale section"]);
  });

  it("calls only the GitHub operations of AC-8 and writes only under the state directory", async () => {
    const w = await applyWorld({}, [{ number: 5, title: "old", body: "b", labels: [], author: "bot", state: "open", comments: [] }]);
    await w.run(resultOf([item(0), item(1, { existing_issue: 5 })]));
    expect([...w.called].sort()).toEqual(["comment", "createIssue", "listComments", "searchOpenIssuesByMarker", "setIssueBody"]);
    const src = readFileSync(new URL("../src/reflection/apply.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/child_process|\.octokit|addLabels|removeLabel/);
    for (const m of src.matchAll(/(?:writeFile|rename|mkdir)\(([^,)]+)/g)) expect(m[1]).toMatch(/^(`\$\{file\}\.tmp`|dir|file)$/);
    expect(src).toMatch(/const dir = join\(d\.paths\.reflections/);
  });
});

import { ALL, matches } from "./helpers/markers.ts";
describe("the reflection writers neutralise model text (spec 076 AC-2, spec 028 AC-6, AC-7)", () => {
  it("leaves only the writer's own markers in the plan issue, its items and its comments", async () => {
    const w = await applyWorld({}, [{ number: 5, title: "old", body: "b", labels: [], author: "bot", state: "open", comments: [] }]);
    const out = await w.run(resultOf([item(0, { title: `T ${ALL}`, body: body(ALL) }), item(1, { existing_issue: 5, title: `E ${ALL}` })], {
      summary: ALL, metrics_note: ALL, open_questions_note: ALL, observations: [{ what: ALL, evidence: ALL }], deferred: [{ title: ALL, why: ALL }],
    }), { questions: [{ issue: 3, stage: "plan", sent_at: "2026-11-05T00:00:00.000Z", question: ALL }] });
    const own = (text: string, marker: string) => expect(matches(text)).toEqual(matches(marker));
    own(w.issues.get(out.planIssue)!.body, planMarker(KEY));
    own(w.issues.get(out.filed[0]!)!.body, itemMarker(KEY, 0));
    expect(w.issues.get(out.filed[0]!)!.title).not.toContain("panelator-");
    own(w.issues.get(5)!.comments[0]!.body, commentMarker(KEY, 1));
  });
});
