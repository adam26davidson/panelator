import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ServiceLog } from "../service/log.ts";
import type { StatePaths } from "../state/paths.ts";

export const INDEX_SCHEMA_VERSION = "1";
/** Every connection waits this long for a lock (#82): the service and the laptop commands open the same file, and a load is a write. */
export const BUSY_TIMEOUT_MS = 30_000;
export const EVENTS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at TEXT, kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT)";

type Log = (rec: Record<string, unknown>) => void;

const connect = (paths: StatePaths, readOnly = false) => new DatabaseSync(paths.eventsIndex, { timeout: BUSY_TIMEOUT_MS, readOnly });

function createSchema(db: DatabaseSync): void {
  db.exec(`${EVENTS_TABLE_SQL};
    CREATE INDEX IF NOT EXISTS events_kind_at ON events(kind, at);
    CREATE INDEX IF NOT EXISTS events_issue ON events(issue);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);`);
}

function removeIndex(paths: StatePaths): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { unlinkSync(paths.eventsIndex + suffix); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

/** A lock that outlasted the busy timeout is the caller's I/O failure, not a damaged file. */
const isBusy = (e: unknown) => [5, 6].includes((e as { errcode?: number }).errcode ?? 0) || /locked|busy/i.test((e as Error).message);

/** Creates the tables, or drops and recreates them when they carry an older schema version, in one transaction. */
function prepare(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (row?.value !== INDEX_SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS events; DELETE FROM meta");
      createSchema(db);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(INDEX_SCHEMA_VERSION);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Loads one monthly file past its stored offset in its own transaction; the offset advances only past complete lines. */
function loadFile(db: DatabaseSync, paths: StatePaths, f: string, log: Log): void {
  const path = join(paths.events, f);
  const key = `offset:${f}`;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Read inside the transaction, so a racing loader that got here first leaves nothing for this one.
    let offset = Number((db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? 0);
    const size = statSync(path).size;
    if (offset > size) offset = 0;
    if (offset === size) { db.exec("COMMIT"); return; }
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    let read: number;
    try { read = readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const end = buf.subarray(0, read).lastIndexOf(10) + 1;
    const insert = db.prepare("INSERT OR IGNORE INTO events(id, at, kind, issue, run_id, agent, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let skipped = 0;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { id: string; at: string; kind: string; issue?: number; run_id?: string; agent?: string; payload: unknown };
        if (typeof e.id !== "string" || typeof e.at !== "string" || typeof e.kind !== "string") throw new Error("not an event");
        insert.run(e.id, e.at, e.kind, e.issue ?? null, e.run_id ?? null, e.agent ?? null, JSON.stringify(e.payload ?? {}));
      } catch { skipped++; }
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, String(offset + end));
    db.exec("COMMIT");
    if (skipped) log({ kind: "events-index-skipped-lines", file: f, count: skipped });
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

function load(db: DatabaseSync, paths: StatePaths, log: Log): void {
  const files = existsSync(paths.events) ? readdirSync(paths.events).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() : [];
  for (const f of files) loadFile(db, paths, f, log);
}

/** The derived index (spec 026 AC-3): loads what is new, rebuilding it in full when missing or unreadable and reloading it when of an older version. */
export function openIndex(paths: StatePaths, opts: { readOnly?: boolean; log?: Log } = {}): DatabaseSync {
  mkdirSync(paths.events, { recursive: true });
  // Without a caller's log, skipped lines still reach the service log (AC-3).
  const log: Log = opts.log ?? ((rec) => new ServiceLog(paths.serviceLog).write(rec));
  let db: DatabaseSync | null = null;
  try {
    db = connect(paths);
    prepare(db);
  } catch (e) {
    try { db?.close(); } catch { /* unreadable */ }
    db = null;
    if (isBusy(e)) throw e;
    removeIndex(paths);
    db = connect(paths);
    prepare(db);
  }
  try {
    load(db, paths, log);
  } catch (e) {
    db.close();
    throw e;
  }
  if (!opts.readOnly) return db;
  db.close();
  return connect(paths, true);
}
