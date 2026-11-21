// Spec 103 AC-7: one NUL-only line and one NUL-prefixed record in every JSONL file an input reads.
import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { buildInfraHealthInput } from "../src/standing/infra-health-input.ts";
import { buildAuditInput } from "../src/standing/audit-input.ts";
import { buildFilerInput, type FilerDeps } from "../src/filer/input.ts";

const NOW = new Date("2026-11-14T12:00:00Z");
const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const NUL = "\u0000", j = (r: unknown) => JSON.stringify(r);
const torn = (valid: unknown[], recovered: unknown) => [j(valid[0]), NUL.repeat(16), NUL.repeat(4) + j(recovered), ...valid.slice(1).map(j)].join("\n") + "\n";
const action = (id: string, h: number) => ({ id, at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
const finding = (what: string) => ({ finding: { what, where: "f", evidence: "e", noticed_how: "t" } });

it("every input builds over a torn file, recovers the NUL-prefixed record and reports each file once", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "torn-")));
  await ensureStateDirs(paths);
  writeFileSync(paths.serviceLog, torn([{ at: at(3), kind: "tick" }], { at: at(2), kind: "stopped", reason: "telegram connected" }));
  writeFileSync(paths.actionsLog, torn([action("1", 3)], action("2", 2)));
  writeFileSync(paths.parametersHistory, torn([{ name: "a", value: 1 }], { name: "b", value: 2 }));
  writeFileSync(paths.findingsQueue, torn([finding("one")], finding("three")) + j(finding("four")) + "\n");
  writeFileSync(paths.findingsTriage, torn([{ ref: "1", outcome: "discard", reason: "r", run_id: "x", at: at(1) }], { ref: "3", outcome: "discard", reason: "r", run_id: "x", at: at(1) }));
  const logged: Record<string, unknown>[] = [], log = (r: Record<string, unknown>) => { logged.push(r); };

  const infra = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log }, [], null, NOW);
  expect(infra.service_log.map((r) => r.reason ?? r.kind)).toEqual(["tick", "telegram connected"]);
  expect(infra.actions.map((a) => a.id)).toEqual(["1", "2"]);

  const audit = await buildAuditInput(paths, null, NOW, log);
  expect((audit.kinds as Record<string, { entries: { id: string }[] }>).pause_agent.entries.map((e) => e.id)).toEqual(["1", "2"]);
  expect(audit.parameter_history).toEqual([{ name: "a", value: 1 }, { name: "b", value: 2 }]);

  const d: FilerDeps = { paths, gh: { listOpenIssuesByAuthor: async () => [], listOpenIssuesByLabel: async () => [] } as never, botLogin: "bot", now: () => NOW, classes: ["class:bug"], stopsPipelineLabel: "s", notify: async () => {}, log };
  const filer = await buildFilerInput(d);
  // queue lines: 1 valid, 2 NUL-only, 3 recovered, 4 valid; ref 2 is a hole and later refs keep their numbers
  expect(filer.records.map((r) => [r.ref, r.finding.what])).toEqual([["4", "four"]]);
  expect(filer.cursor).toBe(1);

  const reports = logged.filter((r) => r.kind === "jsonl-skipped-lines");
  expect(reports.map((r) => r.file).sort()).toEqual([paths.serviceLog, paths.actionsLog, paths.actionsLog, paths.parametersHistory, paths.findingsQueue, paths.findingsTriage].sort());
  for (const r of reports) expect([r.skipped, r.recovered]).toEqual([1, 1]);
});
