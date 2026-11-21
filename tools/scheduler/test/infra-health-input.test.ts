import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { buildInfraHealthInput } from "../src/standing/infra-health-input.ts";
import { writeAgentState } from "../src/standing/state.ts";
import { validate } from "../src/schema/validate.ts";
import { loadRegistry } from "../src/standing/registry.ts";
import { EVENT_NAMES } from "../src/standing/events.ts";
import { registryActionsCheck } from "../src/actions/index.ts";
import { writeDiskSweep } from "../src/service/sweep.ts";

const NOW = new Date("2026-11-14T12:00:00Z");

it("builds the input from the sweep report, free space, agent states, the last day of the service log and a week of actions", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "infra-input-")));
  await ensureStateDirs(paths);
  await writeAgentState(paths, "findings-filer", { last_run: null, next_run: null, pending_events: [], paused: true, paused_by: "maintainer", failures: 3 });
  await writeDiskSweep(paths, { last_at: NOW.toISOString(), volumes: [{ path: "/t", free_bytes: 1, free_inodes: 2, removed: 0, freed_inodes: 0, holders: [] }] });
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  writeFileSync(paths.serviceLog, [
    { at: at(1), kind: "tick", errors: [] }, { at: at(2), kind: "stopped", reason: "restart" }, { at: at(3), kind: "disk-sweep-alarm" },
    { at: at(3), kind: "claim-skipped" }, { at: at(30), kind: "tick" },
  ].map((r) => JSON.stringify(r) + "\n").join(""));
  const row = (h: number) => ({ id: String(h), at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
  writeFileSync(paths.actionsLog, [row(1), row(24 * 8)].map((r) => JSON.stringify(r) + "\n").join(""));
  const input = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }) }, [], null, NOW);
  expect(input.service_log.map((r) => r.kind)).toEqual(["tick", "stopped", "disk-sweep-alarm"]);
  expect(input.actions).toHaveLength(1);
  expect(input.skipped_lines).toEqual([]);
  expect(input.free_space).toHaveLength(2);
  expect(input.free_space[0]).toMatchObject({ free_bytes: 5, free_inodes: null });
  expect(input.disk_sweep?.volumes[0].path).toBe("/t");
  expect(Object.keys(input.agents)).toEqual(["findings-filer"]);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
  expect(validate("infra-health-input", { since: null })).toMatchObject({ ok: false });
});

it("builds over a torn service log and action log, and carries the day's jsonl-skipped-lines reports (spec 103 AC-3)", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "infra-input-torn-")));
  await ensureStateDirs(paths);
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  const NUL = "\u0000", j = (r: unknown) => JSON.stringify(r);
  // An earlier read's report (the filer's, over the findings queue): it reaches the agent only through service_log.
  const earlier = { at: at(7), kind: "jsonl-skipped-lines", file: paths.findingsQueue, skipped: 1, recovered: 0, offsets: [120], lines: [2] };
  const lines = [
    j({ at: at(40), kind: "tick" }),
    NUL.repeat(48), // older than a day
    j({ at: at(30), kind: "tick" }),
    j({ at: at(20), kind: "tick", n: 1 }),
    j(earlier),
    NUL.repeat(64), // inside the last day
    NUL.repeat(12) + j({ at: at(5), kind: "telegram connected" }), // recovered, but not one of the kinds
    NUL.repeat(6) + j({ at: at(4), kind: "tick", n: 2 }), // recovered and of a qualifying kind
    j({ at: at(3), kind: "claim-skipped" }),
    j({ at: at(2), kind: "stopped", reason: "restart" }),
    j({ at: at(1), kind: "disk-sweep-alarm" }),
  ];
  writeFileSync(paths.serviceLog, lines.join("\n") + "\n");
  const offset = (i: number) => Buffer.byteLength(lines.slice(0, i).map((l) => l + "\n").join(""));
  const row = (h: number) => ({ id: String(h), at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
  writeFileSync(paths.actionsLog, [j(row(24 * 8)), j(row(48)), NUL.repeat(32), j(row(1))].join("\n") + "\n");
  const logged: Record<string, unknown>[] = [];
  const input = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log: (r) => logged.push(r) }, [], null, NOW);
  expect(input.service_log).toEqual([
    { at: at(20), kind: "tick", n: 1 }, earlier, { at: at(4), kind: "tick", n: 2 }, { at: at(2), kind: "stopped", reason: "restart" }, { at: at(1), kind: "disk-sweep-alarm" },
  ]);
  expect(input.actions.map((r) => r.id)).toEqual(["48", "1"]);
  const service = input.skipped_lines.find((s) => s.file === paths.serviceLog)!;
  // The file is smaller than one chunk, so the old NUL-only line is read and counted with the recent one.
  expect(service).toEqual({ file: paths.serviceLog, skipped: 2, recovered: 2, offsets: expect.arrayContaining([offset(1), offset(5), offset(6), offset(7)]) });
  expect(service.offsets).toHaveLength(4);
  expect(input.skipped_lines.find((s) => s.file === paths.actionsLog)).toEqual({ file: paths.actionsLog, skipped: 1, recovered: 0, offsets: [expect.any(Number)], lines: [3] });
  expect(input.skipped_lines).toHaveLength(2);
  expect(logged).toEqual(expect.arrayContaining([{ kind: "jsonl-skipped-lines", ...service }, expect.objectContaining({ kind: "jsonl-skipped-lines", file: paths.actionsLog, skipped: 1, recovered: 0 })]));
  expect(logged.filter((r) => r.kind === "jsonl-skipped-lines")).toHaveLength(2);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
});

it("the checked-in infra health agent loads with its limits", () => {
  const def = loadRegistry("agents/standing", EVENT_NAMES, registryActionsCheck("agents/actions.yaml"))["infra-health"];
  expect(def).toMatchObject({ tier: "standard", worktree: "none", input: "infra-health-input", actions: ["rerun_workflow", "run_agent", "pause_agent", "sweep_volume"], trigger: { schedule: "6h", events: ["infra_alarm", "ci_failure_main"] } });
});
