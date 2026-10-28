import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadDesignTree, TOP_DESIGNS } from "../gates/design-tree.ts";
import { openIndex } from "../events/index.ts";
import { CLAIM_LABEL } from "../chain/machine.ts";
import type { GitHubClient } from "../github/client.ts";
import { computeMetrics, recordSnapshot, weekBucket } from "../metrics/compute.ts";
import { loadMetricDefinitions } from "../metrics/definitions.ts";
import type { ParameterStore } from "../parameters/store.ts";
import { specPathFromIssueBody } from "../spec/link.ts";
import { parseChildren, parseSpec } from "../spec/parse.ts";
import { readAgentState, type AgentState } from "../standing/state.ts";
import type { StatePaths } from "../state/paths.ts";
import type { StandingDefinition } from "../types.ts";
import { readJsonLines } from "../filer/input.ts";
import { readdir, readFile } from "node:fs/promises";

export interface ReflectionInputDeps {
  paths: StatePaths;
  gh: GitHubClient;
  botLogin: string;
  parameters: ParameterStore;
  registry: Record<string, StandingDefinition>;
  agentsDir: string;
  /** A checkout of main: the charter, the designs, the specs. */
  repoDir: string;
  now: () => Date;
  log?: (rec: Record<string, unknown>) => void;
}

export interface StoredPlan {
  agent: string;
  run_id: string;
  plan_key: string;
  at: string;
  plan_issue: number;
  plan: { title: string; items: unknown[]; deferred: unknown[] };
  filed: { index: number; number: number; title: string }[];
}

const dayMs = 86_400_000;
type Row = { at: string; kind: string; issue: number | null; run_id: string | null; agent: string | null; payload: Record<string, any> };

function rows(db: DatabaseSync, sql: string, ...params: (string | number)[]): Row[] {
  return (db.prepare(sql).all(...params) as { at: string; kind: string; issue: number | null; run_id: string | null; agent: string | null; payload: string }[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
const COLS = "at, kind, issue, run_id, agent, payload";

/** The charter's paragraphs, numbered: its clauses (the heading is not one). */
export function charterClauses(text: string): { n: number; text: string }[] {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith("#")).map((p, i) => ({ n: i + 1, text: p.replace(/\n/g, " ") }));
}

/** Every reflection plan the scheduler wrote for `agent` (or all agents), oldest first. */
export async function readStoredPlans(paths: StatePaths, agent?: string): Promise<StoredPlan[]> {
  const out: StoredPlan[] = [];
  for (const dir of await readdir(paths.reflections).catch(() => [] as string[])) {
    if (agent && dir !== agent) continue;
    for (const f of await readdir(join(paths.reflections, dir)).catch(() => [] as string[])) {
      if (f.endsWith(".json")) out.push(JSON.parse(await readFile(join(paths.reflections, dir, f), "utf8")) as StoredPlan);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The current state of an issue a plan filed, from GitHub and the events (AC-15, AC-20). */
export async function issueFate(db: DatabaseSync, gh: GitHubClient, n: number): Promise<{ number: number; state: string; pr?: number }> {
  let raw;
  try {
    raw = await gh.issueState(n);
  } catch {
    return { number: n, state: "unknown" };
  }
  if (raw.labels.includes("abandoned")) return { number: n, state: "abandoned" };
  if (raw.state === "open") return { number: n, state: raw.labels.includes(CLAIM_LABEL) ? "in progress" : "open" };
  const merged = db.prepare("SELECT json_extract(payload,'$.pr') AS pr FROM events WHERE kind='merge' AND issue=? ORDER BY at DESC LIMIT 1").get(n) as { pr: number } | undefined;
  return merged ? { number: n, state: "merged", pr: merged.pr } : { number: n, state: "closed" };
}

async function planWithFates(db: DatabaseSync, gh: GitHubClient, p: StoredPlan) {
  return { agent: p.agent, run_id: p.run_id, at: p.at, plan_issue: p.plan_issue, title: p.plan.title, deferred: p.plan.deferred.length, issues: await Promise.all(p.filed.map(async (f) => ({ ...f, ...(await issueFate(db, gh, f.number)) }))) };
}

function timeline(db: DatabaseSync, issue: number) {
  const ev = rows(db, `SELECT ${COLS} FROM events WHERE issue=? ORDER BY at`, issue);
  const by = (k: string) => ev.filter((e) => e.kind === k);
  const runs = by("run.ended").map((e) => ({ run_id: e.payload.run_id, stage: e.payload.stage, model: e.payload.model, outcome: e.payload.outcome, cost_usd: e.payload.cost_usd }));
  const starts = by("pause.started"), ends = by("pause.ended");
  return {
    issue,
    eligible: by("issue.eligible").map((e) => e.at), claimed: by("issue.claimed").map((e) => e.at), released: by("issue.released").map((e) => ({ at: e.at, reason: e.payload.reason })),
    transitions: by("chain.transition").map((e) => ({ at: e.at, from: e.payload.from, to: e.payload.to, event: e.payload.event })),
    runs, reviews: by("review.result").map((e) => ({ at: e.at, verdict: e.payload.verdict, findings: e.payload.findings, security: e.payload.security })),
    questions: by("question").map((e) => ({ at: e.at, event: e.payload.event, asking_stage: e.payload.asking_stage })),
    pauses: starts.map((s, i) => ({ started: s.at, ended: ends[i]?.at ?? null })),
    merged: by("merge").map((e) => ({ at: e.at, pr: e.payload.pr })),
    total_cost_usd: runs.reduce((a, r) => a + (Number(r.cost_usd) || 0), 0),
  };
}

function designTree(deps: ReflectionInputDeps, specIssues: Map<string, number[]>, db: DatabaseSync) {
  const files = loadDesignTree(deps.repoDir);
  const designs = [...TOP_DESIGNS, ...[...files.keys()].filter((f) => f.startsWith("docs/designs/"))].filter((f) => files.has(f)).map((path) => ({
    path, children: (parseChildren(files.get(path)!) ?? []).map((c) => ({ path: c, exists: existsSync(join(deps.repoDir, c)) })),
  }));
  const specs = [...files.keys()].filter((f) => f.startsWith("specs/")).map((path) => {
    const issues = specIssues.get(path) ?? [];
    const implemented = issues.some((n) => db.prepare("SELECT 1 FROM events WHERE kind='merge' AND issue=? LIMIT 1").get(n));
    return { path, status: parseSpec(files.get(path)!).status, issues, implemented };
  });
  return { designs, specs };
}

/** AC-15: the scheduler's input to a reflection run; the agent has no GitHub tool and reads the repository itself. */
export async function buildReflectionInput(deps: ReflectionInputDeps, def: StandingDefinition, state: AgentState): Promise<Record<string, unknown>> {
  const now = deps.now();
  const to = now.toISOString();
  const from = state.last_success?.at ?? new Date(now.getTime() - 28 * dayMs).toISOString();
  const db = openIndex(deps.paths, { readOnly: true, log: deps.log });
  try {
    const defs = loadMetricDefinitions(join(deps.agentsDir, "metrics"), { today: now });
    const metrics = computeMetrics(db, defs, { from: new Date(Date.parse(weekBucket(Date.parse(from))) - 12 * 7 * dayMs).toISOString(), to, now });
    await recordSnapshot(deps.paths, metrics, "reflection", def.name);

    const agents: Record<string, unknown> = {};
    for (const d of Object.values(deps.registry)) {
      const s = await readAgentState(deps.paths, d.name);
      if (s) agents[d.name] = { last_run: s.last_run, last_success: s.last_success ?? null, next_run: s.next_run, paused: s.paused, consecutive_failures: s.failures };
    }

    const events = rows(db, `SELECT ${COLS} FROM events WHERE at >= ? AND at < ?`, from, to);
    const by_kind: Record<string, number> = {};
    const by_week: Record<string, Record<string, number>> = {};
    for (const e of events) {
      by_kind[e.kind] = (by_kind[e.kind] ?? 0) + 1;
      const w = (by_week[weekBucket(Date.parse(e.at))] ??= {});
      w[e.kind] = (w[e.kind] ?? 0) + 1;
    }

    const issueNumbers = [...new Set(events.filter((e) => e.issue && (e.kind === "merge" || e.kind === "pause.started" || (e.kind === "issue.released" && e.payload.reason === "abandoned"))).map((e) => e.issue!))].slice(-100);

    const contacts = rows(db, `SELECT ${COLS} FROM events WHERE kind='maintainer.contact'`);
    const open_questions = rows(db, `SELECT ${COLS} FROM events s WHERE kind='question' AND json_extract(payload,'$.event')='sent' AND NOT EXISTS (SELECT 1 FROM events a WHERE a.kind='question' AND json_extract(a.payload,'$.event')='answered' AND a.issue=s.issue AND json_extract(a.payload,'$.question_comment_id')=json_extract(s.payload,'$.question_comment_id'))`).map((q) => ({
      issue: q.issue, asking_stage: q.payload.asking_stage, question_comment_id: q.payload.question_comment_id ?? null, sent_at: q.at,
      question: contacts.find((c) => c.payload.kind === "question" && c.issue === q.issue && c.payload.question_comment_id === q.payload.question_comment_id)?.payload.text ?? "",
    }));

    const stored = await readStoredPlans(deps.paths);
    const reflectionAgents = Object.values(deps.registry).filter((d) => d.output === "reflection-result").map((d) => d.name);
    const previous_plans = await Promise.all(reflectionAgents.flatMap((a) => stored.filter((p) => p.agent === a).slice(-1)).map((p) => planWithFates(db, deps.gh, p)));

    const open_bot_issues = (await deps.gh.listOpenIssuesByAuthor(deps.botLogin)).map((i) => ({ number: i.number, title: i.title, labels: i.labels, age_days: Math.floor((now.getTime() - Date.parse(i.createdAt)) / dayMs) }));

    let cursor = 0;
    try {
      cursor = JSON.parse(readFileSync(deps.paths.findingsCursor, "utf8")).line;
    } catch {
      /* no cursor yet */
    }
    const queued = (await readJsonLines(deps.paths.findingsQueue)).length;
    const triage_outcomes: Record<string, number> = {};
    for (const t of await readJsonLines<{ outcome: string; at: string }>(deps.paths.findingsTriage)) if (t.at >= from) triage_outcomes[t.outcome] = (triage_outcomes[t.outcome] ?? 0) + 1;

    const input: Record<string, unknown> = {
      period: { from, to }, agent: def.name, parameters: await deps.parameters.all(), agents, metrics,
      events_summary: { total: events.length, by_kind, by_week },
      issues: issueNumbers.map((n) => timeline(db, n)), open_questions, previous_plans, open_bot_issues,
      findings_pending: { pending: Math.max(0, queued - cursor), triage_outcomes },
    };

    if (def.name.startsWith("delivery")) {
      const specIssues = new Map<string, number[]>();
      for (const i of await deps.gh.listIssuesRaw({ state: "all" })) {
        const p = specPathFromIssueBody(i.body);
        if (p) specIssues.set(p, [...(specIssues.get(p) ?? []), i.number]);
      }
      input.design_tree = designTree(deps, specIssues, db);
    }
    if (def.name.startsWith("charter")) {
      const charterPath = join(deps.repoDir, "docs", "charter.md");
      input.charter = existsSync(charterPath) ? charterClauses(readFileSync(charterPath, "utf8")) : [];
      input.console_present = false;
      const groups = new Map<string, Row[]>();
      for (const c of contacts.filter((c) => c.at >= from && c.at < to)) {
        const key = `${c.payload.kind}\u0000${c.payload.label}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      input.maintainer_contacts = [...groups.values()].map((g) => ({
        kind: g[0].payload.kind, label: g[0].payload.label, count: g.length, first: g[0].at, last: g.at(-1)!.at, examples: g.slice(0, 3).map((c) => c.payload.text), recurring: g.length >= 2,
      }));
    }
    if (def.name.startsWith("meta")) {
      const sixMonths = new Date(now.getTime() - 183 * dayMs).toISOString();
      input.metric_definitions = defs;
      input.snapshots = rows(db, `SELECT ${COLS} FROM events WHERE kind='metrics.snapshot' AND at >= ? ORDER BY at`, sixMonths).map((e) => ({ at: e.at, agent: e.agent, reason: e.payload.reason, report: e.payload.report }));
      input.all_plans = await Promise.all(stored.filter((p) => p.at >= sixMonths).map((p) => planWithFates(db, deps.gh, p)));
      const q = rows(db, `SELECT ${COLS} FROM events WHERE kind='question' AND at >= ? ORDER BY at`, sixMonths);
      const months = new Map<string, { sent: number; answered: number; decide_yourself: number; hours: number[] }>();
      const sentAt = new Map<string, string>();
      for (const e of q) {
        const m = months.get(e.at.slice(0, 7)) ?? { sent: 0, answered: 0, decide_yourself: 0, hours: [] };
        months.set(e.at.slice(0, 7), m);
        const key = `${e.issue}:${e.payload.question_comment_id}`;
        if (e.payload.event === "sent") { m.sent++; sentAt.set(key, e.at); }
        else if (e.payload.event === "checked" && e.payload.verdict === "decide_yourself") m.decide_yourself++;
        else if (e.payload.event === "answered") { m.answered++; const s = sentAt.get(key); if (s) m.hours.push((Date.parse(e.at) - Date.parse(s)) / 3_600_000); }
      }
      const median = (h: number[]) => (h.length ? [...h].sort((a, b) => a - b)[Math.floor((h.length - 1) / 2)] : null);
      input.question_outcomes = [...months].map(([month, m]) => ({ month, sent: m.sent, answered: m.answered, decide_yourself: m.decide_yourself, median_hours_to_answer: median(m.hours) }));
    }
    return input;
  } finally {
    db.close();
  }
}
