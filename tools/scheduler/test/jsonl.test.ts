import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlSplitter, readJsonlFile } from "../src/adapters/jsonl.ts";
import { parseJsonLine, readJsonLines, readRecentJsonLines, type SkippedLines } from "../src/state/jsonl.ts";

const fx = (n: string) => join(import.meta.dirname, "fixtures", "streams", n);

describe("JsonlSplitter", () => {
  it("splits on LF across chunk boundaries and strips CR", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"a":1}\r\n{"b"')).toEqual([{ a: 1 }]);
    expect(s.push(':2}\n')).toEqual([{ b: 2 }]);
    expect(s.end()).toEqual({ records: [], malformed: [] });
  });
  it("does not split on unicode line separators inside strings", () => {
    const s = new JsonlSplitter();
    expect(s.push('{"t":"a b"}\n')).toEqual([{ t: "a b" }]);
  });
  it("decodes a multi-byte UTF-8 character split across chunks", () => {
    const s = new JsonlSplitter();
    const b = Buffer.from('{"t":"é"}\n');
    expect([b[6], b[7]]).toEqual([0xc3, 0xa9]);
    const records = [...s.push(b.subarray(0, 7)), ...s.push(b.subarray(7))];
    expect(records).toEqual([{ t: "é" }]);
    expect(s.end()).toEqual({ records: [], malformed: [] });
  });
  it("reports a malformed tail without throwing (review focus 5)", async () => {
    const r = await readJsonlFile(fx("claude-partial-tail.jsonl"));
    expect(r.records).toHaveLength(2);
    expect(r.malformed).toHaveLength(1);
    expect(r.malformed[0]).toContain('"id":"m2"');
  });
  it("reads a complete fixture", async () => {
    const r = await readJsonlFile(fx("pi-success.jsonl"));
    expect(r.records).toHaveLength(12);
    expect(r.malformed).toEqual([]);
  });
});

// Spec 103 AC-1, AC-2, AC-6: the tolerant reader.
const NUL = "\u0000".repeat(8);
const tmp = (rows: string[], tail = "\n") => { const p = join(mkdtempSync(join(tmpdir(), "jsonl-")), "f.jsonl"); writeFileSync(p, rows.join("\n") + tail); return p; };
const rec = (i: number, at = "2026-11-13T00:00:00.000Z") => JSON.stringify({ i, at });
type R = { i: number; at: string };

describe("readJsonLines", () => {
  const rows = [rec(1), NUL, NUL + rec(2), '{"at":"2026-11-13T2', "", "42", rec(3)];
  it("keeps valid and recovered records in order and skips torn lines", async () => {
    const p = tmp(rows);
    expect((await readJsonLines<R>(p)).map((r) => r.i)).toEqual([1, 2, 3]);
    const pos = await readJsonLines<R>(p, { positional: true });
    expect(pos).toHaveLength(7);
    expect(pos.map((r) => r?.i)).toEqual([1, undefined, 2, undefined, undefined, undefined, 3]);
  });
  it("parseJsonLine accepts only a JSON object after leading NULs", () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ ok: true, value: { a: 1 }, recovered: false });
    expect(parseJsonLine(NUL + '{"a":1}')).toEqual({ ok: true, value: { a: 1 }, recovered: true });
    for (const bad of ["42", "null", "[1]", '{"a":1} x', NUL, ""]) expect(parseJsonLine(bad)).toEqual({ ok: false });
  });
  it("returns [] for a missing file and throws for another read error", async () => {
    expect(await readJsonLines(join(tmpdir(), "no-such-dir-103", "f.jsonl"))).toEqual([]);
    await expect(readJsonLines(tmpdir())).rejects.toThrow();
  });
  it("reports once with byte offsets and 1-based lines, only when something was skipped or recovered", async () => {
    const first = JSON.stringify({ i: 1, t: "é€" });
    const p = tmp([first, NUL, NUL + rec(2), '{"at":', "", "42", rec(3)]);
    const logs: Record<string, unknown>[] = [], seen: SkippedLines[] = [];
    await readJsonLines(p, { log: (r) => logs.push(r), onSkipped: (r) => seen.push(r) });
    const o1 = Buffer.byteLength(first) + 1, o2 = o1 + Buffer.byteLength(NUL) + 1, o3 = o2 + Buffer.byteLength(NUL + rec(2)) + 1;
    const expected = { file: p, skipped: 3, recovered: 1, offsets: [o1, o2, o3, o3 + Buffer.byteLength('{"at":') + 1 + 1], lines: [2, 3, 4, 6] };
    expect(logs).toEqual([{ kind: "jsonl-skipped-lines", ...expected }]);
    expect(seen).toEqual([expected]);
    const clean: Record<string, unknown>[] = [];
    await readJsonLines(tmp([rec(1), rec(2)]), { log: (r) => clean.push(r) });
    expect(clean).toEqual([]);
    expect(await readJsonLines<R>(p)).toHaveLength(3);
    await readJsonLines(p, { onSkipped: (r) => seen.push(r) });
    expect(seen).toHaveLength(2);
  });
  it("caps offsets and lines at the first ten while the counts stay complete", async () => {
    const logs: Record<string, unknown>[] = [];
    await readJsonLines(tmp(Array.from({ length: 12 }, () => NUL)), { log: (r) => logs.push(r) });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ skipped: 12, recovered: 0, lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
    expect((logs[0].offsets as number[]).length).toBe(10);
    expect((logs[0].offsets as number[])[9]).toBe(9 * (Buffer.byteLength(NUL) + 1));
  });
});

describe("readRecentJsonLines", () => {
  const T = (h: number) => new Date(Date.UTC(2026, 10, 14) - h * 3600_000).toISOString();
  const cutoff = T(24);
  const strict = (rows: R[]) => rows.filter((r) => Date.parse(r.at) >= Date.parse(cutoff));
  it("equals the strict filter over ten days, reads only the tail, and reports offsets without lines", async () => {
    const rows: R[] = Array.from({ length: 1000 }, (_, i) => ({ i, at: T(240 - i * 0.24) }));
    const out: string[] = [], offs: Record<string, number> = {};
    let size = 0;
    for (const [k, r] of rows.entries()) {
      if (k === 10) { offs.old = size; out.push(NUL); size += NUL.length + 1; }
      if (k === 995) { offs.recent = size; out.push(NUL + "{torn"); size += NUL.length + 6 + 1; }
      const l = JSON.stringify(r); out.push(l); size += l.length + 1;
    }
    const p = tmp(out);
    const logs: Record<string, unknown>[] = [];
    const got = await readRecentJsonLines<R>(p, cutoff, { chunkBytes: 4096, log: (r) => logs.push(r) });
    expect(got).toEqual(strict(rows));
    expect(got.length).toBeGreaterThan(50);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: "jsonl-skipped-lines", file: p, skipped: 1, recovered: 0, offsets: [offs.recent] });
    expect("lines" in logs[0]).toBe(false);
  });
  it("equals the whole-file filter for a small, an empty and a missing file", async () => {
    const rows: R[] = [{ i: 1, at: T(30) }, { i: 2, at: T(1) }];
    expect(await readRecentJsonLines<R>(tmp(rows.map((r) => JSON.stringify(r))), cutoff)).toEqual(strict(rows));
    expect(await readRecentJsonLines<R>(tmp([], ""), cutoff)).toEqual([]);
    expect(await readRecentJsonLines<R>(join(tmpdir(), "no-such-dir-103", "f"), cutoff)).toEqual([]);
  });
  it("returns each record once whatever the chunk size, and reports nothing for a clean file", async () => {
    const rows: R[] = Array.from({ length: 40 }, (_, i) => ({ i, at: T(1) }));
    const p = tmp(rows.map((r) => JSON.stringify(r)));
    for (const chunkBytes of [7, 50, 101, 4096]) {
      const logs: Record<string, unknown>[] = [];
      expect(await readRecentJsonLines<R>(p, cutoff, { chunkBytes, log: (r) => logs.push(r) })).toEqual(rows);
      expect(logs).toEqual([]);
    }
  });
  it("recovers a record behind a NUL block longer than a chunk, once", async () => {
    const logs: Record<string, unknown>[] = [];
    const p = tmp([rec(1, T(1)), "\u0000".repeat(300) + rec(2, T(1)), rec(3, T(1))]);
    const got = await readRecentJsonLines<R>(p, cutoff, { chunkBytes: 64, log: (r) => logs.push(r) });
    expect(got.map((r) => r.i)).toEqual([1, 2, 3]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ skipped: 0, recovered: 1 });
  });
  it("keeps a newer record among older ones in a chunk that is read", async () => {
    const old = (i: number) => JSON.stringify({ i, at: T(48) }), fresh = (i: number) => JSON.stringify({ i, at: T(1) });
    // one chunk holds old, fresh, old, fresh: both fresh records are returned
    expect((await readRecentJsonLines<R>(tmp([old(1), fresh(2), old(3), fresh(4)]), cutoff, { chunkBytes: 4096 })).map((r) => r.i)).toEqual([2, 4]);
  });
  it("does not return a newer record that lies before a whole chunk of older ones", async () => {
    const old = (i: number) => JSON.stringify({ i, at: T(48) }), fresh = (i: number) => JSON.stringify({ i, at: T(1) });
    const lineLen = old(1).length + 1;
    // the chunk size holds three lines: the last chunk is all old, so the read stops before fresh(0)
    const p = tmp([fresh(0), ...[1, 2, 3, 4, 5, 6].map(old)]);
    expect(await readRecentJsonLines<R>(p, cutoff, { chunkBytes: lineLen * 3 })).toEqual([]);
  });
  it("does not stop at a chunk that holds only a torn line", async () => {
    const fresh = (i: number) => JSON.stringify({ i, at: T(1) });
    const lineLen = fresh(1).length + 1;
    const torn = "\u0000".repeat(lineLen - 1); // as long as a record, so chunks of two lines fall on line boundaries
    // the middle chunk read holds two torn lines and nothing else: it says nothing about time, the read goes on
    const p = tmp([fresh(1), fresh(2), torn, torn, torn, torn, fresh(3), fresh(4)]);
    const got = await readRecentJsonLines<R>(p, cutoff, { chunkBytes: lineLen * 2 });
    expect(got.map((r) => r.i)).toEqual([1, 2, 3, 4]);
  });
  it("skips and counts a record without a parseable at", async () => {
    const a = JSON.stringify({ i: 1 }), b = JSON.stringify({ i: 2, at: "nope" });
    const logs: Record<string, unknown>[] = [];
    const p = tmp([rec(0, T(1)), a, b, rec(3, T(1))]);
    const got = await readRecentJsonLines<R>(p, cutoff, { log: (r) => logs.push(r) });
    expect(got.map((r) => r.i)).toEqual([0, 3]);
    const o1 = rec(0, T(1)).length + 1;
    expect(logs[0]).toMatchObject({ skipped: 2, recovered: 0, offsets: [o1, o1 + a.length + 1] });
  });
});
