import type { MetricReport } from "./compute.ts";

/** One row per metric and bucket (spec 012 AC-10). */
export function formatReport(report: MetricReport): string {
  const rows: string[][] = [["metric", "goal", "status", "week", "value", "n"]];
  for (const m of report.metrics) {
    const status = m.status === "replaced" ? `replaced by ${m.replaced_by} (${m.overlap_days_left}d left)` : m.status;
    for (const b of m.buckets) rows.push([m.name, m.goal, status, b.bucket, b.value === null ? "-" : String(Math.round(b.value * 1000) / 1000), String(b.n)]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}
