import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseJsonLine, readJsonLines, readRecentJsonLines } from "../src/state/jsonl.ts";
import { JsonlSplitter, readJsonlFile } from "../src/adapters/jsonl.ts";

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

describe("state reader (spec 103)", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "jsonl-state-"));
  const NUL = "\u0000";
  const seven = ['{"n":1}', NUL.repeat(40), NUL.repeat(7) + '{"n":2}', '{"at":"2026-11-13T2', "", "42", '{"n":3}'].join("\n") + "\n";
  it("parses a line, stripping leading NULs, and requires an object", () => {
    expect(parseJsonLine(NUL + '{"a":1}')).toEqual({ ok: true, value: { a: 1 }, recovered: true });
    expect(parseJsonLine('{"a":1}')).toMatchObject({ ok: true, recovered: false });
    for (const bad of [NUL.repeat(3), "42", "null", "[1]", '{"a":', '{"a":1}x']) expect(parseJsonLine(bad)).toEqual({ ok: false });
  });
  it("skips torn lines, recovers a NUL-prefixed one, and reports once with byte offsets and line numbers", async () => {
    const f = join(dir(), "a.jsonl");
    writeFileSync(f, seven);
    const logged: Record<string, unknown>[] = [];
    expect(await readJsonLines(f, { log: (r) => logged.push(r) })).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(logged).toEqual([{ kind: "jsonl-skipped-lines", file: f, skipped: 3, recovered: 1, offsets: [8, 49, 64, 85], lines: [2, 3, 4, 6] }]);
    expect(await readJsonLines(f)).toHaveLength(3);
  });
  it("positional keeps a hole at each skipped or empty line", async () => {
    const f = join(dir(), "a.jsonl");
    writeFileSync(f, seven);
    expect(await readJsonLines(f, { positional: true })).toEqual([{ n: 1 }, undefined, { n: 2 }, undefined, undefined, undefined, { n: 3 }]);
  });
  it("returns [] for a missing file and throws on another read error", async () => {
    expect(await readJsonLines(join(dir(), "none"))).toEqual([]);
    await expect(readJsonLines(dir())).rejects.toThrow();
  });
  it("writes nothing for a clean file and caps offsets at 10", async () => {
    const f = join(dir(), "a.jsonl"), logged: unknown[] = [];
    writeFileSync(f, '{"a":1}\n');
    await readJsonLines(f, { log: (r) => logged.push(r) });
    expect(logged).toEqual([]);
    writeFileSync(f, (NUL + "\n").repeat(15));
    const got: unknown[] = [];
    await readJsonLines(f, { log: (r) => got.push(r) });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ skipped: 15, offsets: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18], lines: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  });
  describe("readRecentJsonLines", () => {
    const base = Date.parse("2026-11-10T00:00:00Z"), cutoff = new Date(base + 9 * 86400000).toISOString();
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ at: new Date(base + i * 864000).toISOString(), kind: "tick", i, pad: "é".repeat(20) }));
    const withTorn = [...lines.slice(0, 50), NUL.repeat(30), ...lines.slice(50, 990), NUL.repeat(5) + '{"at":"x"', ...lines.slice(990)];
    it("equals the strict day filter over ten days, reporting only the recent torn line", async () => {
      const f = join(dir(), "s.jsonl");
      writeFileSync(f, withTorn.join("\n") + "\n");
      const logged: Record<string, unknown>[] = [];
      const got = await readRecentJsonLines<{ at: string; i: number }>(f, cutoff, { chunkBytes: 4096, log: (r) => logged.push(r) });
      expect(got.map((r) => r.i)).toEqual(lines.map((l) => JSON.parse(l)).filter((r) => Date.parse(r.at) >= Date.parse(cutoff)).map((r) => r.i));
      expect(logged).toHaveLength(1);
      const off = Buffer.byteLength(withTorn.slice(0, 991).join("\n") + "\n");
      expect(logged[0]).toMatchObject({ skipped: 1, recovered: 0, offsets: [off] });
      expect(logged[0]).not.toHaveProperty("lines");
    });
    it("handles a small file, an empty file and no file", async () => {
      const f = join(dir(), "s.jsonl");
      writeFileSync(f, lines.slice(0, 5).join("\n"));
      expect(await readRecentJsonLines(f, lines[0] ? JSON.parse(lines[2]!).at : "")).toHaveLength(3);
      writeFileSync(f, "");
      expect(await readRecentJsonLines(f, cutoff)).toEqual([]);
      expect(await readRecentJsonLines(join(dir(), "none"), cutoff)).toEqual([]);
    });
    it("skips and counts a record without a parseable at, and recovers a NUL-prefixed one", async () => {
      const f = join(dir(), "s.jsonl"), logged: Record<string, unknown>[] = [];
      writeFileSync(f, ['{"kind":"x"}', NUL + '{"at":"2026-11-10T00:00:00Z","k":1}'].join("\n") + "\n");
      expect(await readRecentJsonLines(f, "2026-11-01T00:00:00Z", { log: (r) => logged.push(r) })).toEqual([{ at: "2026-11-10T00:00:00Z", k: 1 }]);
      expect(logged[0]).toMatchObject({ skipped: 1, recovered: 1 });
    });
    it("pins the chunk rule: a newer record in an earlier chunk is returned only if its chunk was read", async () => {
      const old = (i: number) => JSON.stringify({ at: "2026-01-01T00:00:00Z", i, p: "x".repeat(60) });
      const fresh = (i: number) => JSON.stringify({ at: "2026-11-01T00:00:00Z", i, p: "x".repeat(60) });
      const f = join(dir(), "s.jsonl");
      // The chunk holding the clock-back record also holds a fresh one after it: read.
      writeFileSync(f, [fresh(0), ...[1, 2, 3, 4, 5, 6].map(old), fresh(7), fresh(8)].join("\n") + "\n");
      const got = await readRecentJsonLines<{ i: number; at: string }>(f, "2026-06-01T00:00:00Z", { chunkBytes: 100 });
      expect(got.map((r) => r.i)).toEqual([7, 8]);
      writeFileSync(f, [fresh(0), ...[1, 2, 3, 4, 5, 6].map(old)].join("\n") + "\n");
      expect((await readRecentJsonLines<{ i: number; at: string }>(f, "2026-06-01T00:00:00Z", { chunkBytes: 100 })).map((r) => r.i)).toEqual([]);
      writeFileSync(f, [...[1, 2].map(old), fresh(3)].join("\n") + "\n");
      expect((await readRecentJsonLines<{ i: number; at: string }>(f, "2026-06-01T00:00:00Z", { chunkBytes: 100 })).map((r) => r.i)).toEqual([3]);
    });
    it("parses a line that straddles two chunks once, whole", async () => {
      const f = join(dir(), "s.jsonl");
      const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ at: "2026-11-10T00:00:00Z", i, p: "é".repeat(i + 1) }));
      writeFileSync(f, rows.join("\n") + "\n");
      for (const chunkBytes of [7, 50, 101]) expect((await readRecentJsonLines<{ i: number; at: string }>(f, "2026-11-01T00:00:00Z", { chunkBytes })).map((r) => r.i)).toEqual(rows.map((_, i) => i));
    });
  });
});
