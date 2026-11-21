import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubClient } from "../src/github/client.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { buildFilerInput, type FilerDeps } from "../src/filer/input.ts";
import { buildAuditInput } from "../src/standing/audit-input.ts";
import { buildInfraHealthInput } from "../src/standing/infra-health-input.ts";

// Spec 103 AC-7: a NUL-only line and a NUL-prefixed record in each file the standing agents read back.
const NOW = new Date("2026-11-14T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const NUL = "\u0000".repeat(40);
const lines = (rows: (object | string)[]) => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r)) + "\n").join("");
const act = (id: string, h: number) => ({ id, at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
const f = (what: string) => ({ what, where: "w", evidence: "e", noticed_how: "n" });

async function world() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "torn-")));
  await ensureStateDirs(paths);
  writeFileSync(paths.serviceLog, lines([{ at: at(5), kind: "tick" }, NUL, NUL + JSON.stringify({ at: at(2), kind: "stopped" }), { at: at(1), kind: "tick" }]));
  writeFileSync(paths.actionsLog, lines([act("1", 3), NUL, NUL + JSON.stringify(act("2", 2)), act("3", 1)]));
  writeFileSync(paths.parametersHistory, lines([{ name: "slots", old: 1, new: 2 }, NUL, NUL + JSON.stringify({ name: "slots", old: 2, new: 3 })]));
  writeFileSync(paths.findingsQueue, lines([{ finding: f("one") }, NUL, NUL + JSON.stringify({ finding: f("three") }), { finding: f("four") }]));
  writeFileSync(paths.findingsTriage, lines([NUL, NUL + JSON.stringify({ ref: "1", outcome: "discard", reason: "r", run_id: "x", at: at(1) })]));
  const logs: Record<string, unknown>[] = [];
  return { paths, logs, log: (r: Record<string, unknown>) => { logs.push(r); } };
}
const reports = (logs: Record<string, unknown>[]) => logs.filter((l) => l.kind === "jsonl-skipped-lines");

describe("a torn line in a state file does not stop an input build (spec 103 AC-7)", () => {
  it("infra health", async () => {
    const w = await world();
    const input = await buildInfraHealthInput({ paths: w.paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log: w.log }, [], null, NOW);
    expect(input.service_log.map((r) => r.kind)).toEqual(["tick", "stopped", "tick"]);
    expect(input.actions.map((r) => r.id)).toEqual(["1", "2", "3"]);
    const rs = reports(w.logs);
    expect(rs.map((r) => r.file)).toEqual([w.paths.serviceLog, w.paths.actionsLog]);
    for (const r of rs) expect(r).toMatchObject({ skipped: 1, recovered: 1 });
  });
  it("action audit", async () => {
    const w = await world();
    const input = await buildAuditInput(w.paths, null, NOW, w.log);
    expect(input.kinds.pause_agent.entries.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(input.parameter_history).toHaveLength(2);
    const rs = reports(w.logs);
    expect(rs.map((r) => r.file)).toEqual([w.paths.actionsLog, w.paths.parametersHistory]);
    for (const r of rs) expect(r).toMatchObject({ skipped: 1, recovered: 1 });
  });
  it("findings filer", async () => {
    const w = await world();
    const gh = { listOpenIssuesByAuthor: vi.fn(async () => []), listOpenIssuesByLabel: vi.fn(async () => []) };
    const d: FilerDeps = { paths: w.paths, gh: gh as unknown as GitHubClient, botLogin: "bot", now: () => NOW, classes: ["class:bug"], stopsPipelineLabel: "s", notify: async () => {}, log: w.log };
    const input = await buildFilerInput(d);
    // line 2 is the hole; ref 3 is the recovered record; the cursor stops before the hole
    expect(input.records.map((r) => r.ref)).toEqual(["3", "4"]);
    expect(input.records[0].finding.what).toBe("three");
    expect(input.cursor).toBe(1);
    const rs = reports(w.logs);
    expect(rs.map((r) => r.file)).toEqual([w.paths.findingsQueue, w.paths.findingsTriage]);
    expect(rs[0]).toMatchObject({ skipped: 1, recovered: 1 });
    expect(rs[1]).toMatchObject({ skipped: 1, recovered: 1 });
  });
});
