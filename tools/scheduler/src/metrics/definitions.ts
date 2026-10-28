import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { EVENTS_TABLE_SQL } from "../events/index.ts";
import { validate } from "../schema/validate.ts";

export const GOALS = ["speed", "delivery", "quality", "spend", "autonomy"] as const;
export const OVERLAP_DAYS = 28;

export interface MetricDefinition {
  name: string;
  goal: (typeof GOALS)[number];
  description: string;
  unit: string;
  direction: "lower" | "higher";
  introduced: string;
  rationale: string;
  query: string;
  replaces?: string;
  retired?: string;
}

/** Blanks out string literals so the statement checks see only SQL text. */
const withoutLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

/** One `SELECT` (or `WITH ... SELECT`), no second statement, no SQLite internals (spec 012 AC-5, AC-10). Throws naming the reason. */
export function assertReadOnlySelect(sql: string): void {
  const bare = withoutLiterals(sql).trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(bare)) throw new Error("must be a single SELECT (or WITH ... SELECT)");
  if (bare.includes(";")) throw new Error("must be a single statement");
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|reindex)\b/i.test(bare)) throw new Error("must only read");
  if (/sqlite_|\bmeta\b/i.test(bare)) throw new Error("may read only the events table");
}

const day = (s: string) => Date.parse(`${s}T00:00:00Z`);

function checkQuery(query: string): void {
  assertReadOnlySelect(query);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(EVENTS_TABLE_SQL);
    const st = db.prepare(query);
    st.setAllowUnknownNamedParameters(true);
    const cols = st.columns().map((c) => c.name);
    if (cols.length !== 3 || cols[0] !== "bucket" || cols[1] !== "value" || cols[2] !== "n") throw new Error(`must return the columns bucket, value, n (got ${cols.join(", ")})`);
    st.all({ from: "0000", to: "9999" });
  } finally {
    db.close();
  }
}

/** Loads and checks `agents/metrics/*.yaml`; every failure names the file and the key (AC-5, AC-7, AC-8). */
export function loadMetricDefinitions(dir: string, today: Date = new Date()): Record<string, MetricDefinition> {
  const out: Record<string, MetricDefinition> = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    const fail = (key: string, msg: string): never => { throw new Error(`${join(dir, f)}: ${key}: ${msg}`); };
    let raw: unknown;
    try { raw = parse(readFileSync(join(dir, f), "utf8")); } catch (e) { return fail("file", (e as Error).message); }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("file", "must be a mapping");
    const def = raw as MetricDefinition;
    const v = validate("metric-definition", def);
    if (!v.ok) {
      const e = v.errors[0]!;
      const key = /additionalProperty":"(\w+)"/.exec(e)?.[1] ?? /missingProperty":"(\w+)"/.exec(e)?.[1] ?? e.split(" ")[0]!.replace(/^\//, "");
      fail(key, v.errors.join("; "));
    }
    if (def.name !== f.slice(0, -5)) fail("name", "must equal the file name");
    try { checkQuery(def.query); } catch (e) { fail("query", (e as Error).message); }
    out[def.name] = def;
  }
  for (const def of Object.values(out)) {
    if (!def.replaces) continue;
    const old = out[def.replaces];
    if (!old) {
      if (today.getTime() < day(def.introduced) + OVERLAP_DAYS * 86_400_000) throw new Error(`${join(dir, def.name + ".yaml")}: replaces: ${def.replaces} must keep running until ${OVERLAP_DAYS} days after ${def.introduced}`);
      continue;
    }
    if (old.rationale.trim() === def.rationale.trim()) throw new Error(`${join(dir, def.name + ".yaml")}: rationale: unchanged from ${def.replaces}; say why the metric changed`);
  }
  return out;
}
