import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { backfillEvents } from "../src/events/backfill.ts";
import { openIndex } from "../src/events/index.ts";
import { EVENT_KINDS } from "../src/events/kinds.ts";
import { recordEvent } from "../src/events/store.ts";
import { recordChecks } from "../src/events/ci.ts";
import { assertReadOnlySelect } from "../src/metrics/definitions.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

async function fresh() {
  const p = statePaths(mkdtempSync(join(tmpdir(), "events-")));
  await ensureStateDirs(p);
  return p;
}
const ev = (over: Record<string, unknown> = {}) => ({ at: "2026-09-15T09:00:00.000Z", kind: "slots.sample" as const, payload: { active: 1, slots: 1, chains: 1, standing: 0 }, ...over });
const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean);

describe("recordEvent (spec 012 AC-1)", () => {
  it("appends one envelope line to the month of `at` before returning", async () => {
    const p = await fresh();
    const { event } = await recordEvent(p, ev({ issue: 7 }));
    const file = join(p.events, "2026-09.jsonl");
    expect(lines(file)).toHaveLength(1);
    expect(JSON.parse(lines(file)[0]!)).toEqual({ ...ev({ issue: 7 }), id: event.id });
    await recordEvent(p, ev({ at: "2026-10-01T00:00:00.000Z" }));
    expect(existsSync(join(p.events, "2026-10.jsonl"))).toBe(true);
  });

  it("throws and writes nothing for an unknown kind or a payload that fails its schema", async () => {
    const p = await fresh();
    await expect(recordEvent(p, ev({ kind: "nope" }))).rejects.toThrow(/unknown event kind/);
    await expect(recordEvent(p, ev({ kind: "run.ended", payload: { run_id: "x" } }))).rejects.toThrow(/invalid run.ended event/);
    await expect(recordEvent(p, ev({ at: "yesterday" }))).rejects.toThrow();
    expect(readdirSync(p.events)).toEqual([]);
  });

  it("keeps the schema's kind list equal to the code's", () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "schemas", "scheduler", "event.json"), "utf8"));
    expect(schema.$defs.envelope.properties.kind.enum).toEqual([...EVENT_KINDS]);
    expect(EVENT_KINDS).toContain("aws.cost");
  });

  it("validates every fixture event against its schema", () => {
    const dir = join(import.meta.dirname, "fixtures", "events");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      for (const l of lines(join(dir, f))) expect(validate("event", JSON.parse(l)), l).toEqual({ ok: true });
    }
  });

  it("is the only code that writes under events/ (append-only grep)", () => {
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f) : f.endsWith(".ts") && files.push(f); } };
    walk(join(root, "src")); walk(join(root, "bin"));
    const paths = statePaths("/s");
    const members = Object.entries(paths).filter(([, value]) => value === "/s/events" || value.startsWith("/s/events/")).map(([key]) => key);
    expect(members.sort()).toEqual(["events", "eventsBackfilled", "eventsIndex"]);
    expect(members).not.toContain("eligibleMarks");
    const reference = new RegExp(`\\.(?:${members.join("|")})\\b|[\"'\x60]events/`);
    const unsafe = (f: string, line: string) => {
      if (!reference.test(line) || /^\s*(import|export|\/\/|\*|\/\*)/.test(line)) return false;
      // Only the index module may rebuild the derived database; only backfill may write its one-time marker.
      if (f.endsWith("src/events/index.ts") && /\b(unlinkSync|DatabaseSync)\(paths\.eventsIndex\b/.test(line)) return false;
      if (f.endsWith("src/events/backfill.ts") && /\bwriteFile\(paths\.eventsBackfilled,/.test(line)) return false;
      if (/\b(writeFile(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|truncate(?:Sync)?|rm(?:Sync)?|copyFile(?:Sync)?|DatabaseSync)\s*\(/.test(line)) return true;
      if (/\bopen(?:Sync)?\s*\(/.test(line) && !/,[ ]*["']r["']/.test(line)) return true;
      if (/\bappendFile(?:Sync)?\s*\(/.test(line)) return !f.endsWith("src/events/store.ts");
      return false; // reads, mkdir, declarations and path construction
    };
    const offenders: string[] = [];
    for (const f of files) readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (unsafe(f, line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
    // Guard the guard: derived paths are not blanket exemptions for arbitrary writers.
    for (const member of members) expect(unsafe("src/service/loop.ts", `writeFile(paths.${member}, 'oops')`)).toBe(true);
    expect(unsafe("src/service/loop.ts", "unlinkSync(paths.eventsIndex)")).toBe(true);
    expect(unsafe("src/service/loop.ts", "writeFile('events/eligible.json', '{}')")).toBe(true);
  });
});

describe("the index (AC-3)", () => {
  const seed = async (p: ReturnType<typeof statePaths>) => {
    for (let i = 0; i < 3; i++) await recordEvent(p, ev({ at: `2026-09-1${i}T09:00:00.000Z`, issue: i + 1 }));
  };
  const count = (db: ReturnType<typeof openIndex>) => (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c;

  it("loads incrementally and a torn last line is loaded once completed", async () => {
    const p = await fresh();
    await seed(p);
    let db = openIndex(p);
    expect(count(db)).toBe(3);
    db.close();
    await recordEvent(p, ev({ at: "2026-09-20T00:00:00.000Z" }));
    const file = join(p.events, "2026-09.jsonl");
    appendFileSync(file, '{"id":"torn","at":"2026-09-21T00:00:00.000Z","kind":"slots.sample","pay');
    db = openIndex(p);
    expect(count(db)).toBe(4);
    db.close();
    appendFileSync(file, 'load":{"active":0,"slots":1,"chains":0,"standing":0}}\n');
    db = openIndex(p);
    expect(count(db)).toBe(5);
    db.close();
  });

  it("reports a skipped line to the service log file when the caller passes no log", async () => {
    const p = await fresh();
    await seed(p);
    appendFileSync(join(p.events, "2026-09.jsonl"), "not json\n");
    openIndex(p).close();
    expect(readFileSync(p.serviceLog, "utf8")).toContain("events-index-skipped-lines");
  });

  it("skips a line that does not parse, reports it once and leaves the file alone", async () => {
    const p = await fresh();
    await seed(p);
    const file = join(p.events, "2026-09.jsonl");
    appendFileSync(file, "not json\n");
    const before = readFileSync(file, "utf8");
    const log: unknown[] = [];
    const db = openIndex(p, { log: (r) => log.push(r) });
    expect(count(db)).toBe(3);
    expect(log).toEqual([{ kind: "events-index-skipped-lines", file: "2026-09.jsonl", count: 1 }]);
    expect(readFileSync(file, "utf8")).toBe(before);
    db.close();
  });

  it("rebuilds a deleted, corrupt or older index with identical contents", async () => {
    const p = await fresh();
    await seed(p);
    const q = "SELECT kind, count(*) AS c, group_concat(issue) AS i FROM events GROUP BY kind";
    let db = openIndex(p);
    const before = db.prepare(q).all();
    db.close();
    for (const damage of [() => { for (const s of ["", "-wal", "-shm"]) if (existsSync(p.eventsIndex + s)) writeFileSync(p.eventsIndex + s, ""); }, () => writeFileSync(p.eventsIndex, "garbage")]) {
      damage();
      db = openIndex(p);
      expect(db.prepare(q).all()).toEqual(before);
      db.close();
    }
    db = openIndex(p);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    db.prepare("DELETE FROM events").run();
    db.close();
    db = openIndex(p);
    expect(db.prepare(q).all()).toEqual(before);
    db.close();
  });

  it("opens read-only for metrics", async () => {
    const p = await fresh();
    await seed(p);
    const db = openIndex(p, { readOnly: true });
    expect(() => db.prepare("DELETE FROM events").run()).toThrow();
    db.close();
  });
});

describe("backfill (AC-4)", () => {
  const stateWith = async () => {
    const p = await fresh();
    const src = join(import.meta.dirname, "fixtures", "events", "backfill-state");
    for (const rel of ["usage/7-plan-1-20260901T000000.json", "usage/old-shape.json", "merges.jsonl", "actions/log.jsonl", "questions/log.jsonl", "findings/queue.jsonl", "findings/triage.jsonl", "parameters/history.jsonl"]) {
      mkdirSync(dirname(join(p.root, rel)), { recursive: true });
      writeFileSync(join(p.root, rel), readFileSync(join(src, rel)));
    }
    return p;
  };
  const sizes = (p: ReturnType<typeof statePaths>) => Object.fromEntries(readdirSync(p.events).filter((f) => f.endsWith(".jsonl")).map((f) => [f, statSync(join(p.events, f)).size]));

  it("records each source once, with backfilled: true and the record's own time, and counts old shapes", async () => {
    const p = await stateWith();
    const first = await backfillEvents(p);
    expect(first.recorded).toEqual({ "run.ended": 2, merge: 1, action: 1, question: 1, "finding.queued": 1, "finding.triaged": 1, "parameter.changed": 1 });
    expect(first.old_shape).toBe(1);
    const all = readdirSync(p.events).filter((f) => f.endsWith(".jsonl")).flatMap((f) => lines(join(p.events, f)).map((l) => JSON.parse(l)));
    expect(all.every((e) => e.payload.backfilled === true)).toBe(true);
    expect(all.find((e) => e.kind === "merge").at).toBe("2026-09-17T08:00:00.000Z");
    expect(JSON.parse(readFileSync(p.eventsBackfilled, "utf8")).recorded.merge).toBe(1);
  });

  it("records nothing on a second run", async () => {
    const p = await stateWith();
    await backfillEvents(p);
    const before = sizes(p);
    const second = await backfillEvents(p);
    expect(second.recorded).toEqual({});
    expect(second.already_present).toBe(8);
    expect(sizes(p)).toEqual(before);
  });
});

describe("events query rule (AC-10)", () => {
  it("accepts one SELECT and rejects anything else", () => {
    expect(() => assertReadOnlySelect("SELECT count(*) FROM events")).not.toThrow();
    expect(() => assertReadOnlySelect("WITH x AS (SELECT 1) SELECT * FROM x;")).not.toThrow();
    for (const bad of ["DELETE FROM events", "SELECT 1; SELECT 2", "SELECT * FROM meta", "SELECT * FROM sqlite_master", "PRAGMA user_version", "UPDATE events SET kind = 'x'"]) expect(() => assertReadOnlySelect(bad), bad).toThrow();
    expect(() => assertReadOnlySelect("SELECT ';' AS x FROM events")).not.toThrow();
  });
});

describe("ci.check (AC-2)", () => {
  it("is recorded once per (sha, check, status), also after a restart", async () => {
    const p = await fresh();
    const at = new Date("2026-09-15T09:00:00Z");
    const summary = { status: "green" as const, failed: [], runs: [{ name: "test", id: 1, status: "completed", conclusion: "success" }, { name: "lint", id: 2, status: "in_progress", conclusion: null }] };
    await recordChecks(p, at, { sha: "a".repeat(40), pr: 3 }, summary as never);
    await recordChecks(p, at, { sha: "a".repeat(40), pr: 3 }, summary as never);
    // A restart loses every in-memory state; the index is what remembers.
    await recordChecks(p, at, { sha: "a".repeat(40) }, summary as never);
    await recordChecks(p, at, { sha: "b".repeat(40) }, summary as never);
    await recordChecks(p, at, { sha: "a".repeat(40) }, { ...summary, runs: [{ name: "test", id: 5, status: "completed", conclusion: "failure" }] } as never);
    const db = openIndex(p);
    expect(db.prepare("SELECT json_extract(payload, '$.sha') AS sha, json_extract(payload, '$.status') AS status FROM events WHERE kind = 'ci.check' ORDER BY rowid").all().map((r) => `${String(r.sha).slice(0, 1)}:${r.status}`)).toEqual(["a:success", "b:success", "a:failure"]);
    db.close();
  });
});
