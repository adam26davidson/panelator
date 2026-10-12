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
