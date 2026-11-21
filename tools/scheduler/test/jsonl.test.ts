import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseJsonLine, readJsonLines, readRecentJsonLines } from "../src/state/jsonl.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "jsonl-")), "f.jsonl");
const NUL = "\u0000";
const seven = [`{"n":1}`, NUL.repeat(5), NUL.repeat(3) + `{"n":2}`, `{"at":"2026-11-13T2`, "", "42", `{"n":3}`];

describe("parseJsonLine", () => {
  it("strips leading NULs and requires an object", () => {
    expect(parseJsonLine(`${NUL}${NUL}{"a":1}`)).toEqual({ ok: true, value: { a: 1 }, recovered: true });
    expect(parseJsonLine(`{"a":1}`)).toEqual({ ok: true, value: { a: 1 }, recovered: false });
    for (const bad of [NUL, "42", "[1]", "null", `{"a":1}x`, `{"a"`]) expect(parseJsonLine(bad)).toEqual({ ok: false });
  });
});

describe("readJsonLines (tolerant)", () => {
  it("skips torn lines, recovers a NUL-prefixed record, keeps file order", async () => {
    const f = tmp();
    writeFileSync(f, seven.join("\n") + "\n");
    expect(await readJsonLines(f)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
  it("positional keeps one slot per line", async () => {
    const f = tmp();
    writeFileSync(f, seven.join("\n") + "\n");
    const r = await readJsonLines(f, { positional: true });
    expect(r).toHaveLength(7);
    expect(r.map((x) => x !== undefined)).toEqual([true, false, true, false, false, false, true]);
  });
  it("reports once with byte offsets and 1-based lines, only when something was skipped", async () => {
    const f = tmp();
    writeFileSync(f, seven.join("\n") + "\n");
    const logged: Record<string, unknown>[] = [], got: unknown[] = [];
    await readJsonLines(f, { log: (r) => logged.push(r), onSkipped: (r) => got.push(r) });
    const o = [seven[0]!, seven[1]!, seven[2]!].reduce<number[]>((a, l) => [...a, a.at(-1)! + Buffer.byteLength(l) + 1], [0]);
    const o4 = o[3]! , o5 = o4 + Buffer.byteLength(seven[3]!) + 1, o6 = o5 + 1;
    expect(logged).toEqual([{ kind: "jsonl-skipped-lines", file: f, skipped: 3, recovered: 1, offsets: [o[1], o[2], o4, o6], lines: [2, 3, 4, 6] }]);
    expect(got).toHaveLength(1);
    const clean = tmp();
    writeFileSync(clean, `{"a":1}\n\n{"b":2}\n`);
    const none: unknown[] = [];
    expect(await readJsonLines(clean, { log: (r) => none.push(r) })).toEqual([{ a: 1 }, { b: 2 }]);
    expect(none).toEqual([]);
    expect(await readJsonLines(f)).toHaveLength(3);
  });
  it("returns [] for ENOENT and throws on other errors", async () => {
    expect(await readJsonLines(join(tmp(), "nope"))).toEqual([]);
    await expect(readJsonLines(join(tmpdir()))).rejects.toThrow();
  });
});

describe("readRecentJsonLines", () => {
  const T0 = Date.parse("2026-11-01T00:00:00Z");
  const rec = (i: number) => JSON.stringify({ at: new Date(T0 + i * 864e3).toISOString(), kind: "tick", i });
  const build = () => {
    const lines = Array.from({ length: 1000 }, (_, i) => rec(i));
    lines.splice(5, 0, NUL.repeat(40)); // first day
    lines.splice(1000, 0, NUL.repeat(10) + rec(999)); // a recovered one near the end
    lines.splice(1001, 0, NUL.repeat(7)); // torn, last hour
    return lines;
  };
  it("equals the strict filter of the whole file over the last day, never reading the old torn line", async () => {
    const f = tmp(), lines = build();
    writeFileSync(f, lines.join("\n") + "\n");
    const cutoff = new Date(T0 + 999 * 864e3 - 86400e3).toISOString();
    const strict = (await readJsonLines<{ at: string }>(f)).filter((r) => Date.parse(r.at) >= Date.parse(cutoff));
    const got: unknown[] = [];
    const r = await readRecentJsonLines<{ at: string }>(f, cutoff, { chunkBytes: 4096, onSkipped: (x) => got.push(x) });
    expect(r).toEqual(strict);
    const text = lines.join("\n");
    const recoveredOff = Buffer.byteLength(lines.slice(0, 1000).join("\n") + "\n");
    expect(got).toEqual([{ file: f, skipped: 1, recovered: 1, offsets: [recoveredOff, recoveredOff + Buffer.byteLength(lines[1000]!) + 1] }]);
    expect(text.length).toBeGreaterThan(4096 * 3);
  });
  it("handles a small file, an empty file and no file", async () => {
    const f = tmp();
    writeFileSync(f, [rec(1), NUL, rec(2)].join("\n"));
    const all = await readRecentJsonLines<{ at: string }>(f, new Date(T0 + 864e3 * 2).toISOString());
    expect(all.map((x) => x.at)).toEqual([new Date(T0 + 864e3 * 2).toISOString()]);
    writeFileSync(f, "");
    expect(await readRecentJsonLines(f, "2026-01-01T00:00:00Z")).toEqual([]);
    expect(await readRecentJsonLines(join(tmp(), "nope"), "2026-01-01T00:00:00Z")).toEqual([]);
  });
  it("parses a line that straddles two chunks once, whole", async () => {
    const f = tmp();
    const lines = Array.from({ length: 30 }, (_, i) => rec(i));
    writeFileSync(f, lines.join("\n") + "\n");
    for (const chunkBytes of [37, 64, 101]) {
      const r = await readRecentJsonLines<{ at: string; i: number }>(f, new Date(T0).toISOString(), { chunkBytes });
      expect(r.map((x) => x.i)).toEqual(lines.map((_, i) => i));
    }
  });
  it("pins the chunk rule: a newer record in an unread earlier chunk is not returned, in a read one it is", async () => {
    const old = (i: number) => JSON.stringify({ at: "2026-01-01T00:00:00.000Z", i });
    const newer = JSON.stringify({ at: "2026-12-01T00:00:00.000Z", i: 99 });
    const pad = Array.from({ length: 40 }, (_, i) => old(i));
    const cut = "2026-06-01T00:00:00Z";
    const f = tmp();
    writeFileSync(f, [newer, ...pad].join("\n") + "\n");
    expect(await readRecentJsonLines(f, cut, { chunkBytes: 200 })).toEqual([]);
    expect(await readRecentJsonLines(f, cut, { chunkBytes: 1 << 20 })).toEqual([JSON.parse(newer)]);
  });
  it("skips and counts a record without a parseable at", async () => {
    const f = tmp(), got: { skipped: number }[] = [];
    writeFileSync(f, `{"x":1}\n{"at":"nope"}\n${rec(1)}\n`);
    expect(await readRecentJsonLines(f, new Date(T0).toISOString(), { onSkipped: (r) => got.push(r) })).toHaveLength(1);
    expect(got[0]!.skipped).toBe(2);
  });
});
