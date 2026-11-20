import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openIndex } from "../events/index.ts";
import { createIssueRecorded } from "../events/filed.ts";
import { record } from "../events/store.ts";
import type { GitHubClient } from "../github/client.ts";
import { neutraliseMarkers } from "../github/markers.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";

export interface PlanItem { title: string; body: string; class: string; kind: string; existing_issue?: number }
export interface ReflectionPlan {
  title: string; summary: string; observations: { what: string; evidence: string }[]; items: PlanItem[];
  metrics_note: string; open_questions_note: string; deferred: { title: string; why: string }[];
}
export interface ReflectionResult { summary: string; actions?: { kind: string; args: Record<string, unknown>; why: string }[]; findings?: unknown[]; plan: ReflectionPlan }
export interface PlanInput { open_questions: { issue: number | null; stage: string; sent_at: string; question: string }[] }

/** The only GitHub operations a reflection's apply may call (spec 028 AC-8). */
export type ApplyGitHub = Pick<GitHubClient, "createIssue" | "comment" | "listComments" | "closeIssue" | "setIssueBody" | "searchOpenIssuesByMarker" | "issue">;
export interface ApplyDeps {
  paths: StatePaths;
  gh: ApplyGitHub;
  botLogin: string;
  /** The class labels of `agents/scheduler.yaml`. */
  classes: string[];
  /** `reflection_max_issues`. */
  maxIssues: number;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
  /**
   * Applies the result's `actions` and `findings` as spec 008 AC-5 does and returns one line per action for the plan.
   * Called at most once per plan key: a retry reads the lines back from the plan file.
   */
  applyDirect: () => Promise<string[]>;
}
export interface ApplyOutcome { planIssue: number; filed: number[]; deferred: { title: string; why: string }[] }

const PREFIX = "<!-- panelator-reflection:";
export const planMarker = (key: string) => `${PREFIX}${key}:plan -->`;
export const itemMarker = (key: string, i: number) => `${PREFIX}${key}:${i} -->`;
export const commentMarker = (key: string, i: number) => `${PREFIX}${key}:comment:${i} -->`;
const short = (agent: string) => agent.replace(/-reflection$/, "");
const MIN_BODY = 200;
const n = neutraliseMarkers;

interface Linked { index: number; title: string; kind: string; issue: number; existing: boolean; charter: boolean }

/** Spec 028 AC-6 to AC-9: the plan file, the plan issue and its rewrite, the item issues, the predecessor's close, `reflection.plan`. */
export async function applyReflectionResult(d: ApplyDeps, a: { def: StandingDefinition; result: ReflectionResult; planKey: string; runId: string; input: PlanInput }): Promise<ApplyOutcome> {
  const { def, result, planKey, runId, input } = a;
  const plan = result.plan;
  const at = d.now();

  // 1. The plan file; what an earlier attempt applied directly is kept.
  const dir = join(d.paths.reflections, def.name);
  const file = join(dir, `${planKey}.json`);
  await mkdir(dir, { recursive: true });
  const prior = await readFile(file, "utf8").then((t) => JSON.parse(t) as { applied?: string[] }).catch(() => null);
  const save = async (extra: Record<string, unknown>) => { await writeFile(`${file}.tmp`, JSON.stringify({ plan_key: planKey, agent: def.name, at: at.toISOString(), plan, ...extra }, null, 2)); await rename(`${file}.tmp`, file); };
  await save(prior?.applied ? { applied: prior.applied } : {});

  // 2. The plan issue: found by its marker (as the App wrote it) or created. Its body is complete only after step 4.
  const open = await d.gh.searchOpenIssuesByMarker(`${PREFIX}${planKey}:`);
  const mine = (marker: string) => open.find((i) => i.author === d.botLogin && i.body.includes(marker));
  const labels = ["reflection", `reflection:${short(def.name)}`];
  const title = `${short(def.name).replace(/^./, (c) => c.toUpperCase())} plan ${at.toISOString().slice(0, 10)}`;
  const direct = prior?.applied ?? null;
  const render = (linked: Linked[] | null, deferred: { title: string; why: string }[], actions: string[]) => {
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "None.");
    const items = linked === null
      ? plan.items.map((i) => `${n(i.title)} (${i.kind})`)
      : linked.map((l) => `#${l.issue} ${n(l.title)} (${l.kind}${l.existing ? ", existing issue" : ""})${l.charter ? " — charter change: needs the maintainer" : ""}`);
    return [
      n(plan.summary), "",
      "## Observations", list(plan.observations.map((o) => `${n(o.what)} (${n(o.evidence)})`)), "",
      "## Metrics", n(plan.metrics_note) || "None.", "",
      "## Open questions", input.open_questions.length ? input.open_questions.map((q) => `- #${q.issue} (${q.stage}, sent ${q.sent_at}): ${n(q.question)}`).join("\n") : "None.", "", n(plan.open_questions_note), "",
      "## Items", plan.items.length ? list(items) : "This plan has no items.", "",
      "## Direct actions applied", list(actions), "",
      "## Deferred", list(deferred.map((x) => `${n(x.title)}: ${n(x.why)}`)), "",
      planMarker(planKey),
    ].join("\n");
  };
  let planIssue = mine(planMarker(planKey))?.number;
  planIssue ??= await createIssueRecorded(d.gh, d.paths, { title, body: render(null, plan.deferred, direct ?? []), labels, by: d.botLogin, class: "reflection", marker: planMarker(planKey) });

  // 3. The items. The bound counts the items of this plan key that exist on GitHub, found or created.
  const linked: Linked[] = [];
  const deferred = plan.deferred.map((x) => ({ ...x }));
  const itemPrefix = `${PREFIX}${planKey}:`;
  let existing = new Set(open.filter((i) => i.author === d.botLogin && i.body.split(itemPrefix).slice(1).some((s) => /^\d+ -->/.test(s))).map((i) => i.number)).size;
  for (const [index, item] of plan.items.entries()) {
    const defer = (why: string) => deferred.push({ title: item.title, why });
    const charter = /docs\/charter\.md/.test(`${item.title}\n${item.body}`);
    if (item.existing_issue !== undefined) {
      const marker = commentMarker(planKey, index);
      const comments = await d.gh.listComments(item.existing_issue);
      if (!comments.some((c) => c.author === d.botLogin && c.body.includes(marker))) await d.gh.comment(item.existing_issue, `${n(`${title} (#${planIssue}) points here: ${item.title}`)}\n\n${marker}`);
      linked.push({ index, title: item.title, kind: item.kind, issue: item.existing_issue, existing: true, charter });
      continue;
    }
    if (!d.classes.includes(item.class)) { defer(`class ${item.class} is not a class label`); continue; }
    if (item.body.length < MIN_BODY) { defer(`body is under ${MIN_BODY} characters`); continue; }
    if (item.kind === "metric_change" && !/^##\s+Rationale\b/m.test(item.body)) { defer("a metric_change needs a ## Rationale section"); continue; }
    const marker = itemMarker(planKey, index);
    let number = mine(marker)?.number;
    if (number === undefined) {
      if (existing >= d.maxIssues) { defer("over the plan bound"); continue; }
      // The chain starts at the spec stage and the App is the author: an item cannot name a Spec: line (the filer does the same).
      const body = n(item.body.replace(/^[ \t]*Spec:.*$/gm, "").trim());
      number = await createIssueRecorded(d.gh, d.paths, { title: n(item.title), body: `Plan: #${planIssue}\nKind: ${item.kind}\n\n${body}\n\n${marker}`, labels: [item.class, "validated"], by: d.botLogin, class: item.class, marker });
      existing++;
    }
    linked.push({ index, title: item.title, kind: item.kind, issue: number, existing: false, charter });
  }

  // The direct actions and findings, once per plan key, so the body can list what this run applied (design 6.1).
  const actions = direct ?? await d.applyDirect();
  if (!direct) await save({ applied: actions });

  // 4. The body from this attempt's result, linking every item found or created.
  await d.gh.setIssueBody(planIssue, render(linked, deferred, actions));

  // 5. The previous plan of this agent: the recorded number, closed only when open and authored by the App.
  const db = openIndex(d.paths, { readOnly: true });
  let previous: number | undefined, recorded: boolean;
  try {
    previous = (db.prepare("SELECT json_extract(payload, '$.plan_issue') AS n FROM events WHERE kind = 'reflection.plan' AND agent = ? AND json_extract(payload, '$.plan_key') != ? ORDER BY at DESC, rowid DESC LIMIT 1").get(def.name, planKey) as { n: number } | undefined)?.n;
    recorded = db.prepare("SELECT 1 AS x FROM events WHERE kind = 'reflection.plan' AND json_extract(payload, '$.plan_key') = ?").get(planKey) !== undefined;
  } finally { db.close(); }
  if (previous !== undefined && previous !== planIssue) {
    const old = await d.gh.issue(previous);
    if (old && old.state === "open" && old.author === d.botLogin) await d.gh.closeIssue(previous, `Superseded by #${planIssue}.`);
    else d.log({ kind: "reflection-predecessor-kept", agent: def.name, issue: previous, reason: !old ? "not found" : old.state !== "open" ? "not open" : "not authored by the App" });
  }

  // 6. `reflection.plan`, once per plan key.
  const filed = linked.map((l) => l.issue);
  if (!recorded) await record(d.paths, "reflection.plan", at, { plan, plan_key: planKey, plan_issue: planIssue, filed, deferred }, { agent: def.name, run_id: runId });
  return { planIssue, filed, deferred };
}
