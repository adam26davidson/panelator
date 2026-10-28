import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backfillEvents } from "../src/events/backfill.ts";
import { badLines, INDEX_SCHEMA_VERSION, openIndex } from "../src/events/index.ts";
import { EVENT_KINDS } from "../src/events/kinds.ts";
import { recordEvent } from "../src/events/store.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

async function fresh() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "events-")));
  await ensureStateDirs(paths);
  return paths;
}
const slots = { active: 1, slots: 1, chains: 1, standing: 0 };

describe("event store (AC-1)", () => {
  it("appends one enveloped line to the month of `at`", async () => {
    const paths = await fresh();
    const e = await recordEvent(paths, { kind: "slots.sample", at: "2026-10-28T10:00:00.000Z", payload: slots });
    await recordEvent(paths, { kind: "issue.claimed", at: "2026-11-02T10:00:00.000Z", issue: 5, payload: { slot: 0 } });
    expect(readdirSync(paths.events).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
    expect(JSON.parse(readFileSync(join(paths.events, "2026-10.jsonl"), "utf8"))).toEqual(e);
    expect(e.id).toMatch(/^[0-9a-f]{16}$/);
  });
  it("throws on an unknown kind, a bad payload or a bad time, and writes nothing", async () => {
    const paths = await fresh();
    await expect(recordEvent(paths, { kind: "nope" as never, payload: {} })).rejects.toThrow(/unknown event kind/);
    await expect(recordEvent(paths, { kind: "slots.sample", payload: { active: "x" } })).rejects.toThrow(/invalid slots.sample/);
    await expect(recordEvent(paths, { kind: "slots.sample", at: "yesterday", payload: slots })).rejects.toThrow(/time/);
    expect(readdirSync(paths.events)).toEqual([]);
  });
  it("names every kind in the schema and accepts aws.cost with any payload", async () => {
    const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "schemas", "scheduler", "event.json"), "utf8"));
    expect([...schema.properties.kind.enum].sort()).toEqual([...EVENT_KINDS].sort());
    await recordEvent(await fresh(), { kind: "aws.cost", payload: { usd: 1 } });
  });
  it("nothing in the scheduler source rewrites, moves or deletes under events/", () => {
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith(".ts") && files.push(join(d, f.name)); };
    walk(join(root, "src")); walk(join(root, "bin"));
    const destructive = /\b(writeFile|writeFileSync|rename|renameSync|unlink|unlinkSync|truncate|truncateSync|rm|rmSync|rmdir|copyFile|open|openSync)\s*\(/;
    const offenders: string[] = [];
    let touching = 0;
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        // Any line that names the events directory or a path derived from it.
        if (!/paths\.events\b|p\.events\b|eventFile\(/.test(l)) return;
        touching++;
        if (destructive.test(l) && !/readdirSync|mkdir/.test(l)) offenders.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(touching).toBeGreaterThan(0);
    // The index file and the backfill and eligibility markers are state of their own, not event files; they are named apart from `events`.
    expect(offenders.filter((o) => !/index\.ts|backfill\.ts/.test(o))).toEqual([]);
    // The only code that opens an event file for writing is the store, and it appends.
    const store = readFileSync(join(root, "src", "events", "store.ts"), "utf8");
    expect(store).toMatch(/appendFile\(eventFile\(/);
    expect(store).not.toMatch(/writeFile|rename|unlink|truncate/);
  });
});

describe("event index (AC-3)", () => {
  it("loads incrementally, skips a bad line once and counts it", async () => {
    const paths = await fresh();
    await recordEvent(paths, { kind: "slots.sample", at: "2026-10-01T00:00:00.000Z", payload: slots });
    const logged: Record<string, unknown>[] = [];
    let db = openIndex(paths, { log: (r) => logged.push(r) });
    expect(db.prepare("SELECT count(*) AS c FROM events").get()).toEqual({ c: 1 });
    db.close();
    appendFileSync(join(paths.events, "2026-10.jsonl"), "{not json\n");
    await recordEvent(paths, { kind: "slots.sample", at: "2026-10-02T00:00:00.000Z", payload: slots });
    db = openIndex(paths, { log: (r) => logged.push(r) });
    expect(db.prepare("SELECT count(*) AS c FROM events").get()).toEqual({ c: 2 });
    expect(badLines(db)).toEqual({ "2026-10.jsonl": 1 });
    expect(logged).toHaveLength(1);
    expect(readFileSync(join(paths.events, "2026-10.jsonl"), "utf8")).toContain("{not json");
    db.close();
    db = openIndex(paths, { log: (r) => logged.push(r) });
    expect(logged).toHaveLength(1);
    db.close();
  });
  it("rebuilds from the JSONL when the file is missing, corrupt or of an older version", async () => {
    const paths = await fresh();
    for (let i = 1; i <= 3; i++) await recordEvent(paths, { kind: "slots.sample", at: `2026-10-0${i}T00:00:00.000Z`, payload: slots });
    const count = () => { const db = openIndex(paths); const c = (db.prepare("SELECT count(*) AS c FROM events").get() as { c: number }).c; db.close(); return c; };
    expect(count()).toBe(3);
    rmSync(paths.eventsIndex);
    expect(count()).toBe(3);
    writeFileSync(paths.eventsIndex, "garbage");
    expect(count()).toBe(3);
    const db = openIndex(paths);
    db.prepare("UPDATE meta SET value='0' WHERE key='schema_version'").run();
    db.close();
    expect(count()).toBe(3);
    const after = openIndex(paths);
    expect(after.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: String(INDEX_SCHEMA_VERSION) });
    after.close();
  });
  it("the read-only connection cannot write", async () => {
    const paths = await fresh();
    const db = openIndex(paths, { readOnly: true });
    expect(() => db.exec("DELETE FROM events")).toThrow();
    db.close();
  });
});

describe("backfill (AC-4)", () => {
  it("records the earlier records once, keeps an old-shape record and counts it", async () => {
    const paths = await fresh();
    await mkdir(join(paths.root, "findings"), { recursive: true });
    writeFileSync(join(paths.usage, "7-plan-1-x.json"), JSON.stringify({ run_id: "7-plan-1-x", issue: 7, stage: "plan", attempt: 1, outcome: "ok", harness: "claude", model: "m", cost_usd: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 1, wall_seconds: 1, started_at: "2026-09-01T00:00:00.000Z", ended_at: "2026-09-01T00:10:00.000Z", events_path: "x" }));
    writeFileSync(join(paths.root, "merges.jsonl"), JSON.stringify({ issue: 7, pr: 70, cls: "debt", work: "system", at: "2026-09-02T00:00:00.000Z" }) + "\n");
    writeFileSync(paths.questionsLog, JSON.stringify({ issue: 7, at: "2026-09-01T01:00:00.000Z", event: "sent", asking_stage: "plan", question_comment_id: 3 }) + "\n");
    writeFileSync(paths.parametersHistory, JSON.stringify({ name: "slots", old: 1, new: 2, field: "value", actor: "maintainer", at: "2026-09-03T00:00:00.000Z" }) + "\n");
    // An old shape: no `field`.
    writeFileSync(paths.findingsTriage, JSON.stringify({ ref: "1", outcome: "file", reason: "r", run_id: "x", at: "2026-09-04T00:00:00.000Z" }) + "\n" + JSON.stringify({ ref: "2", at: "2026-09-04T00:00:00.000Z" }) + "\n");
    const first = await backfillEvents(paths);
    expect(first).toMatchObject({ read: 6, recorded: 6, already_present: 0, old_shape: 1 });
    expect(JSON.parse(readFileSync(paths.eventsBackfilled, "utf8")).counts.recorded).toBe(6);
    const second = await backfillEvents(paths);
    expect(second).toMatchObject({ recorded: 0, already_present: 6 });
    const db = openIndex(paths, { readOnly: true });
    expect(db.prepare("SELECT count(*) AS c FROM events").get()).toEqual({ c: 6 });
    expect(db.prepare("SELECT count(*) AS c FROM events WHERE json_extract(payload,'$.backfilled')=1").get()).toEqual({ c: 6 });
    expect(db.prepare("SELECT at FROM events WHERE kind='merge'").get()).toEqual({ at: "2026-09-02T00:00:00.000Z" });
    db.close();
  });
});
