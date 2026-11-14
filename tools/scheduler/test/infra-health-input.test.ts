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

it("the checked-in infra health agent loads with its limits", () => {
  const def = loadRegistry("agents/standing", EVENT_NAMES, registryActionsCheck("agents/actions.yaml"))["infra-health"];
  expect(def).toMatchObject({ tier: "standard", worktree: "none", input: "infra-health-input", actions: ["rerun_workflow", "run_agent", "pause_agent", "sweep_volume"], trigger: { schedule: "6h", events: ["infra_alarm", "ci_failure_main"] } });
});
