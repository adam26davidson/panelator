import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { StatePaths } from "../state/paths.ts";

/** Bump to make every existing index rebuild from the JSONL (spec 012 AC-3). */
export const INDEX_SCHEMA_VERSION = 1;

export interface IndexOptions {
  /** Called once per file with a line that fails to parse (the service log). */
  log?: (rec: Record<string, unknown>) => void;
  readOnly?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at TEXT, kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS events_kind_at ON events(kind, at);
CREATE INDEX IF NOT EXISTS events_issue ON events(issue);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
`;

function tryOpen(path: string): DatabaseSync | null {
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (row && Number(row.value) >= INDEX_SCHEMA_VERSION) return db;
    db.close();
  } catch {
    /* missing table, corrupt file: rebuilt below */
  }
  return null;
}

function removeIndex(path: string): void {
  for (const f of [path, path + "-journal", path + "-wal", path + "-shm"]) if (existsSync(f)) unlinkSync(f);
}

/** Loads the complete lines of `file` past `from`; returns the new offset. A torn last line is left for the next call. */
function loadFile(db: DatabaseSync, file: string, from: number, name: string, log?: IndexOptions["log"]): number {
  const size = statSync(file).size;
  if (size <= from) return from;
  const buf = Buffer.alloc(size - from);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  const end = buf.lastIndexOf(10) + 1;
  if (end === 0) return from;
  const insert = db.prepare("INSERT OR IGNORE INTO events(id, at, kind, issue, run_id, agent, payload) VALUES (?,?,?,?,?,?,?)");
  let bad = 0;
  db.exec("BEGIN");
  try {
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (typeof e.id !== "string" || typeof e.at !== "string" || typeof e.kind !== "string") throw new Error("not an event");
        insert.run(e.id, e.at, e.kind, typeof e.issue === "number" ? e.issue : null, typeof e.run_id === "string" ? e.run_id : null, typeof e.agent === "string" ? e.agent : null, JSON.stringify(e.payload ?? {}));
      } catch {
        bad++;
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)").run(`offset:${name}`, String(from + end));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (bad) {
    const prior = Number((db.prepare("SELECT value FROM meta WHERE key=?").get(`bad:${name}`) as { value: string } | undefined)?.value ?? 0);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)").run(`bad:${name}`, String(prior + bad));
    if (prior === 0) log?.({ kind: "events-bad-lines", file: name, count: bad });
  }
  return from + end;
}

function sync(paths: StatePaths, opts: IndexOptions): DatabaseSync {
  mkdirSync(paths.events, { recursive: true });
  let db = existsSync(paths.eventsIndex) ? tryOpen(paths.eventsIndex) : null;
  if (!db) {
    removeIndex(paths.eventsIndex);
    db = new DatabaseSync(paths.eventsIndex);
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(SCHEMA);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(INDEX_SCHEMA_VERSION));
  }
  const files = existsSync(paths.events) ? readdirSync(paths.events).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() : [];
  for (const name of files) {
    const row = db.prepare("SELECT value FROM meta WHERE key=?").get(`offset:${name}`) as { value: string } | undefined;
    loadFile(db, join(paths.events, name), Number(row?.value ?? 0), name, opts.log);
  }
  return db;
}

/**
 * Spec 012 AC-3: loads every line not yet loaded, then returns the database. A missing, unopenable or older index is
 * deleted and rebuilt in full; the JSONL is never touched. With `readOnly` the sync connection is closed and the
 * returned one cannot write (metrics and `events query`).
 */
export function openIndex(paths: StatePaths, opts: IndexOptions = {}): DatabaseSync {
  const db = sync(paths, opts);
  if (!opts.readOnly) return db;
  db.close();
  const ro = new DatabaseSync(paths.eventsIndex, { readOnly: true });
  ro.exec("PRAGMA busy_timeout=5000");
  return ro;
}

/** Number of unparsable lines the index has skipped, per file. */
export function badLines(db: DatabaseSync): Record<string, number> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'bad:%'").all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key.slice(4), Number(r.value)]));
}
