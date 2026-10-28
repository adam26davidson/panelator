import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry } from "../actions/log.ts";
import { recordIssueFiled } from "../events/filed.ts";
import { recordEvent } from "../events/store.ts";
import type { GitHubClient } from "../github/client.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";
import type { StoredPlan } from "./input.ts";

export interface PlanItem {
  title: string;
  body: string;
  class: string;
  kind: "bottleneck" | "charter" | "automate_contact" | "metric_change" | "agent_change" | "other";
  existing_issue?: number;
}
export interface ReflectionPlan {
  title: string;
  summary: string;
  observations: { what: string; evidence: string }[];
  items: PlanItem[];
  metrics_note: string;
  open_questions_note: string;
  deferred: { title: string; why: string }[];
}
export interface ReflectionResult {
  summary: string;
  plan: ReflectionPlan;
  actions?: unknown[];
  findings?: unknown[];
}

/** The GitHub operations this module may call (AC-18); a test pins the list. */
export type ReflectionGitHub = Pick<GitHubClient, "createIssue" | "comment" | "closeIssue" | "setIssueBody" | "listIssuesRaw" | "ensureLabel" | "listComments">;

export interface ReflectionApplyDeps {
  paths: StatePaths;
  gh: ReflectionGitHub;
  botLogin: string;
  now: () => Date;
  /** The class labels of agents/scheduler.yaml. */
  classes: string[];
  maxIssues: number;
}

export const PLAN_LABEL = "reflection";
const LABEL_COLOR = "5319e7";
const BODY_MIN = 200;
export const planMarker = (key: string) => `<!-- panelator-reflection:${key}:plan -->`;
export const itemMarker = (key: string, index: number) => `<!-- panelator-reflection:${key}:${index} -->`;

/** `delivery-reflection` is reflection:delivery. */
export const shortName = (agent: string) => agent.replace(/-reflection$/, "");
const display = (agent: string) => { const s = agent.replace(/-/g, " "); return s[0].toUpperCase() + s.slice(1); };

async function writeAtomic(path: string, text: string): Promise<void> {
  await writeFile(path + ".tmp", text);
  await rename(path + ".tmp", path);
}

/** Why an item cannot be filed as it is, or null. */
function problem(item: PlanItem, classes: string[]): string | null {
  if (!classes.includes(item.class)) return `class ${item.class} is not a class label`;
  if (item.body.length < BODY_MIN) return `body is under ${BODY_MIN} characters`;
  if (item.kind === "metric_change" && !/^##\s+Rationale\b/m.test(item.body)) return "metric_change without a ## Rationale section";
  return null;
}

const touchesCharter = (i: PlanItem) => /docs\/charter\.md/.test(`${i.title}\n${i.body}`);

function planBody(key: string, number: number | null, plan: ReflectionPlan, deferred: { title: string; why: string }[], filed: Map<number, number>, actions: LogEntry[], open: { issue?: number; text: string }[]): string {
  const lines: string[] = [plan.summary, "", "## Observations"];
  lines.push(...(plan.observations.length ? plan.observations.map((o) => `- ${o.what} (evidence: ${o.evidence})`) : ["- none"]));
  lines.push("", "## Metrics", plan.metrics_note || "none", "", "## Open questions for the maintainer", plan.open_questions_note || "none");
  lines.push(...open.map((q) => `- #${q.issue ?? "?"}: ${q.text}`));
  lines.push("", "## Items");
  if (!plan.items.length) lines.push("This plan has no items.");
  plan.items.forEach((item, i) => {
    const n = item.existing_issue ?? filed.get(i);
    const link = n ? `#${n}${item.existing_issue ? " (existing issue, linked here)" : ""}` : "not filed";
    const mark = touchesCharter(item) ? " — charter change: needs the maintainer" : "";
    lines.push(`- [${item.kind}] ${item.title}: ${link}${mark}`);
  });
  lines.push("", "## Direct actions applied in this run");
  lines.push(...(actions.length ? actions.map((a) => `- ${a.kind} ${JSON.stringify(a.args)}: ${a.status}${a.reason ? ` (${a.reason})` : ""} — ${a.why}`) : ["- none"]));
  lines.push("", "## Deferred");
  lines.push(...(deferred.length ? deferred.map((d) => `- ${d.title}: ${d.why}`) : ["- none"]));
  void number;
  return `${lines.join("\n")}\n\n${planMarker(key)}`;
}

/**
 * Spec 012 AC-16 to AC-19. `key` is the reflection run's stable id (the period's), so a retry after a crash finds the
 * markers it left. Writes only under the state directory and calls only the GitHub operations of `ReflectionGitHub`.
 * `actions` are the direct actions already applied for this run; they go into the plan.
 */
export async function applyReflectionResult(
  d: ReflectionApplyDeps, def: StandingDefinition, runId: string, key: string, result: ReflectionResult, actions: LogEntry[] = [], openQuestions: { issue?: number; text: string }[] = [],
): Promise<{ plan_issue: number; filed: { index: number; number: number; title: string }[]; deferred: { title: string; why: string }[] }> {
  const valid = validate("reflection-result", result);
  if (!valid.ok) throw new Error(`reflection result: ${valid.errors.join("; ")}`);
  const plan = result.plan;
  const short = shortName(def.name);
  const at = d.now().toISOString();
  const file = join(d.paths.reflections, def.name, `${runId}.json`);
  await mkdir(join(d.paths.reflections, def.name), { recursive: true });
  const stored: StoredPlan & { result: ReflectionResult } = { agent: def.name, run_id: runId, plan_key: key, at, plan_issue: 0, plan: { ...plan, items: plan.items, deferred: [] }, filed: [], result };

  // 1. the plan, as a record in the state directory.
  await writeAtomic(file, JSON.stringify(stored, null, 2));

  // Decide each item before anything is filed: what is filed, what is deferred, and why.
  const deferred = [...plan.deferred];
  const toFile: number[] = [];
  plan.items.forEach((item, i) => {
    if (item.existing_issue !== undefined) return;
    const why = problem(item, d.classes);
    if (why) deferred.push({ title: item.title, why });
    else if (toFile.length >= d.maxIssues) deferred.push({ title: item.title, why: "over the plan bound" });
    else toFile.push(i);
  });

  for (const l of [PLAN_LABEL, `${PLAN_LABEL}:${short}`]) await d.gh.ensureLabel(l, LABEL_COLOR);

  // 2. the plan issue, found by its marker before one is created.
  const known = await d.gh.listIssuesRaw({ state: "all", labels: PLAN_LABEL });
  const existingPlan = known.find((i) => i.body.includes(planMarker(key)));
  let planNumber: number;
  const filedByIndex = new Map<number, number>();
  const render = () => planBody(key, planNumber, plan, deferred, filedByIndex, actions, openQuestions);
  const title = `${display(def.name)} plan ${at.slice(0, 10)}`;
  if (existingPlan) planNumber = existingPlan.number;
  else {
    const labels = [PLAN_LABEL, `${PLAN_LABEL}:${short}`];
    planNumber = await d.gh.createIssue(title, `${plan.summary}\n\nItems are being filed.\n\n${planMarker(key)}`, labels);
    await recordIssueFiled(d.paths, { number: planNumber, by: d.botLogin, cls: PLAN_LABEL, labels, marker: planMarker(key), body: plan.summary, at: d.now() });
  }

  // 3. the items: each found by its marker before it is created.
  const validated = await d.gh.listIssuesRaw({ state: "all", labels: "validated" });
  for (const [i, item] of plan.items.entries()) {
    const marker = itemMarker(key, i);
    if (item.existing_issue !== undefined) {
      const comments = await d.gh.listComments(item.existing_issue);
      if (!comments.some((c) => c.body.includes(marker))) await d.gh.comment(item.existing_issue, `Raised again by the plan #${planNumber} (${item.kind}): ${item.title}\n\n${marker}`);
      continue;
    }
    if (!toFile.includes(i)) continue;
    const found = validated.find((v) => v.body.includes(marker));
    if (found) { filedByIndex.set(i, found.number); continue; }
    const labels = [item.class, "validated"];
    const body = `Plan: #${planNumber}\n\nKind: ${item.kind}\n\n${item.body}\n\n${marker}`;
    const number = await d.gh.createIssue(item.title, body, labels);
    filedByIndex.set(i, number);
    await recordIssueFiled(d.paths, { number, by: d.botLogin, cls: item.class, labels, marker, body, at: d.now() });
  }
  await d.gh.setIssueBody(planNumber, render());

  // 4. one plan per agent is open at a time.
  for (const old of await d.gh.listIssuesRaw({ state: "open", labels: `${PLAN_LABEL}:${short}` })) {
    if (old.number !== planNumber) await d.gh.closeIssue(old.number, `Superseded by the new plan #${planNumber}.`);
  }

  // 5. the record, with the final list of what was filed and deferred.
  const filed = [...filedByIndex].map(([index, number]) => ({ index, number, title: plan.items[index].title }));
  stored.plan_issue = planNumber;
  stored.filed = filed;
  stored.plan.deferred = deferred;
  await writeAtomic(file, JSON.stringify(stored, null, 2));
  await recordEvent(d.paths, { kind: "reflection.plan", at, agent: def.name, run_id: runId, payload: { agent: def.name, run_id: runId, plan_issue: planNumber, plan: { ...plan, deferred, filed } } });
  return { plan_issue: planNumber, filed, deferred };
}
