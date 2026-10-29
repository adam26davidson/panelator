import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyAction, type ActionContext } from "../actions/index.ts";
import { createIssueRecorded } from "../events/filed.ts";
import { record } from "../events/store.ts";
import type { GitHubClient } from "../github/client.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";
import { validate } from "../schema/validate.ts";

export interface PlanItem { title: string; body: string; class: string; kind: string; existing_issue?: number }
export interface ReflectionResult {
  summary: string;
  actions?: { kind: string; args: Record<string, unknown>; why: string }[];
  findings?: unknown[];
  plan: {
    title: string; summary: string; observations: { what: string; evidence: string }[]; items: PlanItem[];
    metrics_note: string; open_questions_note: string; deferred: { title: string; why: string }[];
  };
}
export interface PlanInput {
  open_questions: { issue: number | null; asking_stage: string; sent_at: string; question: string }[];
}
export interface ApplyDeps {
  paths: StatePaths;
  /** The only GitHub operations a reflection's apply may call (spec 012 AC-18). */
  gh: Pick<GitHubClient, "searchOpenIssuesByMarker" | "createIssue" | "comment" | "closeIssue" | "ensureLabels" | "setIssueBody" | "listComments">;
  botLogin: string;
  classes: string[];
  maxIssues: number;
  now: () => Date;
  actionCtx: ActionContext;
}

const MARK = "<!-- panelator-reflection:";
export const planMarker = (key: string) => `${MARK}${key}:plan -->`;
export const itemMarker = (key: string, i: number) => `${MARK}${key}:${i} -->`;
const short = (agent: string) => agent.replace(/-reflection$/, "");
const TITLE = (agent: string) => short(agent).replace(/^./, (c) => c.toUpperCase());
const MIN_BODY = 200;

/** Spec 012 AC-16 to AC-19: the plan file, the plan issue, the item issues, the predecessor's close, the direct actions. */
export async function applyReflectionResult(d: ApplyDeps, def: StandingDefinition, key: string, runId: string, result: ReflectionResult, input: PlanInput = { open_questions: [] }): Promise<{ plan_issue: number; filed: number[]; deferred: number }> {
  const v = validate("reflection-result", result);
  if (!v.ok) throw new Error(`reflection result: ${v.errors.join("; ")}`);
  const at = d.now();
  const dir = join(d.paths.reflections, def.name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${key}.json`);
  const prior = await readFile(file, "utf8").then((t) => JSON.parse(t) as { applied?: boolean; actions?: unknown[] }).catch(() => null);
  const save = async (extra: Record<string, unknown>) => { await writeFile(file + ".tmp", JSON.stringify({ run_id: key, agent: def.name, at: at.toISOString(), plan: result.plan, ...(prior?.applied ? { applied: true, actions: prior.actions } : {}), ...extra }, null, 2)); await rename(file + ".tmp", file); };
  await save({ plan_issue: 0, filed: [], deferred: [] });

  const labels = ["reflection", `reflection:${short(def.name)}`];
  await d.gh.ensureLabels(labels);
  const open = await d.gh.searchOpenIssuesByMarker(MARK);
  const mine = (marker: string) => open.find((i) => i.author === d.botLogin && i.body.includes(marker));
  const date = at.toISOString().slice(0, 10);
  const header = `${result.plan.summary}\n\n${planMarker(key)}`;
  let planIssue = mine(planMarker(key))?.number;
  planIssue ??= await createIssueRecorded(d.paths, d.gh, at, { title: `${TITLE(def.name)} plan ${date}`, body: header, labels, by: d.botLogin, class: "reflection", marker: planMarker(key) });

  const filed: { index: number; title: string; kind: string; issue: number; existing?: boolean; charter?: boolean }[] = [];
  const deferred = result.plan.deferred.map((x) => ({ ...x }));
  let created = 0;
  for (const [index, item] of result.plan.items.entries()) {
    const marker = itemMarker(key, index);
    const defer = (why: string) => deferred.push({ title: item.title, why });
    if (item.existing_issue !== undefined) {
      const comments = await d.gh.listComments(item.existing_issue);
      if (!comments.some((c) => c.body.includes(marker))) await d.gh.comment(item.existing_issue, `${TITLE(def.name)} plan #${planIssue} points here: ${item.title}\n\n${marker}`);
      filed.push({ index, title: item.title, kind: item.kind, issue: item.existing_issue, existing: true });
      continue;
    }
    if (!d.classes.includes(item.class)) { defer(`class ${item.class} is not a class label`); continue; }
    if (item.body.length < MIN_BODY) { defer(`body is under ${MIN_BODY} characters`); continue; }
    if (item.kind === "metric_change" && !/^##\s+Rationale\b/m.test(item.body)) { defer("a metric_change needs a ## Rationale section"); continue; }
    const existing = mine(marker);
    if (created >= d.maxIssues) { defer("over the plan bound"); continue; }
    const body = item.body.replace(/^[ \t]*Spec:.*$/gm, "").trim(); // an item cannot smuggle a Spec line: the chain starts at the spec stage
    const charter = /docs\/charter\.md/.test(`${item.title}\n${item.body}`);
    const number = existing?.number ?? await createIssueRecorded(d.paths, d.gh, at, {
      title: item.title, body: `Plan: #${planIssue}\nKind: ${item.kind}\n\n${body}\n\n${marker}`, labels: [item.class, "validated"], by: d.botLogin, class: item.class, marker,
    });
    created++;
    filed.push({ index, title: item.title, kind: item.kind, issue: number, charter });
  }
  await save({ plan_issue: planIssue, filed, deferred });

  // The previous plan of this agent closes once the new one stands, so one plan per agent is open.
  for (const old of open.filter((i) => i.author === d.botLogin && i.labels.includes(labels[1]!) && i.number !== planIssue)) {
    await d.gh.closeIssue(old.number, `Superseded by #${planIssue}.`);
  }

  const applied: string[] = [];
  if (!prior?.applied) {
    for (const a of result.actions ?? []) {
      const row = await applyAction(d.actionCtx, { ...a, agent: def.name, run_id: runId }, def.actions);
      applied.push(`${a.kind} ${JSON.stringify(a.args)}: ${row.status}${row.reason ? ` (${row.reason})` : ""}`);
    }
    await appendFindings(d.paths, { issue: 0, stage: def.name, run_id: runId, timestamp: at.toISOString() }, result.findings ?? []);
    await save({ plan_issue: planIssue, filed, deferred, applied: true, actions: applied });
  }
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "None.");
  const body = [
    result.plan.summary, "",
    "## Observations", list(result.plan.observations.map((o) => `${o.what} (${o.evidence})`)), "",
    "## Metrics", result.plan.metrics_note || "None.", "",
    "## Open questions", list(input.open_questions.map((q) => `#${q.issue} (${q.asking_stage}, sent ${q.sent_at}): ${q.question}`)), "", result.plan.open_questions_note, "",
    "## Items", filed.length || deferred.length ? "" : "This plan has no items.",
    list(filed.map((f) => `#${f.issue} ${f.title} (${f.kind}${f.existing ? ", existing issue" : ""})${f.charter ? " — charter change: needs the maintainer" : ""}`)), "",
    "## Direct actions applied", list(prior?.applied ? ((prior.actions as string[]) ?? []) : applied), "",
    "## Deferred", list(deferred.map((x) => `${x.title}: ${x.why}`)), "",
    planMarker(key),
  ].join("\n");
  await d.gh.setIssueBody(planIssue, body);
  await record(d.paths, "reflection.plan", at, { run_id: key, agent: def.name, plan_issue: planIssue, plan: result.plan, filed: filed.map((f) => f.issue), deferred }, { agent: def.name, run_id: runId });
  return { plan_issue: planIssue, filed: filed.map((f) => f.issue), deferred: deferred.length };
}
