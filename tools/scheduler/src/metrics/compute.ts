import type { DatabaseSync } from "node:sqlite";
import { record } from "../events/store.ts";
import type { StatePaths } from "../state/paths.ts";
import { OVERLAP_DAYS, type MetricDefinition } from "./definitions.ts";

export interface MetricBucket { bucket: string; value: number | null; n: number }
export interface MetricReport {
  from: string; to: string; computed_at: string;
  metrics: {
    name: string; goal: string; unit: string; direction: "lower" | "higher"; introduced: string; description: string; rationale: string;
    status: "active" | "replaced" | "retired"; replaced_by?: string; overlap_days_left?: number; buckets: MetricBucket[];
  }[];
}

const DAY = 86_400_000;
/** The Monday (UTC) of the week holding `t`, as YYYY-MM-DD: the bucket label the seed queries produce. */
export function weekStart(t: number): string {
  const d = new Date(t);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}
export function weeksBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = Date.parse(weekStart(from.getTime())); t < to.getTime(); t += 7 * DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Full history starts with the earliest raw event, including backfilled records, not the definition's introduction. */
export function historyRange(index: DatabaseSync, def: MetricDefinition, now: Date): { from: Date; to: Date } {
  const first = index.prepare("SELECT min(at) AS at FROM events").get() as { at: string | null };
  return { from: new Date(weekStart(Date.parse(first.at ?? def.introduced))), to: now };
}

/** The report of spec 012 AC-9: every weekly bucket from `from` to `to`, a gap as `value: null, n: 0`. */
export function computeMetrics(
  index: DatabaseSync, definitions: Record<string, MetricDefinition>,
  opts: { from: Date; to: Date; includeRetired?: boolean; today?: Date; names?: string[] },
): MetricReport {
  const today = opts.today ?? opts.to;
  const weeks = weeksBetween(opts.from, opts.to);
  const replacedBy = new Map<string, MetricDefinition>();
  for (const d of Object.values(definitions)) if (d.replaces) replacedBy.set(d.replaces, d);
  const metrics: MetricReport["metrics"] = [];
  for (const def of Object.values(definitions)) {
    if (opts.names && !opts.names.includes(def.name)) continue;
    const retired = def.retired !== undefined && Date.parse(`${def.retired}T00:00:00Z`) < today.getTime();
    if (retired && !opts.includeRetired && !opts.names) continue;
    const st = index.prepare(def.query);
    st.setAllowUnknownNamedParameters(true);
    const rows = new Map((st.all({ from: opts.from.toISOString(), to: opts.to.toISOString() }) as { bucket: string; value: number | null; n: number }[]).map((r) => [r.bucket, r]));
    const buckets = weeks.map((bucket) => ({ bucket, value: rows.get(bucket)?.value ?? null, n: Number(rows.get(bucket)?.n ?? 0) }));
    const newer = replacedBy.get(def.name);
    const left = newer ? Math.ceil((Date.parse(`${newer.introduced}T00:00:00Z`) + OVERLAP_DAYS * DAY - today.getTime()) / DAY) : undefined;
    metrics.push({
      name: def.name, goal: def.goal, unit: def.unit, direction: def.direction, introduced: def.introduced, description: def.description, rationale: def.rationale,
      status: retired ? "retired" : newer ? "replaced" : "active",
      ...(newer ? { replaced_by: newer.name, overlap_days_left: Math.max(0, left!) } : {}), buckets,
    });
  }
  return { from: opts.from.toISOString(), to: opts.to.toISOString(), computed_at: today.toISOString(), metrics };
}

export async function recordSnapshot(paths: StatePaths, report: MetricReport, who: { agent?: string; run_id?: string } = {}): Promise<void> {
  await record(paths, "metrics.snapshot", report.computed_at, report as unknown as Record<string, unknown>, who);
}
