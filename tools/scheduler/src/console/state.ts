import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readCost } from "../aws/book.ts";
import type { ActionLog } from "../actions/log.ts";
import type { ParameterStore } from "../parameters/store.ts";
import type { Config } from "../config.ts";
import { openIndex } from "../events/index.ts";
import { computeMetrics, type MetricReport } from "../metrics/compute.ts";
import type { MetricDefinition } from "../metrics/definitions.ts";
import { listAgentStates } from "../standing/state.ts";
import { readJsonLines } from "../state/jsonl.ts";
import { listClaims } from "../state/claims.ts";
import type { StatePaths } from "../state/paths.ts";
import { readUsageRecord, type UsageRecord } from "../state/runs.ts";
import type { QuestionLogEntry } from "../state/questions.ts";
import type { StandingDefinition } from "../types.ts";

/** One recorded change with its outcome, a line of `console/changes.jsonl` (spec 051 AC-4). */
export interface ChangeRecord {
  id: number; at: string; by: string; kind: string; args: unknown;
  status: "pending" | "applied" | "refused"; action_id?: string; reason?: string;
}

export interface ConsoleStateContext {
  cfg: Config; paths: StatePaths; parameters: ParameterStore; log: ActionLog;
  registry: Record<string, StandingDefinition>; metrics: Record<string, MetricDefinition>;
  now: () => Date;
  /** Issue titles and classes the tick already fetched; unknown ones read as "". */
  issues?: () => Map<number, { title: string; class: string }>;
  upNext?: () => number[];
  telegramUsername?: () => string | null;
}

const STAGES = ["plan", "implement", "verify", "review", "fix", "merge"];
const DAY = 86_400_000;

export async function readChanges(paths: StatePaths): Promise<ChangeRecord[]> {
  try { return await readJsonLines<ChangeRecord>(paths.consoleChanges); } catch { return []; }
}

async function questions(ctx: ConsoleStateContext) {
  let rows: QuestionLogEntry[] = [];
  try { rows = await readJsonLines<QuestionLogEntry>(ctx.paths.questionsLog); } catch { return []; }
  const by = new Map<number, Record<string, unknown>>();
  const user = ctx.telegramUsername?.() ?? null;
  for (const e of rows) {
    const id = e.question_comment_id;
    if (id === undefined) continue;
    const cur = by.get(id) ?? {};
    if (e.event === "asked" || e.event === "sent" || cur.question_comment_id === undefined) {
      if (e.question) Object.assign(cur, { text: e.question.question, kind: e.question.kind, options: e.question.options.map((o) => o.label) });
      if (cur.asked_at === undefined || e.event === "asked") cur.asked_at = e.at;
    }
    if (e.question && cur.text === undefined) Object.assign(cur, { text: e.question.question, kind: e.question.kind, options: e.question.options.map((o) => o.label) });
    cur.question_comment_id = id; cur.issue = e.issue;
    if (e.event === "reminded" && cur.status !== "answered") cur.status = "reminded";
    else if (e.event === "answered") {
      cur.status = "answered"; cur.answered_at = e.at;
      if (e.reply_comment_id !== undefined) cur.decision_url = `https://github.com/${ctx.cfg.repo}/issues/${e.issue}#issuecomment-${e.reply_comment_id}`;
    } else if (cur.status === undefined) cur.status = "open";
    by.set(id, cur);
  }
  return [...by.values()].map((q) => ({
    question_comment_id: q.question_comment_id as number, issue: q.issue as number, kind: (q.kind as string) ?? "other", text: (q.text as string) ?? "",
    options: (q.options as string[]) ?? [], asked_at: (q.asked_at as string) ?? "", status: q.status as "open" | "reminded" | "answered",
    ...(q.answered_at ? { answered_at: q.answered_at as string } : {}),
    question_url: `https://github.com/${ctx.cfg.repo}/issues/${q.issue}#issuecomment-${q.question_comment_id}`,
    ...(q.decision_url ? { decision_url: q.decision_url as string } : {}),
    ...(user ? { telegram_url: `https://t.me/${user}` } : {}),
  }));
}

async function current(ctx: ConsoleStateContext, now: Date, usage: UsageRecord[]) {
  const claims = (await listClaims(ctx.paths)).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const titles = ctx.issues?.() ?? new Map();
  const out = [];
  for (const c of claims) {
    const s = c.state;
    if (["done", "released", "abandoned", "paused", "blocked"].includes(s.stage)) continue;
    const track = s.track === "issue" ? null : s.track;
    const names = track ? [track] : STAGES;
    const at = track ? 0 : STAGES.indexOf(s.stage);
    const failed = false;
    const stages = names.map((name, i) => ({ name, status: (failed ? "failed" : at < 0 ? "pending" : i < at ? "done" : i === at ? "running" : "pending") as "done" | "running" | "pending" | "failed" }));
    const mine = usage.filter((u) => u.issue === c.issue && u.started_at >= c.started_at).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const model = mine.at(-1)?.model ?? "";
    const cost = mine.reduce((n, u) => n + (u.cost_usd ?? 0), 0);
    out.push({
      issue: c.issue, title: titles.get(c.issue)?.title ?? "", stage: track ?? s.stage, stages, model,
      started_at: c.started_at, elapsed_s: Math.max(0, Math.round((now.getTime() - Date.parse(c.started_at)) / 1000)), cost_usd: cost,
      ...(s.pr ? { pr: s.pr.number } : {}),
    });
  }
  return out;
}

function tile(report: MetricReport | null, name: string): number | null {
  const m = report?.metrics.find((x) => x.name === name);
  if (!m) return null;
  const complete = m.buckets.slice(0, -1);
  const last = complete[complete.length - 1];
  return last?.value ?? null;
}

async function metricsReport(ctx: ConsoleStateContext, now: Date): Promise<MetricReport | null> {
  if (!existsSync(ctx.paths.eventsIndex)) return null;
  try {
    const db = openIndex(ctx.paths, { readOnly: true });
    try { return computeMetrics(db, ctx.metrics, { from: new Date(now.getTime() - 52 * 7 * DAY), to: now, includeRetired: true }); } finally { db.close(); }
  } catch { return null; }
}

/** The `console-state` document of spec 051 AC-2. A missing source is null or empty, never an error. */
export async function buildConsoleState(ctx: ConsoleStateContext) {
  const now = ctx.now();
  const report = await metricsReport(ctx, now);
  const records = await usageSince(ctx, new Date(now.getTime() - 30 * DAY));
  const cur = await current(ctx, now, records).catch(() => []);
  const cost = await readCost(ctx.paths).catch(() => null);
  const cap = await ctx.parameters.read("aws_cap_usd").then((v) => (typeof v.value === "number" ? v.value : null)).catch(() => null);
  const titles = ctx.issues?.() ?? new Map();
  const states = await listAgentStates(ctx.paths).catch(() => ({}));
  const usage = new Map<string, number>();
  for (const u of records) if (u.run_id.startsWith("standing-")) usage.set(u.stage, (usage.get(u.stage) ?? 0) + (u.cost_usd ?? 0));
  const stored = await ctx.parameters.all().catch(() => ({}));
  const changes = (await readChanges(ctx.paths)).slice(-50);
  const actions = await ctx.log.list().then((r) => r.slice(-200)).catch(() => []);
  return {
    generated_at: now.toISOString(), repo: ctx.cfg.repo, tick_s: ctx.cfg.poll_interval_s,
    questions: await questions(ctx),
    current: cur,
    next_tick_at: cur.length ? null : new Date(now.getTime() + ctx.cfg.poll_interval_s * 1000).toISOString(),
    up_next: (ctx.upNext?.() ?? []).map((n) => ({ issue: n, title: titles.get(n)?.title ?? "", class: titles.get(n)?.class ?? "" })),
    tiles: {
      merged_per_week: tile(report, "merged_per_week"), issue_to_merge_days: tile(report, "issue_to_merge_days"), rework_per_merge: tile(report, "rework_per_merge"),
      aws: { actual_usd: cost?.actual_usd ?? null, forecast_usd: cost?.forecast_usd ?? null, cap_usd: cap },
    },
    metrics: report as unknown as Record<string, unknown> | null,
    actions: actions as unknown as Record<string, unknown>[],
    agents: Object.keys(ctx.registry).sort().map((name) => {
      const s = (states as Record<string, { last_run: { at: string } | null; next_run: string | null; paused: boolean; paused_by: string | null }>)[name];
      return { name, last_run: s?.last_run?.at ?? null, next_run: s?.next_run ?? null, cost_30d_usd: usage.get(name) ?? 0, paused: s?.paused ?? false, paused_by: s?.paused_by ?? null };
    }),
    parameters: Object.values(ctx.parameters.definitions).map((d) => {
      const v = (stored as Record<string, { value: unknown; mode: "auto" | "locked"; set_by: string; at: string }>)[d.name];
      return {
        name: d.name, type: d.type, value: v?.value ?? d.default, mode: v?.mode ?? d.mode,
        ...(typeof d.min === "number" ? { min: d.min } : {}), ...(typeof d.max === "number" ? { max: d.max } : {}),
        description: d.description, at: v?.at ?? null, set_by: v?.set_by ?? null,
      };
    }),
    changes: changes.map((c) => ({ id: c.id, kind: c.kind, args: c.args, at: c.at, status: c.status, ...(c.action_id ? { action_id: c.action_id } : {}), ...(c.reason ? { reason: c.reason } : {}) })),
  };
}

/** The usage records written since `since` (a record's file is written when its run ends). */
async function usageSince(ctx: ConsoleStateContext, since: Date): Promise<UsageRecord[]> {
  let names: string[];
  try { names = (await readdir(ctx.paths.usage)).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: UsageRecord[] = [];
  for (const n of names) {
    try {
      if ((await stat(join(ctx.paths.usage, n))).mtimeMs < since.getTime()) continue;
      const u = await readUsageRecord(ctx.paths, n.slice(0, -5));
      if (u) out.push(u);
    } catch { /* an unreadable record is skipped */ }
  }
  return out;
}
