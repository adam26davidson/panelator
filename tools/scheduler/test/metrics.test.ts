import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex } from "../src/events/index.ts";
import { computeMetrics, recordSnapshot } from "../src/metrics/compute.ts";
import { checkQuery, loadMetricDefinitions } from "../src/metrics/definitions.ts";
import { formatReport } from "../src/metrics/format.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { agentsDir } from "../src/config.ts";
import { validate } from "../src/schema/validate.ts";

const metricsDir = join(agentsDir, "metrics");
const fixtures = join(import.meta.dirname, "fixtures", "events");
const today = new Date("2026-10-28T00:00:00Z");

async function fixtureState() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "metrics-")));
  await ensureStateDirs(paths);
  cpSync(fixtures, paths.events, { recursive: true, filter: (s) => !s.endsWith("expected.json") });
  return paths;
}

const GOOD = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    name: "m", goal: "speed", description: "d", unit: "u", direction: "lower", introduced: "2026-10-28",
    rationale: "r".repeat(210), query: "SELECT date(at) AS bucket, count(*) AS value, count(*) AS n FROM events WHERE at >= :from AND at < :to GROUP BY bucket", ...over,
  };
  return Object.entries(base).filter(([, v]) => v !== "").map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
};
function dirWith(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "metric-defs-"));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t);
  return dir;
}

describe("metric definitions (AC-5, AC-7, AC-8)", () => {
  it("the repository's definitions load and carry the seed set", () => {
    const defs = loadMetricDefinitions(metricsDir, { today });
    expect(defs.map((d) => d.name).sort()).toEqual([
      "cost_per_merged_issue_usd", "issue_to_merge_days", "merged_per_week", "merged_per_week_product", "merged_per_week_system",
      "post_merge_defects", "questions_decide_yourself", "questions_per_week", "rework_per_merge",
    ]);
    expect(new Set(defs.map((d) => d.goal))).toEqual(new Set(["speed", "delivery", "quality", "spend", "autonomy"]));
  });
  it("loads a good file and names the file and key for each failure", () => {
    expect(loadMetricDefinitions(dirWith({ "m.yaml": GOOD() }), { today })).toHaveLength(1);
    const fails: [string, Record<string, string>, RegExp][] = [
      ["unknown key", { extra: "x" }, /m\.yaml: extra/],
      ["missing key", { unit: "" }, /m\.yaml: unit/],
      ["bad goal", { goal: "fun" }, /m\.yaml: goal/],
      ["short rationale", { rationale: "short" }, /m\.yaml: rationale/],
      ["name mismatch", { name: "other" }, /m\.yaml: name/],
      ["wrong columns", { query: "SELECT 1 AS a, 2 AS b, 3 AS c FROM events" }, /m\.yaml: query: .*bucket, value, n/],
      ["does not prepare", { query: "SELECT nope(1) AS bucket, 1 AS value, 1 AS n FROM events" }, /m\.yaml: query/],
      ["other table", { query: "SELECT 1 AS bucket, 1 AS value, 1 AS n FROM meta" }, /m\.yaml: query/],
      ["sqlite_master", { query: "SELECT 1 AS bucket, 1 AS value, 1 AS n FROM sqlite_master" }, /m\.yaml: query/],
      ["not a select", { query: "DELETE FROM events" }, /m\.yaml: query/],
      ["two statements", { query: "SELECT 1 AS bucket, 1 AS value, 1 AS n FROM events; DROP TABLE events" }, /m\.yaml: query/],
    ];
    for (const [label, over, re] of fails) {
      const text = label === "unknown key" ? GOOD() + "extra: x\n" : GOOD(over);
      expect(() => loadMetricDefinitions(dirWith({ "m.yaml": text }), { today }), label).toThrow(re);
    }
    expect(() => checkQuery("WITH t AS (SELECT at FROM events) SELECT date(at) AS bucket, 1 AS value, 1 AS n FROM t")).not.toThrow();
  });
  it("a replaced metric must keep running for 28 days and the replacement must say why (AC-7, AC-8)", () => {
    const newer = GOOD({ name: "m2", replaces: "m", rationale: "q".repeat(220) });
    expect(() => loadMetricDefinitions(dirWith({ "m2.yaml": newer }), { today })).toThrow(/m2\.yaml: replaces/);
    expect(() => loadMetricDefinitions(dirWith({ "m2.yaml": newer }), { today: new Date("2026-12-01T00:00:00Z") })).not.toThrow();
    expect(() => loadMetricDefinitions(dirWith({ "m.yaml": GOOD(), "m2.yaml": GOOD({ name: "m2", replaces: "m" }) }), { today })).toThrow(/m2\.yaml: rationale/);
    expect(loadMetricDefinitions(dirWith({ "m.yaml": GOOD(), "m2.yaml": newer }), { today })).toHaveLength(2);
  });
});

describe("metrics report (AC-6, AC-9, AC-3)", () => {
  const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8")) as { from: string; to: string; buckets: string[]; values: Record<string, Record<string, [number, number]>> };

  it("each seed metric returns the fixture's expected values, with null buckets for gaps", async () => {
    const paths = await fixtureState();
    const db = openIndex(paths, { readOnly: true });
    const report = computeMetrics(db, loadMetricDefinitions(metricsDir, { today }), { from: expected.from, to: expected.to, now: today });
    expect(validate("metrics-report", report).ok).toBe(true);
    expect(report.metrics.map((m) => m.name).sort()).toEqual(Object.keys(expected.values).sort());
    for (const m of report.metrics) {
      expect(m.buckets.map((b) => b.bucket)).toEqual(expected.buckets);
      for (const b of m.buckets) {
        const want = expected.values[m.name][b.bucket];
        if (!want) expect(b, `${m.name} ${b.bucket}`).toEqual({ bucket: b.bucket, value: null, n: 0 });
        else {
          expect(b.value, `${m.name} ${b.bucket}`).toBeCloseTo(want[0], 3);
          expect(b.n, `${m.name} ${b.bucket}`).toBe(want[1]);
        }
      }
    }
    expect(formatReport(report)).toContain("issue_to_merge_days");
  });

  it("the index is derived: deleting it gives identical values (AC-3)", async () => {
    const paths = await fixtureState();
    const defs = loadMetricDefinitions(metricsDir, { today });
    const run = () => computeMetrics(openIndex(paths, { readOnly: true }), defs, { from: expected.from, to: expected.to, now: today });
    const before = run();
    rmSync(paths.eventsIndex);
    expect(run()).toEqual(before);
    writeFileSync(paths.eventsIndex, "not a database");
    expect(run()).toEqual(before);
  });

  it("marks a replaced metric beside its replacement and leaves retired ones out unless asked (AC-7)", async () => {
    const paths = await fixtureState();
    const dir = dirWith({
      "old.yaml": GOOD({ name: "old" }), "new.yaml": GOOD({ name: "new", replaces: "old", rationale: "n".repeat(230) }),
      "gone.yaml": GOOD({ name: "gone" }) + "retired: 2026-10-01\n",
    });
    const defs = loadMetricDefinitions(dir, { today });
    const db = openIndex(paths, { readOnly: true });
    const report = computeMetrics(db, defs, { from: expected.from, to: expected.to, now: today });
    expect(report.metrics.map((m) => [m.name, m.status, m.replaced_by, m.overlap_days_left])).toEqual([["new", "active", undefined, undefined], ["old", "replaced", "new", 28]]);
    expect(computeMetrics(db, defs, { from: expected.from, to: expected.to, now: today, includeRetired: true }).metrics.map((m) => m.name)).toContain("gone");
  });

  it("a snapshot is recorded as an event (AC-9)", async () => {
    const paths = await fixtureState();
    const report = computeMetrics(openIndex(paths, { readOnly: true }), [], { from: expected.from, to: expected.to, now: today });
    await recordSnapshot(paths, report, "test");
    const db = openIndex(paths, { readOnly: true });
    expect(db.prepare("SELECT count(*) AS c FROM events WHERE kind='metrics.snapshot' AND at = ?").get(report.computed_at)).toEqual({ c: 1 });
  });
});
