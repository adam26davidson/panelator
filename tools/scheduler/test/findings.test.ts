import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendFindings } from "../src/state/findings.ts";
import { savePatch } from "../src/state/patches.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const env = { issue: 7, stage: "implement" as const, run_id: "7-implement-1-x", timestamp: "2026-10-12T00:00:00Z" };
const good = { what: "w", where: "x.ts:1", evidence: "e", noticed_how: "n" };

describe("appendFindings (AC-28)", () => {
  it("queues valid records with the envelope and keeps invalid ones in rejected/ (review focus 4)", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "f-")));
    await ensureStateDirs(p);
    const r = await appendFindings(p, env, [good, { what: "no where" }]);
    expect(r.queued).toBe(1);
    expect(r.rejected).toHaveLength(1);
    const lines = readFileSync(p.findingsQueue, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toEqual({ ...env, finding: good });
    const rejected = readdirSync(p.findingsRejected);
    expect(rejected).toEqual(["7-implement-1-x-1.json"]);
    expect(JSON.parse(readFileSync(join(p.findingsRejected, rejected[0]), "utf8"))).toMatchObject({ envelope: env, errors: expect.any(Array) });
  });
  it("is a no-op for an empty list and does not create the queue file", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "f-")));
    await ensureStateDirs(p);
    expect(await appendFindings(p, env, [])).toEqual({ queued: 0, rejected: [] });
    expect(() => readFileSync(p.findingsQueue)).toThrow();
  });
});

describe("savePatch (AC-15)", () => {
  it("writes the diff with the issue and timestamp in the name, or null for an empty diff", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "p-")));
    await ensureStateDirs(p);
    const path = await savePatch(p, 7, "diff --git a/x b/x\n", new Date("2026-10-12T01:02:03Z"));
    expect(path?.endsWith("patches/7-20261012T010203.patch")).toBe(true);
    expect(await savePatch(p, 7, "", new Date())).toBeNull();
  });
});
