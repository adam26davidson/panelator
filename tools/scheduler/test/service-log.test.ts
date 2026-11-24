import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_QUEUE_MAX, ServiceLog } from "../src/service/log.ts";
import { readJsonLines } from "../src/state/jsonl.ts";

const dir = () => mkdtempSync(join(tmpdir(), "panelator-test-slog-"));
const lines = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("ServiceLog (spec 114 AC-1)", () => {
  it("keeps records through failed appends and writes them in order with their own times", () => {
    const path = join(dir(), "log", "s.jsonl");
    let failures = 3;
    const err: string[] = [];
    const log = new ServiceLog(path, { append: (p, t) => { if (failures-- > 0) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }); appendFileSync(p, t); }, stderr: (l) => err.push(l) });
    log.write({ kind: "a", at: "2026-01-01T00:00:01Z" });
    log.write({ kind: "b", at: "2026-01-01T00:00:02Z" });
    log.write({ kind: "c", at: "2026-01-01T00:00:03Z" });
    log.write({ kind: "d", at: "2026-01-01T00:00:04Z" });
    expect(lines(path).map((r) => [r.kind, r.at])).toEqual([["a", "2026-01-01T00:00:01Z"], ["b", "2026-01-01T00:00:02Z"], ["c", "2026-01-01T00:00:03Z"], ["d", "2026-01-01T00:00:04Z"]]);
    expect(err).toHaveLength(3);
    expect(err[0]).toMatch(/^service-log unwritten: \{/);
  });

  it("a torn fragment does not swallow the next record", async () => {
    const path = join(dir(), "s.jsonl");
    appendFileSync(path, '{"kind":"torn"');
    let fail = true;
    const log = new ServiceLog(path, { append: (p, t) => { if (fail) { fail = false; throw new Error("x"); } appendFileSync(p, t); }, stderr: () => {} });
    log.write({ kind: "after" });
    log.write({ kind: "after2" });
    let skipped = 0;
    const read = await readJsonLines<{ kind: string }>(path, { onSkipped: (r) => { skipped += r.skipped; } });
    expect(skipped).toBe(1);
    expect(read.map((r) => r.kind)).toEqual(["after", "after2"]);
  });

  it("bounds the queue and records the drop", () => {
    const path = join(dir(), "s.jsonl");
    let fail = true;
    const log = new ServiceLog(path, { append: (p, t) => { if (fail) throw new Error("x"); appendFileSync(p, t); }, stderr: () => {} });
    for (let i = 0; i < LOG_QUEUE_MAX + 3; i++) log.write({ kind: "r", i, at: `t${i}` });
    fail = false;
    log.write({ kind: "last", at: "tz" });
    const rows = lines(path);
    expect(rows.filter((r) => r.kind === "r")).toHaveLength(LOG_QUEUE_MAX - 1);
    const dropped = rows.find((r) => r.kind === "service-log-dropped")!;
    expect(dropped).toMatchObject({ count: 4, from: "t0", to: "t3" });
  });

  it("stopped() with a failing append does not throw", () => {
    const log = new ServiceLog(join(dir(), "s.jsonl"), { append: () => { throw new Error("x"); }, stderr: () => {} });
    expect(() => log.stopped("SIGTERM")).not.toThrow();
  });
});
