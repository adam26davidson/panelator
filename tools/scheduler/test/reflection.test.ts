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
