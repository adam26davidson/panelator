import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openIndex } from "../src/events/index.ts";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { backfillEvents } from "../src/events/backfill.ts";
import { computeMetrics, historyRange, recordSnapshot } from "../src/metrics/compute.ts";
import { formatReport } from "../src/metrics/format.ts";
import { loadMetricDefinitions, type MetricDefinition } from "../src/metrics/definitions.ts";
import { record } from "../src/events/store.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const fixtures = join(import.meta.dirname, "fixtures", "events");
const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8")) as { from: string; to: string; metrics: Record<string, { bucket: string; value: number | null; n: number }[]> };
const seeds = loadMetricDefinitions(join(agentsDir, "metrics"), new Date("2026-10-28"));

async function fixtureState() {
  const p = statePaths(mkdtempSync(join(tmpdir(), "metrics-")));
  await ensureStateDirs(p);
  for (const f of readdirSync(fixtures).filter((f) => f.endsWith(".jsonl"))) cpSync(join(fixtures, f), join(p.events, f));
  return p;
}
const range = { from: new Date(expected.from), to: new Date(expected.to) };

describe("the seed set (AC-5, AC-6)", () => {
  it("loads the nine definitions of the repository", () => {
    expect(Object.keys(seeds).sort()).toEqual(["cost_per_merged_issue_usd", "issue_to_merge_days", "merged_per_week", "merged_per_week_product", "merged_per_week_system", "post_merge_defects", "questions_decide_yourself", "questions_per_week", "rework_per_merge"]);
    expect(new Set(Object.values(seeds).map((d) => d.goal))).toEqual(new Set(["speed", "delivery", "quality", "spend", "autonomy"]));
  });

  it("returns the values of expected.json over the fixture events", async () => {
    const p = await fixtureState();
    const db = openIndex(p, { readOnly: true });
    const report = computeMetrics(db, seeds, { ...range, today: range.to });
    for (const m of report.metrics) {
      const want = expected.metrics[m.name]!;
      expect(m.buckets.map((b) => b.bucket), m.name).toEqual(want.map((b) => b.bucket));
      m.buckets.forEach((b, i) => {
        expect(b.n, `${m.name} ${b.bucket}`).toBe(want[i]!.n);
        if (want[i]!.value === null) expect(b.value, `${m.name} ${b.bucket}`).toBeNull();
        else expect(b.value, `${m.name} ${b.bucket}`).toBeCloseTo(want[i]!.value!, 6);
      });
    }
    expect(report.metrics).toHaveLength(9);
    db.close();
  });

  it("shows a week with no events as null with n 0, and renders a table", async () => {
    const p = await fixtureState();
    const db = openIndex(p, { readOnly: true });
    const report = computeMetrics(db, seeds, { ...range, today: range.to });
    expect(report.metrics.find((m) => m.name === "merged_per_week")!.buckets[3]).toEqual({ bucket: "2026-10-05", value: null, n: 0 });
    expect(formatReport(report)).toMatch(/merged_per_week\s+delivery\s+active\s+2026-10-05\s+-\s+0/);
    db.close();
  });

  it("gives the same values after the index is deleted (AC-3)", async () => {
    const p = await fixtureState();
    let db = openIndex(p, { readOnly: true });
    const before = computeMetrics(db, seeds, { ...range, today: range.to });
    db.close();
    rmSync(p.eventsIndex);
    db = openIndex(p, { readOnly: true });
    expect(computeMetrics(db, seeds, { ...range, today: range.to })).toEqual(before);
    db.close();
  });

  it("shows the full backfilled history, including weeks before introduced", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "metric-history-")));
    cpSync(join(fixtures, "backfill-state"), p.root, { recursive: true });
    await ensureStateDirs(p); await backfillEvents(p);
    const db = openIndex(p, { readOnly: true });
    const dates = historyRange(db, seeds.issue_to_merge_days!, new Date("2026-10-28"));
    // The old-shape usage record is August 1, earlier than the September usage record.
    expect(dates.from.toISOString()).toBe("2026-07-27T00:00:00.000Z");
    const report = computeMetrics(db, seeds, { ...dates, names: ["issue_to_merge_days"] });
    expect(report.metrics[0]!.buckets[0]!.bucket).toBe("2026-07-27");
    db.close();
    const empty = statePaths(mkdtempSync(join(tmpdir(), "metric-empty-"))); await ensureStateDirs(empty);
    const e = openIndex(empty, { readOnly: true });
    expect(historyRange(e, seeds.issue_to_merge_days!, dates.to).from.toISOString()).toBe("2026-10-26T00:00:00.000Z"); e.close();
  });

  it("records a snapshot event for a computation", async () => {
    const p = await fixtureState();
    const db = openIndex(p, { readOnly: true });
    await recordSnapshot(p, computeMetrics(db, seeds, { ...range, today: range.to }), { agent: "snapshot-test", run_id: "r1" });
    db.close();
    const idx = openIndex(p);
    expect(idx.prepare("SELECT count(*) AS c FROM events WHERE kind = 'metrics.snapshot' AND agent = 'snapshot-test'").get()).toEqual({ c: 1 });
    idx.close();
  });
});

const good = (over: Partial<MetricDefinition> & Record<string, unknown> = {}) => ({
  name: "m", goal: "speed", description: "d", unit: "u", direction: "lower", introduced: "2026-10-01",
  rationale: "r".repeat(210), query: "SELECT strftime('%Y-%W', at) AS bucket, count(*) AS value, count(*) AS n FROM events GROUP BY bucket", ...over,
});
function load(files: Record<string, Record<string, unknown>>, today = "2026-10-28") {
  const dir = mkdtempSync(join(tmpdir(), "metric-defs-"));
  for (const [name, def] of Object.entries(files)) writeFileSync(join(dir, `${name}.yaml`), JSON.stringify(def));
  return () => loadMetricDefinitions(dir, new Date(today));
}

describe("definition checks (AC-5, AC-7, AC-8)", () => {
  it("accepts a good definition", () => expect(load({ m: good() })()).toHaveProperty("m"));
  it.each([
    ["an unknown key", { extra: 1 }, /m\.yaml: extra/],
    ["a missing key", { unit: undefined }, /m\.yaml: unit/],
    ["a goal outside the five", { goal: "fun" }, /m\.yaml: goal/],
    ["a name that is not the file name", { name: "other" }, /m\.yaml: name/],
    ["a rationale under 200 characters", { rationale: "short" }, /m\.yaml: rationale/],
    ["a statement that is not a SELECT", { query: "DELETE FROM events" }, /m\.yaml: query/],
    ["two statements", { query: "SELECT 1 AS bucket, 1 AS value, 1 AS n; SELECT 1" }, /m\.yaml: query/],
    ["a query naming the meta table", { query: "SELECT key AS bucket, 1 AS value, 1 AS n FROM meta" }, /m\.yaml: query/],
    ["a query that does not prepare", { query: "SELECT nope AS bucket, 1 AS value, 1 AS n FROM events" }, /m\.yaml: query/],
    ["a query with two columns", { query: "SELECT kind AS bucket, count(*) AS value FROM events GROUP BY kind" }, /m\.yaml: query/],
  ] as [string, Record<string, unknown>, RegExp][])("rejects %s, naming the file and key", (_n, over, re) => {
    expect(load({ m: good(over) })).toThrow(re);
  });

  it("keeps a replaced metric until 28 days after the replacement's introduced date", () => {
    const withNew = { new: good({ name: "new", replaces: "m", introduced: "2026-10-20", rationale: "n".repeat(210) }) };
    expect(load(withNew, "2026-10-28")).toThrow(/new\.yaml: replaces: m must keep running/);
    expect(load(withNew, "2026-11-20")).not.toThrow();
    expect(load({ m: good(), ...withNew }, "2026-10-28")).not.toThrow();
  });

  it("rejects a replacement whose rationale is unchanged", () => {
    expect(load({ m: good(), new: good({ name: "new", replaces: "m", introduced: "2026-10-20" }) }, "2026-10-28")).toThrow(/new\.yaml: rationale: unchanged/);
  });
});

describe("the report's statuses (AC-7, AC-9)", () => {
  const defs = (retired?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "metric-status-"));
    mkdirSync(dir, { recursive: true });
    const w = (d: Record<string, unknown>) => writeFileSync(join(dir, `${d.name}.yaml`), JSON.stringify(d));
    w(good({ name: "old", introduced: "2026-09-01", ...(retired ? { retired } : {}) }));
    w(good({ name: "new", replaces: "old", introduced: "2026-10-20", rationale: "n".repeat(210) }));
    w(good({ name: "gone", introduced: "2026-01-01", retired: "2026-06-01" }));
    return loadMetricDefinitions(dir, new Date("2026-10-28"));
  };
  it("marks the old metric replaced with the days left, and leaves a retired one out unless asked", async () => {
    const p = await fixtureState();
    const db = openIndex(p, { readOnly: true });
    const today = new Date("2026-10-28");
    const report = computeMetrics(db, defs(), { from: new Date("2026-10-05"), to: today, today });
    expect(report.metrics.map((m) => m.name).sort()).toEqual(["new", "old"]);
    expect(report.metrics.find((m) => m.name === "old")).toMatchObject({ status: "replaced", replaced_by: "new", overlap_days_left: 20 });
    expect(report.metrics.find((m) => m.name === "new")!.status).toBe("active");
    const all = computeMetrics(db, defs(), { from: new Date("2026-10-05"), to: today, today, includeRetired: true });
    expect(all.metrics.find((m) => m.name === "gone")!.status).toBe("retired");
    db.close();
  });
});

describe("post_merge_defects cites #<pr> not followed by a digit (AC-2)", () => {
  const filed = (n: number, body: string) => ({ number: n, by: "bot", class: "class:bug", labels: ["class:bug"], marker: "m", body });
  async function count(pr: number, body: string, daysAfter = 3) {
    const p = statePaths(mkdtempSync(join(tmpdir(), "metrics-cite-")));
    await ensureStateDirs(p);
    await record(p, "merge", "2026-10-01T00:00:00.000Z", { issue: 1, pr, cls: "feature", work: "product", at: "2026-10-01T00:00:00.000Z" }, { issue: 1 });
    await record(p, "issue.filed", new Date(Date.parse("2026-10-01T00:00:00Z") + daysAfter * 86_400_000), filed(9, body), { issue: 9 });
    const db = openIndex(p, { readOnly: true });
    const report = computeMetrics(db, seeds, { from: new Date("2026-09-28"), to: new Date("2026-11-20"), names: ["post_merge_defects"] });
    db.close();
    return report.metrics[0]!.buckets.reduce((a, b) => a + (b.value ?? 0), 0);
  }
  it("does not match #12 against a merge of PR 123", async () => expect(await count(123, "Regression, see #12.")).toBe(0));
  it("does not match #1234 against PR 123", async () => expect(await count(123, "see #1234 here")).toBe(0));
  it.each(["see #123", "see #123.", "(#123)", "#123: broken", "x\n#123\n"])("matches %j against PR 123", async (b) => expect(await count(123, b)).toBe(1));
  it("does not count a citation of a PR merged more than 30 days before", async () => expect(await count(123, "see #123", 40)).toBe(0));
});

describe("the commands (AC-6)", () => {
  async function cli(args: string[]) {
    const p = await fixtureState();
    const config = join(p.root, "cli-config.json");
    writeFileSync(config, JSON.stringify({ ...loadConfig(defaultConfigPath), state_dir: p.root }));
    const run = (a: string[]) => execFileSync(process.execPath, [join(agentsDir, "..", "tools", "scheduler", "bin", "scheduler.ts"), ...a, "--config", config], { encoding: "utf8" });
    return { p, run: () => run(args), runOther: run };
  }
  it("prints the report as JSON, records one snapshot with --snapshot, and queries read-only", async () => {
    const { p, runOther } = await cli([]);
    const report = JSON.parse(runOther(["metrics", "--json", "--snapshot", "--weeks", "52"]));
    expect(report.metrics.map((m: { name: string }) => m.name)).toHaveLength(9);
    expect(validate("metrics-report", report)).toEqual({ ok: true });
    const rows = runOther(["events", "query", "SELECT count(*) AS c FROM events WHERE kind = 'metrics.snapshot'"]).trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([{ c: 2 }]); // the fixture's own snapshot and this one
    expect(runOther(["metrics", "--weeks", "4"])).toMatch(/metric\s+goal\s+status\s+week\s+value\s+n/);
    expect(JSON.parse(runOther(["metrics", "show", "merged_per_week"])).history[0].bucket).toBe("2026-09-14");
    expect(() => runOther(["events", "query", "DELETE FROM events"])).toThrow();
    expect(() => runOther(["events", "query", "SELECT 1; SELECT 2"])).toThrow();
    expect(readdirSync(p.events).filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThan(0);
  }, 60_000);
});
