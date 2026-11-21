import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { buildInfraHealthInput } from "../src/standing/infra-health-input.ts";
import { buildAuditInput } from "../src/standing/audit-input.ts";
// readJsonLines comes from filer/input.ts, which exports it on main too, so this file loads there and fails in the builds (AC-7).
import { buildFilerInput, readJsonLines, type FilerDeps } from "../src/filer/input.ts";
import { applyFilerResult } from "../src/filer/apply.ts";
import { ActionLog } from "../src/actions/log.ts";
import { validate } from "../src/schema/validate.ts";
import type { GitHubClient } from "../src/github/client.ts";

// Spec 103 AC-3, AC-5, AC-7: a NUL-only line and a NUL-prefixed record in every file the standing inputs read.
const NUL = "\u0000";
const NOW = new Date("2026-11-14T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const j = (r: unknown) => JSON.stringify(r);
const torn = (lines: string[]) => lines.join("\n") + "\n";
const finding = (what: string) => ({ what, where: "f.ts", evidence: "e", noticed_how: "t" });
const row = (id: string, h: number, kind = "pause_agent", status = "applied") => ({ id, at: at(h), kind, args: {}, agent: "a", run_id: "r", why: "x", status, undo: null });

async function world() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "torn-")));
  await ensureStateDirs(paths);
  writeFileSync(paths.serviceLog, torn([j({ at: at(5), kind: "tick" }), NUL.repeat(64), NUL.repeat(10) + j({ at: at(3), kind: "stopped", reason: "restart" }), j({ at: at(1), kind: "tick" })]));
  writeFileSync(paths.actionsLog, torn([j(row("1", 2)), NUL.repeat(32), NUL.repeat(5) + j(row("2", 1, "run_agent"))]));
  writeFileSync(paths.parametersHistory, torn([j({ at: at(4), name: "slots", value: 1 }), NUL.repeat(20), NUL.repeat(3) + j({ at: at(2), name: "slots", value: 2 })]));
  writeFileSync(paths.findingsQueue, torn([j({ finding: finding("one") }), NUL.repeat(16), j({ finding: finding("three") }), NUL.repeat(4) + j({ finding: finding("four") })]));
  writeFileSync(paths.findingsTriage, torn([j({ ref: "1", outcome: "discard", reason: "r", run_id: "o", at: at(9) }), NUL.repeat(8), NUL.repeat(2) + j({ ref: "2", outcome: "discard", reason: "r", run_id: "o", at: at(9) })]));
  return paths;
}
const gh = () => ({ listOpenIssuesByAuthor: async () => [], listOpenIssuesByLabel: async () => [], listComments: async () => [] }) as unknown as GitHubClient;
const reports = (logged: Record<string, unknown>[], file: string) => logged.filter((r) => r.kind === "jsonl-skipped-lines" && r.file === file);

describe("one torn line no longer disables a standing input (spec 103 AC-7)", () => {
  it("infra health builds over the torn service log and action log", async () => {
    const paths = await world(), logged: Record<string, unknown>[] = [];
    const input = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log: (r) => logged.push(r) }, [], null, NOW);
    expect(input.service_log.map((r) => r.kind)).toEqual(["tick", "stopped", "tick"]);
    expect(input.actions.map((r) => r.id)).toEqual(["1", "2"]);
    for (const f of [paths.serviceLog, paths.actionsLog]) expect(reports(logged, f)).toEqual([expect.objectContaining({ skipped: 1, recovered: 1 })]);
    expect(input.skipped_lines.map((s) => s.file).sort()).toEqual([paths.actionsLog, paths.serviceLog].sort());
    expect(input.skipped_lines.find((s) => s.file === paths.serviceLog)).not.toHaveProperty("lines");
    expect(validate("infra-health-input", input)).toEqual({ ok: true });
  });
  it("the action audit builds over the torn action log and parameter history", async () => {
    const paths = await world(), logged: Record<string, unknown>[] = [];
    const input = await buildAuditInput(paths, null, NOW, (r) => logged.push(r));
    expect(input.kinds.run_agent!.entries.map((e) => e.id)).toEqual(["2"]);
    expect(input.parameter_history).toHaveLength(2);
    for (const f of [paths.actionsLog, paths.parametersHistory]) expect(reports(logged, f)).toEqual([expect.objectContaining({ skipped: 1, recovered: 1 })]);
  });
  it("the filer offers the recovered record under its line number, leaves a hole, and applies over the torn triage log", async () => {
    const paths = await world(), logged: Record<string, unknown>[] = [];
    const d: FilerDeps = { paths, gh: gh(), botLogin: "bot", now: () => NOW, classes: ["class:bug"], stopsPipelineLabel: "s", notify: vi.fn(async () => {}), log: (r) => logged.push(r) };
    const input = await buildFilerInput(d);
    expect(input.records.map((r) => r.ref)).toEqual(["3", "4"]);
    expect(input.records[1]!.finding.what).toBe("four");
    expect(input.cursor).toBe(2);
    for (const f of [paths.findingsQueue, paths.findingsTriage]) expect(reports(logged, f)).toEqual([expect.objectContaining({ skipped: 1, recovered: 1 })]);
    await applyFilerResult(d, "run", input, { summary: "s", decisions: [{ ref: "3", outcome: "discard", reason: "no" }, { ref: "4", outcome: "discard", reason: "no" }] });
    expect(JSON.parse(await readFile(paths.findingsCursor, "utf8")).line).toBe(4);
    expect((await readJsonLines<{ ref: string }>(paths.findingsTriage)).map((t) => t.ref)).toEqual(["1", "2", "3", "4"]);
  });
  it("markStalePending settles the pending row that follows a NUL-only line", async () => {
    const paths = await world();
    writeFileSync(paths.actionsLog, torn([j(row("1", 2)), NUL.repeat(32), j(row("2", 1, "run_agent", "pending"))]));
    const log = new ActionLog(paths.actionsLog, paths);
    await log.markStalePending();
    expect((await log.list()).map((r) => [r.id, r.status])).toEqual([["1", "applied"], ["2", "failed"]]);
    expect((await readJsonLines<{ kind: string; file: string }>(paths.serviceLog)).some((r) => r.kind === "jsonl-skipped-lines" && r.file === paths.actionsLog)).toBe(true);
  });
});
