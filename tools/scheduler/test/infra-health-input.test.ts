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
  expect(input.free_space).toHaveLength(2);
  expect(input.free_space[0]).toMatchObject({ free_bytes: 5, free_inodes: null });
  expect(input.disk_sweep?.volumes[0].path).toBe("/t");
  expect(Object.keys(input.agents)).toEqual(["findings-filer"]);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
  expect(validate("infra-health-input", { since: null })).toMatchObject({ ok: false });
});

it("builds over a torn service log and action log and reports the skips (spec 103 AC-3, AC-6)", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "infra-torn-")));
  await ensureStateDirs(paths);
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  const NUL = "\u0000", j = (r: unknown) => JSON.stringify(r);
  const filler = Array.from({ length: 1500 }, (_, i) => j({ at: at(100 + i / 100), kind: "tick", pad: "x".repeat(60) }));
  const log = [NUL.repeat(9), ...filler.reverse(), NUL.repeat(5), j({ at: at(30), kind: "tick" }), j({ at: at(5), kind: "tick" }), NUL.repeat(7), NUL.repeat(2) + j({ at: at(4), kind: "stopped", reason: "telegram connected" }), j({ at: at(3), kind: "jsonl-skipped-lines", file: "x" })].join("\n") + "\n";
  expect(Buffer.byteLength(log)).toBeGreaterThan(65536);
  writeFileSync(paths.serviceLog, log);
  const row = (h: number) => ({ id: String(h), at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
  writeFileSync(paths.actionsLog, [row(1), NUL.repeat(4), row(24 * 8)].map((r) => (typeof r === "string" ? r : j(r)) + "\n").join(""));
  const logged: Record<string, unknown>[] = [];
  const input = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log: (r) => logged.push(r) }, [], null, NOW);
  expect(input.service_log.map((r) => [r.kind, r.at])).toEqual([["tick", at(5)], ["stopped", at(4)], ["jsonl-skipped-lines", at(3)]]);
  expect(input.actions).toHaveLength(1);
  expect(input.skipped_lines).toHaveLength(2);
  const [svc, act] = input.skipped_lines;
  expect(svc).toMatchObject({ file: paths.serviceLog, skipped: 2, recovered: 1 });
  expect(svc.offsets).not.toContain(0);
  expect(svc.lines).toBeUndefined();
  expect(act).toMatchObject({ file: paths.actionsLog, skipped: 1, recovered: 0, lines: [2] });
  expect(logged.filter((r) => r.kind === "jsonl-skipped-lines").map((r) => r.file)).toEqual([paths.serviceLog, paths.actionsLog]);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
});

it("the checked-in infra health agent loads with its limits", () => {
  const def = loadRegistry("agents/standing", EVENT_NAMES, registryActionsCheck("agents/actions.yaml"))["infra-health"];
  expect(def).toMatchObject({ tier: "standard", worktree: "none", input: "infra-health-input", actions: ["rerun_workflow", "run_agent", "pause_agent", "sweep_volume"], trigger: { schedule: "6h", events: ["infra_alarm", "ci_failure_main"] } });
});
