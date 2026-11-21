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

import { awsWorld } from "./helpers/aws.ts";
import { writeLedger, writeCost } from "../src/aws/book.ts";
import { readFileSync } from "node:fs";

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
  expect(input.skipped_lines).toEqual([]);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
  expect(validate("infra-health-input", { since: null })).toMatchObject({ ok: false });
});

it("builds over torn lines, reads the day's reports of other readers, and collects its own (spec 103 AC-3)", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "infra-torn-")));
  await ensureStateDirs(paths);
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
  const NUL = "\u0000".repeat(30), j = (r: object) => JSON.stringify(r);
  const other = { at: at(2), kind: "jsonl-skipped-lines", file: "/state/findings/queue.jsonl", skipped: 1, recovered: 0, offsets: [12] };
  const svc = [NUL, j({ at: at(40), kind: "tick" }), j({ at: at(5), kind: "tick" }), NUL, NUL + j({ at: at(4), kind: "telegram", status: "connected" }), NUL + j({ at: at(3), kind: "stopped" }), j(other)];
  writeFileSync(paths.serviceLog, svc.map((l) => l + "\n").join(""));
  const row = (h: number) => ({ id: String(h), at: at(h), kind: "pause_agent", args: {}, agent: "a", run_id: "r", why: "x", status: "applied", undo: null });
  writeFileSync(paths.actionsLog, [j(row(1)), j(row(24 * 8)), NUL, j(row(2))].map((l) => l + "\n").join(""));
  const logs: Record<string, unknown>[] = [];
  const input = await buildInfraHealthInput({ paths, freeSpace: async () => ({ bytes: 5, inodes: null }), log: (r) => logs.push(r) }, [], null, NOW);
  expect(input.service_log.map((r) => r.kind)).toEqual(["tick", "stopped", "jsonl-skipped-lines"]);
  expect(input.actions.map((r) => r.id)).toEqual(["1", "2"]);
  const offset = (lines: string[], n: number) => lines.slice(0, n).reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
  expect(input.skipped_lines).toEqual([
    { file: paths.serviceLog, skipped: 2, recovered: 2, offsets: [0, offset(svc, 3), offset(svc, 4), offset(svc, 5)] },
    { file: paths.actionsLog, skipped: 1, recovered: 0, offsets: [offset([j(row(1)), j(row(24 * 8))], 2)], lines: [3] },
  ]);
  expect("lines" in input.skipped_lines[0]).toBe(false);
  expect(logs.filter((l) => l.kind === "jsonl-skipped-lines").map(({ kind, ...r }) => r)).toEqual(input.skipped_lines);
  expect(validate("infra-health-input", input)).toEqual({ ok: true });
  const { skipped_lines, ...without } = input;
  expect(validate("infra-health-input", without)).toMatchObject({ ok: false });
});

it("the checked-in infra health agent loads with its limits", () => {
  const def = loadRegistry("agents/standing", EVENT_NAMES, registryActionsCheck("agents/actions.yaml"))["infra-health"];
  for (const word of ["skipped_lines", "jsonl-skipped-lines", "infra health input"]) expect(def.prompt).toContain(word);
  expect(def).toMatchObject({ tier: "standard", worktree: "none", input: "infra-health-input", actions: ["rerun_workflow", "run_agent", "pause_agent", "sweep_volume", "aws_scale"], credentials: ["aws-sso"], trigger: { schedule: "6h", events: ["infra_alarm", "ci_failure_main"] } });
});

it("pins the prompt on the AWS alarm and action (spec 068 AC-8)", () => {
  const text = readFileSync("agents/standing/infra-health.md", "utf8");
  for (const word of ["aws_forecast_over_cap", "aws_scale", "cannot scale: no descriptor", "aws_cap_usd", "20 percent"]) expect(text).toContain(word);
  expect(text).toMatch(/`aws_forecast_over_cap` is known/);
});

it("carries the AWS account in its input in three states (spec 068 AC-8)", async () => {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "infra-aws-")));
  await ensureStateDirs(paths);
  const freeSpace = async () => ({ bytes: 5, inodes: null });
  const none = await buildInfraHealthInput({ paths, freeSpace }, [], null, NOW);
  expect(none.aws).toEqual({ on: false, off_reason: "no aws block", cap_usd: 0, cost: null, reservations: [] });
  expect(validate("infra-health-input", none)).toEqual({ ok: true });

  const off = await awsWorld({ start: NOW.toISOString(), cap: 10 });
  off.setIdentity("999999999999");
  const offIn = await buildInfraHealthInput({ paths, freeSpace, aws: off.ctx }, [], null, NOW);
  expect(offIn.aws).toMatchObject({ on: false, off_reason: expect.stringContaining("999999999999"), cap_usd: 10, cost: null, reservations: [] });
  expect(off.calls().map((c) => c[0])).toEqual(["sts"]);
  expect(validate("infra-health-input", offIn)).toEqual({ ok: true });

  const on = await awsWorld({ start: NOW.toISOString(), cap: 10 });
  const base = { why: "charter: a console the maintainer can reach", by: "spec-e", at: "2026-11-01T00:00:00Z" };
  const scale = { kind: "lambda-concurrency", id: "f", up: { expected_monthly_usd: 6, setting: { reserved_concurrency: 1 } }, down: { expected_monthly_usd: 1, setting: { reserved_concurrency: 0 } }, state: "up" } as const;
  await writeLedger(on.ctx.paths, { reservations: [
    { id: "A", what: "the console api functions", expected_monthly_usd: 6, ...base, released_at: null, scale },
    { id: "R", what: "a released thing for tests", expected_monthly_usd: 2, ...base, released_at: "2026-11-05T00:00:00Z" },
    { id: "B", what: "the console storage and so on", expected_monthly_usd: 8, ...base, released_at: null },
  ] });
  const cost = { month: "2026-11", actual_usd: 4, as_of: NOW.toISOString(), cap_usd: 10, reserved_usd: 14, forecast_usd: 11, days_elapsed: 14, days_in_month: 30, source: "ce" as const };
  await writeCost(on.ctx.paths, cost);
  const onIn = await buildInfraHealthInput({ paths, freeSpace, aws: on.ctx }, [], null, NOW);
  expect(onIn.aws.on).toBe(true);
  expect(onIn.aws.off_reason).toBeUndefined();
  expect(onIn.aws).toMatchObject({ cap_usd: 10, cost });
  expect(onIn.aws.reservations.map((r) => r.id)).toEqual(["A", "B"]);
  expect(onIn.aws.reservations[0].scale).toMatchObject({ state: "up" });
  expect(on.calls().map((c) => c[0])).toEqual(["sts"]);
  expect(validate("infra-health-input", onIn)).toEqual({ ok: true });
});
