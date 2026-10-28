import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openIndex } from "../events/index.ts";
import { loadDesignTree, ROOT } from "../gates/design-tree.ts";
import type { GitHubClient } from "../github/client.ts";
import { computeMetrics } from "../metrics/compute.ts";
import type { MetricDefinition } from "../metrics/definitions.ts";
import type { ParameterStore } from "../parameters/store.ts";
import { parseChildren, parseSpec } from "../spec/parse.ts";
import { listAgentStates, type AgentState } from "../standing/state.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";
import { CLAIM_LABEL } from "../chain/machine.ts";

const DAY = 86_400_000;
export const FIRST_RUN_DAYS = 28;

export interface ReflectionDeps {
  paths: StatePaths;
  gh: Pick<GitHubClient, "listOpenIssuesByAuthor" | "issueState">;
  repoDir: string;
  botLogin: string;
  parameters: ParameterStore;
  metrics: Record<string, MetricDefinition>;
  reflectionAgents: string[];
}

interface Row { id: string; at: string; kind: string; issue: number | null; run_id: string | null; agent: string | null; payload: any }
const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]): Row[] =>
  (db.prepare(sql).all(...args) as unknown as (Omit<Row, "payload"> & { payload: string })[]).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : {} }));

export function periodStart(state: Pick<AgentState, "last_success">, now: Date): Date {
  return state.last_success ? new Date(state.last_success.at) : new Date(now.getTime() - FIRST_RUN_DAYS * DAY);
}

export interface PlanFile {
  run_id: string; agent: string; at: string; plan_issue: number;
  plan: { title: string; items: { title: string; kind: string }[] };
  filed: { index: number; title: string; kind?: string; issue: number; existing?: boolean }[];
  deferred: { title: string; why: string }[];
}
function readPlans(paths: StatePaths, agents: string[]): PlanFile[] {
  const out: PlanFile[] = [];
  for (const a of agents) {
    const dir = join(paths.reflections, a);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) out.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as PlanFile);
  }
  return out.sort((x, y) => x.at.localeCompare(y.at));
}

async function fate(d: ReflectionDeps, db: DatabaseSync, issue: number): Promise<Record<string, unknown>> {
  const merge = rows(db, "SELECT * FROM events WHERE kind = 'merge' AND issue = ? ORDER BY at LIMIT 1", issue)[0];
  const s = await d.gh.issueState(issue);
  const state = merge ? "merged" : s.labels.includes("abandoned") ? "abandoned" : s.state === "closed" ? "closed" : s.labels.includes(CLAIM_LABEL) ? "in progress" : "open";
  return { issue, state, ...(merge ? { pr: merge.payload.pr } : {}) };
}
async function planWithFates(d: ReflectionDeps, db: DatabaseSync, p: PlanFile) {
  const filed = [];
  for (const f of p.filed) filed.push({ ...f, ...(await fate(d, db, f.issue)) });
  return { agent: p.agent, run_id: p.run_id, at: p.at, plan_issue: p.plan_issue, title: p.plan.title, filed, deferred: p.deferred };
}

function timeline(db: DatabaseSync, issue: number) {
  const ev = rows(db, "SELECT * FROM events WHERE issue = ? ORDER BY at", issue);
  const of = (k: string) => ev.filter((e) => e.kind === k);
  const runs = of("run.ended").map((e) => ({ run_id: e.run_id, stage: e.payload.stage, model: e.payload.model, outcome: e.payload.outcome, cost_usd: e.payload.cost_usd }));
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
    total_cost_usd: runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  };
}

export function openQuestions(db: DatabaseSync) {
  const q = rows(db, "SELECT * FROM events WHERE kind = 'question' ORDER BY at");
  const answered = new Set(q.filter((e) => e.payload.event === "answered").map((e) => e.payload.question_comment_id));
  const contacts = rows(db, "SELECT * FROM events WHERE kind = 'maintainer.contact' AND json_extract(payload, '$.kind') = 'question'");
  return q.filter((e) => e.payload.event === "sent" && !answered.has(e.payload.question_comment_id)).map((e) => ({
    issue: e.issue, asking_stage: e.payload.asking_stage, question_comment_id: e.payload.question_comment_id ?? null, sent_at: e.at,
    question: contacts.find((c) => c.payload.question_comment_id === e.payload.question_comment_id)?.payload.text
      ?? q.filter((a) => a.issue === e.issue && a.payload.event === "asked" && a.at <= e.at).at(-1)?.payload.question?.question ?? "",
  }));
}

export function groupContacts(db: DatabaseSync, from: string, to: string) {
  const groups = new Map<string, { kind: string; label: string; count: number; first: string; last: string; examples: string[]; recurring: boolean }>();
  for (const e of rows(db, "SELECT * FROM events WHERE kind = 'maintainer.contact' AND at >= ? AND at < ? ORDER BY at", from, to)) {
    const key = `${e.payload.kind}\u0000${e.payload.label}`;
    const g = groups.get(key) ?? { kind: e.payload.kind, label: e.payload.label, count: 0, first: e.at, last: e.at, examples: [] as string[], recurring: false };
    g.count++; g.last = e.at;
    if (g.examples.length < 3) g.examples.push(String(e.payload.text));
    g.recurring = g.count >= 2;
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function questionOutcomes(db: DatabaseSync, since: string) {
  const q = rows(db, "SELECT * FROM events WHERE kind = 'question' AND at >= ? ORDER BY at", since);
  const months = new Map<string, { month: string; sent: number; answered: number; decide_yourself: number; hours: number[] }>();
  const m = (at: string) => { const k = at.slice(0, 7); const v = months.get(k) ?? { month: k, sent: 0, answered: 0, decide_yourself: 0, hours: [] }; months.set(k, v); return v; };
  const sentAt = new Map<unknown, string>();
  for (const e of q) {
    if (e.payload.event === "sent") { m(e.at).sent++; sentAt.set(e.payload.question_comment_id, e.at); }
    else if (e.payload.event === "checked" && e.payload.verdict === "decide_yourself") m(e.at).decide_yourself++;
    else if (e.payload.event === "answered") {
      const s = sentAt.get(e.payload.question_comment_id);
      const v = m(s ?? e.at); v.answered++;
      if (s) v.hours.push((Date.parse(e.at) - Date.parse(s)) / 3_600_000);
    }
  }
  return [...months.values()].map(({ hours, ...v }) => {
    const h = [...hours].sort((a, b) => a - b);
    return { ...v, median_hours_to_answer: h.length ? (h[Math.floor((h.length - 1) / 2)]! + h[Math.floor(h.length / 2)]!) / 2 : null };
  });
}

function designTree(d: ReflectionDeps, db: DatabaseSync) {
  const files = loadDesignTree(d.repoDir);
  const merges = rows(db, "SELECT * FROM events WHERE kind = 'merge'");
  // The spec's PR is the `(#N)` of the squash commit that added the file; the merge event for that PR names the issue.
  const addedBy = (path: string): number | null => {
    try {
      const subjects = execFileSync("git", ["log", "--diff-filter=A", "--format=%s", "--", path], { cwd: d.repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n");
      const m = /\(#(\d+)\)\s*$/.exec(subjects.at(-1) ?? "");
      return m ? Number(m[1]) : null;
    } catch { return null; }
  };
  const designs: { path: string; children: { path: string; exists: boolean }[] }[] = [];
  const specs: { path: string; status: string | null; issue: number | null; implemented: boolean | null }[] = [];
  for (const [path, text] of files) {
    if (path.startsWith("specs/")) {
      const specPr = addedBy(path);
      const issue: number | null = merges.find((m) => specPr !== null && m.payload.pr === specPr)?.issue ?? null;
      // Implemented: a merge for the issue other than the PR that added the spec.
      const implemented = issue === null ? null : merges.some((m) => m.issue === issue && m.payload.pr !== specPr);
      specs.push({ path, status: parseSpec(text).status, issue, implemented });
    } else if (path !== ROOT) {
      designs.push({ path, children: (parseChildren(text) ?? []).map((c) => ({ path: c, exists: files.has(c) || existsSync(join(d.repoDir, c)) })) });
    }
  }
  return { designs, specs };
}

/** The reflection input of spec 012 AC-15, for the period from `from` to `now`. */
export async function buildReflectionInput(d: ReflectionDeps, def: StandingDefinition, from: Date, now: Date) {
  const db = openIndex(d.paths, { readOnly: true });
  try {
    const f = from.toISOString(), t = now.toISOString();
    const metrics = computeMetrics(db, d.metrics, { from: new Date(from.getTime() - 12 * 7 * DAY), to: now, today: now });
    const byKind: Record<string, number> = {}, byWeek: Record<string, Record<string, number>> = {};
    for (const r of db.prepare("SELECT kind, date(at, 'weekday 0', '-6 days') AS week, count(*) AS c FROM events WHERE at >= ? AND at < ? GROUP BY kind, week").all(f, t) as { kind: string; week: string; c: number }[]) {
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.c;
      (byWeek[r.week] ??= {})[r.kind] = r.c;
    }
    const issueNumbers = (db.prepare(`SELECT DISTINCT issue FROM events WHERE issue IS NOT NULL AND issue > 0 AND at >= ? AND at < ? AND (kind = 'merge' OR kind = 'pause.started' OR (kind = 'issue.released' AND json_extract(payload, '$.reason') = 'abandoned')) ORDER BY issue LIMIT 60`).all(f, t) as { issue: number }[]).map((r) => r.issue);
    const agents: Record<string, unknown> = {};
    for (const [name, s] of Object.entries(await listAgentStates(d.paths))) agents[name] = { last_run: s.last_run, next_run: s.next_run, paused: s.paused, failures: s.failures };
    const plans = readPlans(d.paths, d.reflectionAgents);
    const previous: unknown[] = [];
    for (const a of d.reflectionAgents) { const last = plans.filter((p) => p.agent === a).at(-1); if (last) previous.push(await planWithFates(d, db, last)); }
    let cursor = 0;
    try { cursor = JSON.parse(await readFile(d.paths.findingsCursor, "utf8")).line ?? 0; } catch { /* none yet */ }
    const queue = (await readFile(d.paths.findingsQueue, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const outcomes: Record<string, number> = {};
    for (const r of rows(db, "SELECT * FROM events WHERE kind = 'finding.triaged' AND at >= ? AND at < ?", f, t)) outcomes[r.payload.outcome] = (outcomes[r.payload.outcome] ?? 0) + 1;
    const input: Record<string, unknown> & { open_questions: ReturnType<typeof openQuestions> } = {
      period: { from: f, to: t }, agent: def.name, parameters: await d.parameters.all(), agents, metrics,
      events_summary: { by_kind: byKind, by_week: byWeek },
      issues: issueNumbers.map((n) => timeline(db, n)),
      open_questions: openQuestions(db),
      previous_plans: previous,
      open_bot_issues: (await d.gh.listOpenIssuesByAuthor(d.botLogin)).map((i) => ({ number: i.number, title: i.title, labels: i.labels, age_days: Math.floor((now.getTime() - Date.parse(i.createdAt)) / DAY) })),
      findings_pending: { unconsumed: Math.max(0, queue - cursor), triage_outcomes: outcomes },
    };
    if (def.name === "delivery-reflection") input.design_tree = designTree(d, db);
    if (def.name === "charter-reflection") {
      const text = existsSync(join(d.repoDir, ROOT)) ? readFileSync(join(d.repoDir, ROOT), "utf8") : "";
      input.charter = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p, i) => ({ n: i + 1, text: p }));
      input.console_available = false;
      input.maintainer_contacts = groupContacts(db, f, t);
    }
    if (def.name === "meta-reflection") {
      const since = new Date(now.getTime() - 183 * DAY).toISOString();
      input.metric_definitions = Object.values(d.metrics);
      input.snapshots = rows(db, "SELECT * FROM events WHERE kind = 'metrics.snapshot' AND at >= ? ORDER BY at", since).map((e) => ({ at: e.at, agent: e.agent, metrics: (e.payload.metrics ?? []).map((m: any) => ({ name: m.name, status: m.status, buckets: m.buckets })) }));
      const all: unknown[] = [];
      for (const p of plans.filter((p) => p.at >= since)) all.push(await planWithFates(d, db, p));
      input.all_plans = all;
      input.question_outcomes = questionOutcomes(db, since);
    }
    return input;
  } finally {
    db.close();
  }
}
