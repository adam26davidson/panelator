import { closeSync, existsSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatePaths } from "../state/paths.ts";

export const INDEX_SCHEMA_VERSION = "1";
export const EVENTS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at TEXT, kind TEXT, issue INTEGER, run_id TEXT, agent TEXT, payload TEXT)";

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

/** Loads lines past the stored offset of each monthly file; the offset advances only past complete lines. */
function load(db: DatabaseSync, paths: StatePaths, log?: (rec: Record<string, unknown>) => void): void {
  const getOffset = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setOffset = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  const insert = db.prepare("INSERT OR IGNORE INTO events(id, at, kind, issue, run_id, agent, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const files = existsSync(paths.events) ? readdirSync(paths.events).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort() : [];
  for (const f of files) {
    const path = join(paths.events, f);
    const size = statSync(path).size;
    const key = `offset:${f}`;
    let offset = Number((getOffset.get(key) as { value: string } | undefined)?.value ?? 0);
    if (offset > size) offset = 0;
    if (offset === size) continue;
    const buf = Buffer.alloc(size - offset);
    const fd = openSync(path, "r");
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    const end = buf.lastIndexOf(10) + 1;
    let skipped = 0;
    db.exec("BEGIN");
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { id: string; at: string; kind: string; issue?: number; run_id?: string; agent?: string; payload: unknown };
        if (typeof e.id !== "string" || typeof e.at !== "string" || typeof e.kind !== "string") throw new Error("not an event");
        insert.run(e.id, e.at, e.kind, e.issue ?? null, e.run_id ?? null, e.agent ?? null, JSON.stringify(e.payload ?? {}));
      } catch { skipped++; }
    }
    setOffset.run(key, String(offset + end));
    db.exec("COMMIT");
    if (skipped) log?.({ kind: "events-index-skipped-lines", file: f, count: skipped });
  }
}

/** The derived index (spec 012 AC-3): loads what is new, rebuilding it in full when missing, unreadable or of an older version. */
export function openIndex(paths: StatePaths, opts: { readOnly?: boolean; log?: (rec: Record<string, unknown>) => void } = {}): DatabaseSync {
  mkdirSync(paths.events, { recursive: true });
  let db: DatabaseSync | null = null;
  try {
    if (existsSync(paths.eventsIndex)) {
      db = new DatabaseSync(paths.eventsIndex);
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (row?.value !== INDEX_SCHEMA_VERSION) throw new Error("schema version");
      db.prepare("SELECT count(*) FROM events").get();
    }
  } catch {
    try { db?.close(); } catch { /* unreadable */ }
    db = null;
    removeIndex(paths);
  }
  if (!db) {
    removeIndex(paths);
    db = new DatabaseSync(paths.eventsIndex);
    createSchema(db);
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(INDEX_SCHEMA_VERSION);
  }
  load(db, paths, opts.log);
  if (!opts.readOnly) return db;
  db.close();
  return new DatabaseSync(paths.eventsIndex, { readOnly: true });
}
