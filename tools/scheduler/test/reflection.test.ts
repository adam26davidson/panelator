import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { recordEvent } from "../src/events/store.ts";
import { buildReflectionInput, charterClauses } from "../src/reflection/input.ts";
import { applyReflectionResult, type ReflectionGitHub, type ReflectionResult } from "../src/reflection/apply.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { initializeAgents, readAgentState } from "../src/standing/state.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { registryActionsCheck } from "../src/actions/index.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import type { RawIssue } from "../src/github/types.ts";

const registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
const long = "x".repeat(210);

/** An in-memory GitHub that records every operation name it is called with. */
function fakeGh() {
  const issues: RawIssue[] = [];
  const ops: string[] = [];
  const gh: ReflectionGitHub = {
    async createIssue(title, body, labels) { ops.push("createIssue"); issues.push({ number: 100 + issues.length, title, body, author: "bot", labels, state: "open", created_at: "", closed_at: null }); return 99 + issues.length; },
    async comment() { ops.push("comment"); return { id: 1, created_at: "" }; },
    async closeIssue(n) { ops.push("closeIssue"); issues.find((i) => i.number === n)!.state = "closed"; },
    async setIssueBody(n, body) { ops.push("setIssueBody"); issues.find((i) => i.number === n)!.body = body; },
    async listIssuesRaw(o) { ops.push("listIssuesRaw"); return issues.filter((i) => (o.state === "all" || i.state === o.state) && (!o.labels || i.labels.includes(o.labels))); },
    async ensureLabel() { ops.push("ensureLabel"); },
    async listComments() { ops.push("listComments"); return []; },
  };
  return { gh, issues, ops };
}

describe("reflection apply (AC-16 to AC-19)", () => {
  const def = registry["delivery-reflection"];
  const item = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: long, class: "class:tooling", kind: "bottleneck" as const, ...extra });
  const result = (items: ReflectionResult["plan"]["items"]): ReflectionResult => ({ summary: "s", plan: { title: "t", summary: "s", observations: [], items, metrics_note: "", open_questions_note: "", deferred: [] } });

  it("writes only under the state directory and calls only the named GitHub operations (AC-18)", async () => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "reflect-")));
    await ensureStateDirs(paths);
    const { gh, ops } = fakeGh();
    await applyReflectionResult({ paths, gh, botLogin: "bot", now: () => new Date("2026-10-28T00:00:00Z"), classes: ["class:tooling"], maxIssues: 8 }, def, "run-1", "key-1", result([item("A"), item("B", { kind: "metric_change" })]));
    const allowed = new Set(["createIssue", "comment", "closeIssue", "setIssueBody", "listIssuesRaw", "ensureLabel", "listComments"]);
    expect(ops.every((o) => allowed.has(o))).toBe(true);
    const written: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : written.push(join(d, f.name)); };
    walk(paths.root);
    expect(written.every((f) => !relative(paths.root, f).startsWith(".."))).toBe(true);
    expect(written.some((f) => f.includes("reflections"))).toBe(true);
    // The module's source holds no file write outside the state directory, no repository path and no agents/ path.
    const src = readFileSync(join(import.meta.dirname, "..", "src", "reflection", "apply.ts"), "utf8");
    expect(src).not.toMatch(/writeFileSync|execFile|spawn|child_process|simple-git/);
    for (const m of src.matchAll(/\b(writeFile|mkdir|rename)\(([^,)]+)/g)) expect(m[2]).toMatch(/d\.paths\.reflections|path|file/);
  });

  it("the plan marker makes a rerun create nothing twice, and a metric_change needs its rationale (AC-16, AC-19)", async () => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "reflect-")));
    await ensureStateDirs(paths);
    const { gh, issues } = fakeGh();
    const d = { paths, gh, botLogin: "bot", now: () => new Date("2026-10-28T00:00:00Z"), classes: ["class:tooling"], maxIssues: 8 };
    const r = result([item("A"), item("B", { kind: "metric_change" }), item("C", { kind: "metric_change", body: `${long}\n\n## Rationale\nwhy` })]);
    const first = await applyReflectionResult(d, def, "run-1", "key-1", r);
    expect(first.deferred).toEqual([{ title: "B", why: "metric_change without a ## Rationale section" }]);
    const again = await applyReflectionResult(d, def, "run-2", "key-1", r);
    expect(again.plan_issue).toBe(first.plan_issue);
    expect(issues).toHaveLength(3); // plan, A, C
    expect(issues[0].body.trimEnd().endsWith("<!-- panelator-reflection:key-1:plan -->")).toBe(true);
    expect(issues[0].labels).toEqual(["reflection", "reflection:delivery"]);
    expect(issues[0].labels).not.toContain("validated");
  });

  it("validates the result schema", () => {
    expect(validate("reflection-result", { summary: "s" }).ok).toBe(false);
    expect(validate("reflection-result", result([item("A", { kind: "nope" })])).ok).toBe(false);
    expect(validate("reflection-result", result([item("A")])).ok).toBe(true);
  });
});

describe("reflection input (AC-15)", () => {
  it("builds the period, open questions, issue timelines, design tree and charter clauses", async () => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "reflect-")));
    await ensureStateDirs(paths);
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    const put = (rel: string, text: string) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
    put("docs/charter.md", "# Charter\n\nStatus: adopted.\n\nFirst clause.\n\nSecond clause.\n");
    put("docs/product-spec.md", "# Product\n\nParent: docs/charter.md\n\n## Children\n\n- docs/designs/a.md\n- docs/designs/missing.md\n");
    put("docs/designs/a.md", "# A\n\nParent: docs/product-spec.md\n");
    put("specs/001-x/spec.md", "# 1. X\n\nStatus: approved\nParent: docs/product-spec.md\n");
    expect(charterClauses(readFileSync(join(repo, "docs/charter.md"), "utf8")).map((c) => c.n)).toEqual([1, 2, 3]);
    const params = new ParameterStore(paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), { slots: 1 }, registry));
    const now = new Date("2026-10-28T00:00:00Z");
    await initializeAgents(paths, registry, params, new Date("2026-10-01T00:00:00Z"));
    const t = "2026-10-20T10:00:00.000Z";
    await recordEvent(paths, { kind: "merge", at: t, issue: 7, payload: { issue: 7, pr: 70, cls: "debt", at: t } });
    await recordEvent(paths, { kind: "issue.eligible", at: t, issue: 7, payload: { rank: 1, work: "system", cls: "debt", validated_at: null, created_at: t } });
    await recordEvent(paths, { kind: "question", at: t, issue: 8, payload: { issue: 8, at: t, event: "sent", asking_stage: "plan", question_comment_id: 5 } });
    await recordEvent(paths, { kind: "maintainer.contact", at: t, issue: 8, payload: { channel: "github", kind: "question", issue: 8, question_comment_id: 5, label: "needs-decision", text: "Which way?" } });
    const gh = {
      issueState: async (n: number) => ({ number: n, state: "open", labels: [], title: "", body: "", author: "", created_at: "", closed_at: null }),
      listOpenIssuesByAuthor: async () => [{ number: 3, title: "Bot issue", labels: ["class:bug"], createdAt: "2026-10-18T00:00:00Z" }],
      listIssuesRaw: async () => [{ number: 7, title: "", body: "Spec: specs/001-x/spec.md", author: "", labels: [], state: "closed", created_at: "", closed_at: null }],
    };
    const common = { paths, gh: gh as never, botLogin: "bot", parameters: params, registry, agentsDir, repoDir: repo, now: () => now };
    const state = (await readAgentState(paths, "delivery-reflection"))!;
    const input = await buildReflectionInput(common, registry["delivery-reflection"], state) as Record<string, any>;
    expect(validate("reflection-input", input).ok).toBe(true);
    expect(input.period).toEqual({ from: "2026-09-30T00:00:00.000Z", to: now.toISOString() });
    expect(input.issues).toHaveLength(1);
    expect(input.issues[0]).toMatchObject({ issue: 7, eligible: [t], merged: [{ at: t, pr: 70 }] });
    expect(input.open_questions).toEqual([{ issue: 8, asking_stage: "plan", question_comment_id: 5, sent_at: t, question: "Which way?" }]);
    expect(input.open_bot_issues).toEqual([{ number: 3, title: "Bot issue", labels: ["class:bug"], age_days: 10 }]);
    expect(input.design_tree.designs.find((d: any) => d.path === "docs/product-spec.md").children).toEqual([{ path: "docs/designs/a.md", exists: true }, { path: "docs/designs/missing.md", exists: false }]);
    expect(input.design_tree.specs).toEqual([{ path: "specs/001-x/spec.md", status: "approved", issues: [7], implemented: true }]);
    expect(input.metrics.metrics.length).toBeGreaterThan(0);
    expect(input.events_summary.by_kind.merge).toBe(1);
    const meta = await buildReflectionInput(common, registry["meta-reflection"], (await readAgentState(paths, "meta-reflection"))!) as Record<string, any>;
    expect(meta.metric_definitions.map((m: any) => m.name)).toContain("issue_to_merge_days");
    expect(meta.snapshots.length).toBeGreaterThan(0); // the delivery run's snapshot was recorded
    expect(meta.question_outcomes).toEqual([{ month: "2026-10", sent: 1, answered: 0, decide_yourself: 0, median_hours_to_answer: null }]);
    expect(resolve(agentsDir)).toBeTruthy();
  });
});
