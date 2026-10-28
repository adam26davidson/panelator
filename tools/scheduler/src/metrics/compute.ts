import type { DatabaseSync } from "node:sqlite";
import { recordEvent } from "../events/store.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { overlapDaysLeft, queryParams, type MetricDefinition } from "./definitions.ts";

export interface MetricBucket {
  bucket: string;
  value: number | null;
  n: number;
}
export interface MetricReport {
  name: string;
  goal: string;
  unit: string;
  direction: "lower" | "higher";
  introduced: string;
  description: string;
  rationale: string;
  status: "active" | "replaced" | "retired";
  replaced_by?: string;
  overlap_days_left?: number;
  buckets: MetricBucket[];
}
export interface MetricsReport {
  from: string;
  to: string;
  computed_at: string;
  metrics: MetricReport[];
}

const dayMs = 86_400_000;

/** The Monday (UTC) of the week holding `t`, as the bucket label the queries produce: `date(at,'weekday 0','-6 days')`. */
export function weekBucket(t: number): string {
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

export function weekBuckets(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to);
  for (let t = Date.parse(weekBucket(Date.parse(from))); t < end; t += 7 * dayMs) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The first `weeks` weeks ending at `now`, aligned to Mondays. */
export function lastWeeks(now: Date, weeks: number): { from: string; to: string } {
  const start = Date.parse(weekBucket(now.getTime())) - (weeks - 1) * 7 * dayMs;
  return { from: new Date(start).toISOString(), to: now.toISOString() };
}

export function runMetric(db: DatabaseSync, def: MetricDefinition, from: string, to: string): MetricBucket[] {
  const rows = db.prepare(def.query.trim().replace(/;\s*$/, "")).all(queryParams(def.query, from, to)) as { bucket: string; value: number | null; n: number }[];
  const byBucket = new Map(rows.map((r) => [String(r.bucket), r]));
  // A bucket with no events appears with value null and n 0, so a gap is visible rather than skipped.
  return weekBuckets(from, to).map((bucket) => {
    const r = byBucket.get(bucket);
    return r ? { bucket, value: r.value === null ? null : Number(r.value), n: Number(r.n) } : { bucket, value: null, n: 0 };
  });
}

/** AC-9: the report over weekly buckets for every definition not retired (retired ones on request). */
export function computeMetrics(db: DatabaseSync, defs: MetricDefinition[], opts: { from: string; to: string; includeRetired?: boolean; now?: Date }): MetricsReport {
  const now = opts.now ?? new Date();
  const metrics: MetricReport[] = [];
  for (const def of defs) {
    const retired = def.retired !== undefined && Date.parse(def.retired) <= now.getTime();
    if (retired && !opts.includeRetired) continue;
    const replacement = defs.find((d) => d.replaces === def.name);
    const m: MetricReport = {
      name: def.name, goal: def.goal, unit: def.unit, direction: def.direction, introduced: def.introduced, description: def.description, rationale: def.rationale,
      status: retired ? "retired" : replacement ? "replaced" : "active", buckets: runMetric(db, def, opts.from, opts.to),
    };
    if (replacement) {
      m.replaced_by = replacement.name;
      m.overlap_days_left = overlapDaysLeft(replacement, now);
    }
    metrics.push(m);
  }
  const report: MetricsReport = { from: opts.from, to: opts.to, computed_at: now.toISOString(), metrics };
  const v = validate("metrics-report", report);
  if (!v.ok) throw new Error(`invalid metrics report: ${v.errors.join("; ")}`);
  return report;
}

/** AC-9: what a reflection (or `metrics --snapshot`) saw, kept as an event. */
export async function recordSnapshot(paths: StatePaths, report: MetricsReport, reason: string, agent?: string): Promise<void> {
  await recordEvent(paths, { kind: "metrics.snapshot", at: report.computed_at, ...(agent ? { agent } : {}), payload: { reason, report } });
}
