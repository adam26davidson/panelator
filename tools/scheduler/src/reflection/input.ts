import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CLAIM_LABEL } from "../chain/machine.ts";
import { openIndex } from "../events/index.ts";
import { designTreeReport } from "../gates/index.ts";
import type { GitHubClient } from "../github/client.ts";
import { computeMetrics, recordSnapshot, weekStart } from "../metrics/compute.ts";
import type { MetricDefinition } from "../metrics/definitions.ts";
import type { ParameterStore } from "../parameters/store.ts";
import { parseSpec } from "../spec/parse.ts";
import { listAgentStates } from "../standing/state.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";
import { readJsonLines, settledCursor, type TriageEntry } from "../filer/input.ts";

const DAY = 86_400_000;
export const FIRST_RUN_DAYS = 28;
const HISTORY_WEEKS = 12;
const HISTORY_DAYS = 183;
const CHARTER = "docs/charter.md";

export interface ReflectionDeps {
  paths: StatePaths;
  gh: Pick<GitHubClient, "listIssues" | "issue">;
  botLogin: string;
  parameters: ParameterStore;
  metrics: Record<string, MetricDefinition>;
  agentsDir: string;
  /** The names of the agents whose output is a reflection result: their plans are `previous_plans`. */
  reflectionAgents: string[];
  now: () => Date;
}

interface Row { id: string; at: string; kind: string; issue: number | null; run_id: string | null; agent: string | null; payload: any }
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Row[] =>
  (db.prepare(sql).all(...args) as unknown as (Omit<Row, "payload"> & { payload: string })[]).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : {} }));

/** The start of the period: the agent's last successful run, or 28 days back on the first run. */
export function periodStart(lastSuccess: string | null, now: Date): Date {
  return lastSuccess ? new Date(lastSuccess) : new Date(now.getTime() - FIRST_RUN_DAYS * DAY);
}

interface PlanEvent { at: string; agent: string; plan: { title: string }; plan_key: string; plan_issue: number; filed: number[]; deferred?: { title: string; why: string }[] }
const planEvents = (db: DatabaseSync, since?: string): PlanEvent[] =>
  rows(db, "SELECT * FROM events WHERE kind = 'reflection.plan' AND at >= ? ORDER BY at", since ?? "").map((e) => ({ ...e.payload, at: e.at, agent: e.agent ?? "" }));

/** Where an issue a plan filed stands: from GitHub (state, labels) and the merge events. */
export async function fate(d: Pick<ReflectionDeps, "gh">, db: DatabaseSync, issue: number): Promise<Record<string, unknown>> {
  const merge = rows(db, "SELECT * FROM events WHERE kind = 'merge' AND issue = ? ORDER BY at LIMIT 1", issue)[0];
  const abandoned = rows(db, "SELECT 1 AS x, * FROM events WHERE kind = 'issue.released' AND issue = ? AND json_extract(payload, '$.reason') = 'abandoned' LIMIT 1", issue).length > 0;
  const s = await d.gh.issue(issue);
  if (merge) return { issue, state: "merged", pr: merge.payload.pr };
  if (abandoned || s?.labels.includes("abandoned")) return { issue, state: "abandoned" };
  if (s?.state === "closed") return { issue, state: s.pullRequests.length ? "merged" : "closed", ...(s.pullRequests.length ? { pr: s.pullRequests[0] } : {}) };
  return { issue, state: s?.labels.includes(CLAIM_LABEL) ? "in progress" : "open" };
}
async function planWithFates(d: Pick<ReflectionDeps, "gh">, db: DatabaseSync, p: PlanEvent) {
  const filed = [];
  for (const n of p.filed) filed.push(await fate(d, db, n));
  return { agent: p.agent, plan_key: p.plan_key, at: p.at, plan_issue: p.plan_issue, title: p.plan.title, filed, deferred: p.deferred ?? [] };
}

/** One issue's timeline from its events (AC-5 `issues`). */
export function timeline(db: DatabaseSync, issue: number) {
  const ev = rows(db, "SELECT * FROM events WHERE issue = ? ORDER BY at, rowid", issue);
  const of = (k: string) => ev.filter((e) => e.kind === k);
  const runs = of("run.ended").map((e) => ({ run_id: e.run_id, stage: e.payload.stage, model: e.payload.model, outcome: e.payload.outcome, cost_usd: e.payload.cost_usd ?? 0 }));
  return {
    issue,
    eligible_at: of("issue.eligible")[0]?.at ?? null,
    claimed_at: of("issue.claimed").map((e) => e.at),
    released: of("issue.released").map((e) => ({ at: e.at, reason: e.payload.reason })),
    transitions: of("chain.transition").map((e) => ({ at: e.at, from: e.payload.from, to: e.payload.to, event: e.payload.event })),
    runs,
    reviews: of("review.result").map((e) => ({ at: e.at, verdict: e.payload.verdict, findings: e.payload.findings, security: e.payload.security })),
    questions: of("question").map((e) => ({ at: e.at, event: e.payload.event, stage: e.payload.asking_stage })),
    pauses: ev.filter((e) => e.kind === "pause.started" || e.kind === "pause.ended").map((e) => ({ at: e.at, kind: e.kind, stage: e.payload.stage })),
    total_cost_usd: runs.reduce((s, r) => s + r.cost_usd, 0),
  };
}

/** Questions sent and not answered since (design section 3): the answer is the next `answered` event of the same issue and stage. */
export function openQuestions(db: DatabaseSync) {
  const q = rows(db, "SELECT * FROM events WHERE kind = 'question' ORDER BY at, rowid");
  const contacts = rows(db, "SELECT * FROM events WHERE kind = 'maintainer.contact' AND json_extract(payload, '$.kind') = 'question'");
  return q
    .filter((e) => e.payload.event === "sent")
    .filter((e) => !q.some((a) => a.payload.event === "answered" && a.issue === e.issue && a.payload.asking_stage === e.payload.asking_stage && a.at >= e.at))
    .map((e) => ({
      issue: e.issue, stage: String(e.payload.asking_stage), sent_at: e.at,
      question: String(contacts.find((c) => c.issue === e.issue && c.payload.question_comment_id === e.payload.question_comment_id)?.payload.text
        || q.filter((a) => a.issue === e.issue && a.payload.event === "asked" && a.at <= e.at).at(-1)?.payload.question?.question || ""),
    }));
}

export function groupContacts(db: DatabaseSync, from: string, to: string) {
  const groups = new Map<string, { kind: string; label: string; count: number; first: string; last: string; examples: string[]; recurring: boolean }>();
  for (const e of rows(db, "SELECT * FROM events WHERE kind = 'maintainer.contact' AND at >= ? AND at < ? ORDER BY at", from, to)) {
    const key = `${e.payload.kind}\u0000${e.payload.label}`;
    const g = groups.get(key) ?? { kind: String(e.payload.kind), label: String(e.payload.label), count: 0, first: e.at, last: e.at, examples: [] as string[], recurring: false };
    g.count++; g.last = e.at;
    if (g.examples.length < 3 && e.payload.text) g.examples.push(String(e.payload.text));
    g.recurring = g.count >= 2;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Per month: questions sent, answered, decided by the agent, and the median hours from sent to answered. */
export function questionOutcomes(db: DatabaseSync, since: string) {
  const months = new Map<string, { month: string; sent: number; answered: number; decide_yourself: number; hours: number[] }>();
  const m = (at: string) => { const k = at.slice(0, 7); const v = months.get(k) ?? { month: k, sent: 0, answered: 0, decide_yourself: 0, hours: [] }; months.set(k, v); return v; };
  const sentAt = new Map<string, string>();
  for (const e of rows(db, "SELECT * FROM events WHERE kind = 'question' AND at >= ? ORDER BY at, rowid", since)) {
    const key = `${e.issue}:${e.payload.asking_stage}`;
    if (e.payload.event === "sent") { m(e.at).sent++; sentAt.set(key, e.at); }
    else if (e.payload.event === "checked" && e.payload.verdict === "decide_yourself") m(e.at).decide_yourself++;
    else if (e.payload.event === "answered") {
      const s = sentAt.get(key);
      const v = m(s ?? e.at); v.answered++;
      if (s) { v.hours.push((Date.parse(e.at) - Date.parse(s)) / 3_600_000); sentAt.delete(key); }
    }
  }
  return [...months.values()].map(({ hours, ...v }) => {
    const h = [...hours].sort((a, b) => a - b);
    return { ...v, median_hours_to_answer: h.length ? (h[Math.floor((h.length - 1) / 2)]! + h[Math.floor(h.length / 2)]!) / 2 : null };
  });
}

/** The squash commit that added `path` ends with `(#<pr>)`; the oldest one names the spec's PR. */
function addedByPr(repo: string, path: string): number | null {
  try {
    const subjects = execFileSync("git", ["log", "--diff-filter=A", "--format=%s", "--", path], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
    const m = /\(#(\d+)\)\s*$/.exec(subjects.at(-1) ?? "");
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function designTree(root: string, db: DatabaseSync, issues: Awaited<ReturnType<GitHubClient["listIssues"]>>, botLogin: string) {
  const designs = [...designTreeReport(root, { issues, botLogin })].map(([path, entries]) => ({
    path,
    children: entries.map((e) => e.kind === "file"
      ? { kind: "file" as const, path: e.path!, exists: e.exists ?? false }
      : { kind: "planned" as const, slug: e.slug!, title: e.title ?? e.slug!, issue: e.recordedIssue ?? null, done: e.done ?? false, dead: e.dead ?? false }),
  }));
  const merges = rows(db, "SELECT * FROM events WHERE kind = 'merge'");
  const specs: { path: string; status: string | null; issue: number | null; implemented: boolean | null }[] = [];
  const dir = join(root, "specs");
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = `specs/${name}/spec.md`;
    if (!existsSync(join(root, path))) continue;
    const pr = addedByPr(root, path);
    const issue: number | null = merges.find((m) => pr !== null && m.payload.pr === pr)?.issue ?? null;
    // Implemented: a merge for the issue other than the PR that added the spec.
    const implemented = issue === null ? null : merges.some((m) => m.issue === issue && m.payload.pr !== pr);
    specs.push({ path, status: parseSpec(readFileSync(join(root, path), "utf8")).status ?? null, issue, implemented });
  }
  return { designs, specs };
}

/**
 * The reflection input of spec 028 AC-5, for the period from `from` to now. Records the run's `metrics.snapshot`.
 * `root` is the repository the agent reads (its fresh worktree).
 */
export async function buildReflectionInput(d: ReflectionDeps, def: StandingDefinition, runId: string, from: Date, root: string) {
  const now = d.now();
  const db = openIndex(d.paths, { readOnly: true });
  try {
    const f = from.toISOString(), t = now.toISOString();
    const metrics = computeMetrics(db, d.metrics, { from: new Date(from.getTime() - HISTORY_WEEKS * 7 * DAY), to: now, today: now });
    await recordSnapshot(d.paths, metrics, { agent: def.name, run_id: runId });
    const byKind: Record<string, number> = {}, byWeek: Record<string, Record<string, number>> = {};
    for (const r of db.prepare("SELECT kind, at FROM events WHERE at >= ? AND at < ?").all(f, t) as { kind: string; at: string }[]) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
      const week = (byWeek[weekStart(Date.parse(r.at))] ??= {});
      week[r.kind] = (week[r.kind] ?? 0) + 1;
    }
    // Complete and in issue order: no LIMIT and no cap, so a period grown after failed runs drops nothing (AC-5).
    const numbers = (db.prepare(`SELECT DISTINCT issue FROM events WHERE issue IS NOT NULL AND issue > 0 AND at >= ? AND at < ? AND (kind = 'merge' OR kind = 'pause.started' OR (kind = 'issue.released' AND json_extract(payload, '$.reason') = 'abandoned')) ORDER BY issue`).all(f, t) as { issue: number }[]).map((r) => r.issue);
    const agents: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(await listAgentStates(d.paths))) agents[name] = { last_run: s.last_run, next_run: s.next_run, paused: s.paused, failures: s.failures };
    const plans = planEvents(db);
    const previous: unknown[] = [];
    for (const a of d.reflectionAgents) { const last = plans.filter((p) => p.agent === a).at(-1); if (last) previous.push(await planWithFates(d, db, last)); }
    const triage = await readJsonLines<TriageEntry>(d.paths.findingsTriage);
    const queue = (await readJsonLines<unknown>(d.paths.findingsQueue)).length;
    let cursor = 0;
    try { cursor = JSON.parse(readFileSync(d.paths.findingsCursor, "utf8")).line ?? 0; } catch { /* none yet */ }
    const outcomes: Record<string, number> = {};
    for (const r of rows(db, "SELECT * FROM events WHERE kind = 'finding.triaged' AND at >= ? AND at < ?", f, t)) outcomes[r.payload.outcome] = (outcomes[r.payload.outcome] ?? 0) + 1;
    const issues = await d.gh.listIssues({ state: "all", labelEvents: false });
    const input: Record<string, unknown> & { metrics: typeof metrics } = {
      period: { from: f, to: t }, agent: def.name, parameters: await d.parameters.all(), agents, metrics,
      events_summary: { by_kind: byKind, by_week: byWeek },
      issues: numbers.map((n) => timeline(db, n)),
      open_questions: openQuestions(db),
      previous_plans: previous,
      open_bot_issues: issues.filter((i) => i.state === "open" && i.author === d.botLogin).map((i) => ({ number: i.number, title: i.title, labels: i.labels, age_days: Math.floor((now.getTime() - Date.parse(i.createdAt)) / DAY) })),
      findings_pending: { queued: Math.max(0, queue - settledCursor(cursor, triage)), triage_by_outcome: outcomes },
    };
    if (def.name === "delivery-reflection") input.design_tree = designTree(root, db, issues, d.botLogin);
    if (def.name === "charter-reflection") {
      const text = existsSync(join(root, CHARTER)) ? readFileSync(join(root, CHARTER), "utf8") : "";
      input.charter = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p, i) => ({ n: i + 1, text: p }));
      input.console_available = false;
      input.maintainer_contacts = groupContacts(db, f, t);
    }
    if (def.name === "meta-reflection") {
      const since = new Date(now.getTime() - HISTORY_DAYS * DAY).toISOString();
      const dir = join(d.agentsDir, "metrics");
      input.metric_definitions = (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort() : []).map((n) => ({ file: `agents/metrics/${n}`, text: readFileSync(join(dir, n), "utf8") }));
      input.snapshots = rows(db, "SELECT * FROM events WHERE kind = 'metrics.snapshot' AND at >= ? ORDER BY at", since).map((e) => ({ at: e.at, agent: e.agent, report: e.payload }));
      input.all_plans = [];
      for (const p of planEvents(db, since)) (input.all_plans as unknown[]).push(await planWithFates(d, db, p));
      input.question_outcomes = questionOutcomes(db, since);
    }
    return input;
  } finally {
    db.close();
  }
}
