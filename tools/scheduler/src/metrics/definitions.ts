import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { validate } from "../schema/validate.ts";

export const GOALS = ["speed", "delivery", "quality", "spend", "autonomy"] as const;
export type MetricGoal = (typeof GOALS)[number];
export const OVERLAP_DAYS = 28;
export const RATIONALE_MIN = 200;

export interface MetricDefinition {
  name: string;
  goal: MetricGoal;
  description: string;
  unit: string;
  direction: "lower" | "higher";
  introduced: string;
  rationale: string;
  query: string;
  replaces?: string;
  retired?: string;
}

export class MetricDefinitionError extends Error {
  constructor(file: string, key: string, message: string) {
    super(`${file}: ${key}: ${message}`);
  }
}

/** Parameters a query may use; only those it names are bound. */
export function queryParams(query: string, from: string, to: string): Record<string, string> {
  return { ...(/:from\b/.test(query) ? { from } : {}), ...(/:to\b/.test(query) ? { to } : {}) };
}

const FORBIDDEN = /\b(attach|detach|pragma|insert|update|delete|drop|create|alter|replace|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;

/** Strips string literals and comments so that the keyword scan reads only SQL. */
function bare(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * AC-5: one `SELECT` (or `WITH ... SELECT`) over the `events` table of the index and nothing else. Throws the reason.
 * The table rule is checked by preparing the query against a database that holds `events` alone.
 */
export function assertSelectOnly(query: string): void {
  const text = bare(query).trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(text)) throw new Error("must be a single SELECT or WITH ... SELECT");
  if (text.includes(";")) throw new Error("must be one statement");
  const bad = FORBIDDEN.exec(text);
  if (bad) throw new Error(`may not use ${bad[1].toUpperCase()}`);
  if (/\b(sqlite_\w+|pragma_\w+)/i.test(text)) throw new Error("may read the events table only");
}

export function checkQuery(query: string): void {
  assertSelectOnly(query);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE events(id TEXT PRIMARY KEY, at TEXT, kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT)");
    let stmt;
    try {
      stmt = db.prepare(query.trim().replace(/;\s*$/, ""));
    } catch (e) {
      throw new Error(`does not prepare against an empty index: ${(e as Error).message}`);
    }
    const cols = stmt.columns().map((c) => c.name);
    if (cols.join(",") !== "bucket,value,n") throw new Error(`must return the columns bucket, value, n (got ${cols.join(", ")})`);
    stmt.all(queryParams(query, "2000-01-01", "2000-01-02"));
  } finally {
    db.close();
  }
}

const KEYS = ["name", "goal", "description", "unit", "direction", "introduced", "rationale", "query", "replaces", "retired"];

function parseOne(file: string, text: string): MetricDefinition {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new MetricDefinitionError(file, "(file)", `not YAML: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new MetricDefinitionError(file, "(file)", "expected a mapping");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!KEYS.includes(k)) throw new MetricDefinitionError(file, k, "unknown key");
  for (const k of ["name", "goal", "description", "unit", "direction", "introduced", "rationale", "query"]) if (obj[k] === undefined) throw new MetricDefinitionError(file, k, "missing");
  if (typeof obj.goal !== "string" || !(GOALS as readonly string[]).includes(obj.goal)) throw new MetricDefinitionError(file, "goal", `must be one of ${GOALS.join(", ")}`);
  const v = validate("metric-definition", obj);
  if (!v.ok) {
    const first = v.errors[0];
    const key = first.split(" ")[0].replace(/^\//, "") || "(file)";
    throw new MetricDefinitionError(file, key, v.errors.join("; "));
  }
  const def = obj as unknown as MetricDefinition;
  if (`${def.name}.yaml` !== file) throw new MetricDefinitionError(file, "name", "must equal the file name");
  try {
    checkQuery(def.query);
  } catch (e) {
    throw new MetricDefinitionError(file, "query", (e as Error).message);
  }
  return def;
}

const dayMs = 86_400_000;

/** Days of overlap left for a replaced metric, counted from the replacement's `introduced` date (AC-7). */
export function overlapDaysLeft(replacement: MetricDefinition, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(replacement.introduced) + OVERLAP_DAYS * dayMs - now.getTime()) / dayMs));
}

/** Loads `dir/*.yaml`, applying AC-5, AC-7 and AC-8; the first failure names the file and the key. */
export function loadMetricDefinitions(dir: string, opts: { today?: Date } = {}): MetricDefinition[] {
  const today = opts.today ?? new Date();
  if (!existsSync(dir)) return [];
  const defs = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort().map((f) => parseOne(f, readFileSync(join(dir, f), "utf8")));
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const d of defs) {
    if (!d.replaces) continue;
    const old = byName.get(d.replaces);
    const file = `${d.name}.yaml`;
    if (!old) {
      if (overlapDaysLeft(d, today) > 0) throw new MetricDefinitionError(file, "replaces", `${d.replaces} must keep running until 28 days after ${d.introduced}`);
      continue;
    }
    if (old.rationale.trim() === d.rationale.trim()) throw new MetricDefinitionError(file, "rationale", `unchanged from the metric it replaces (${old.name}); say why the query changed`);
  }
  return defs;
}
