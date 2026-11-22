import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.ts";
import { loadConfig } from "../src/config.ts";
import { buildConsoleState } from "../src/console/state.ts";
import { ParameterStore } from "../src/parameters/store.ts";
import { validate } from "../src/schema/validate.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

export async function consoleCtx() {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  const cfgPath = join(dir, "s.yaml");
  writeFileSync(cfgPath, `repo: a/b\nmaintainer: me\napp: {bot_login: bot}\nstate_dir: ${dir}/state\n`);
  const cfg = loadConfig(cfgPath);
  const paths = statePaths(cfg.state_dir);
  await ensureStateDirs(paths);
  const parameters = new ParameterStore(paths, {
    aws_cap_usd: { name: "aws_cap_usd", type: "number", default: 0, min: 0, max: 100, mode: "locked", description: "The monthly AWS cap" },
    batch: { name: "batch", type: "number", default: 3, min: 1, max: 9, mode: "auto", description: "Batch size for tests" },
  });
  await parameters.initialize();
  const log = new ActionLog(paths.actionsLog, paths);
  const base = { cfg, paths, parameters, log, registry: {}, metrics: {}, now: () => new Date("2026-11-22T10:00:00Z") };
  return { dir, cfg, paths, parameters, log, base };
}

describe("buildConsoleState (spec 051 AC-2)", () => {
  it("is valid with every optional source missing", async () => {
    const { base } = await consoleCtx();
    const s = await buildConsoleState(base);
    expect(validate("console-state", s)).toEqual({ ok: true });
    expect(s).toMatchObject({ questions: [], current: [], up_next: [], metrics: null, actions: [], changes: [], tick_s: 45 });
    expect(s.tiles.aws).toEqual({ actual_usd: null, forecast_usd: null, cap_usd: 0 });
    expect(s.next_tick_at).toBe("2026-11-22T10:00:45.000Z");
    expect(s.parameters.map((p) => p.name).sort()).toEqual(["aws_cap_usd", "batch"]);
  });
  it("folds the questions log to one entry per comment, newest event deciding", async () => {
    const { base, paths } = await consoleCtx();
    const q = { kind: "product", question: "Which?", options: [{ label: "A", cost: "c" }], recommendation: "A" };
    const lines = [
      { issue: 5, at: "2026-11-20T00:00:00Z", event: "asked", asking_stage: "plan", question_comment_id: 11, question: q },
      { issue: 5, at: "2026-11-21T00:00:00Z", event: "reminded", asking_stage: "plan", question_comment_id: 11 },
      { issue: 6, at: "2026-11-20T01:00:00Z", event: "asked", asking_stage: "plan", question_comment_id: 12, question: q },
      { issue: 6, at: "2026-11-21T01:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 12, reply_comment_id: 99, answer: "A" },
    ];
    writeFileSync(paths.questionsLog, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const s = await buildConsoleState({ ...base, telegramUsername: () => "panel_bot" });
    expect(validate("console-state", s)).toEqual({ ok: true });
    expect(s.questions.map((x) => [x.question_comment_id, x.status])).toEqual([[11, "reminded"], [12, "answered"]]);
    expect(s.questions[1]).toMatchObject({ decision_url: "https://github.com/a/b/issues/6#issuecomment-99", question_url: "https://github.com/a/b/issues/6#issuecomment-12", telegram_url: "https://t.me/panel_bot", text: "Which?", options: ["A"] });
  });
  it("carries the last 50 changes and the cost record", async () => {
    const { base, paths } = await consoleCtx();
    mkdirSync(join(paths.root, "aws"), { recursive: true });
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, at: "2026-11-22T00:00:00Z", by: "me", kind: "pause_agent", args: { name: "x" }, status: "applied" }));
    writeFileSync(paths.consoleChanges, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const s = await buildConsoleState(base);
    expect(s.changes).toHaveLength(50);
    expect(s.changes[0].id).toBe(11);
    expect(validate("console-state", s)).toEqual({ ok: true });
  });
});

import { readFileSync } from "node:fs";
import { KINDS, type ActionContext } from "../src/actions/index.ts";
import { loadParameterDefinitions } from "../src/parameters/definitions.ts";
import { applyChange, cursor } from "../src/console/apply.ts";
import { readAgentState, writeAgentState } from "../src/standing/state.ts";

async function applyCtx() {
  const c = await consoleCtx();
  const parameters = new ParameterStore(c.paths, loadParameterDefinitions("agents/parameters.yaml", { slots: 1 }, {}));
  await parameters.initialize();
  const ctx: ActionContext = {
    paths: c.paths, parameters, log: c.log, levels: Object.fromEntries(Object.keys(KINDS).map((k) => [k, 1])), now: () => new Date("2026-11-22T10:00:00Z"),
    gh: { rerunWorkflowRun: async () => {}, cancelWorkflowRun: async () => {} },
  };
  await writeAgentState(c.paths, "audit", { last_run: null, next_run: null, pending_events: [], paused: false, paused_by: null, failures: 0 });
  const change = (id: number, kind: string, args: Record<string, unknown>) => ({ id, at: "2026-11-22T09:59:00Z", by: "me", kind, args });
  return { ...c, ctx, parameters, change };
}

describe("applyChange (spec 051 AC-4)", () => {
  it("applies set_parameter as the maintainer with run_id console:<id>, and the same id once", async () => {
    const { ctx, change, log, paths } = await applyCtx();
    const r = await applyChange(ctx, change(1, "set_parameter", { name: "system_work_share", value: 0.5 }));
    expect(r.change.status).toBe("applied");
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
    const rows = await log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "maintainer", run_id: "console:1", kind: "set_parameter" });
    expect(r.change.action_id).toBe(rows[0].id);
    const again = await applyChange(ctx, change(1, "set_parameter", { name: "system_work_share", value: 0.9 }));
    expect(again.fresh).toBe(false);
    expect(again.change).toEqual(r.change);
    expect(await log.list()).toHaveLength(1);
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.5);
    expect(await cursor(ctx)).toBe(1);
    expect(readFileSync(paths.consoleChanges, "utf8").trim().split("\n")).toHaveLength(1);
  });
  it("applies a locked parameter change, since the maintainer may", async () => {
    const { ctx, change } = await applyCtx();
    expect((await applyChange(ctx, change(2, "set_parameter", { name: "aws_cap_usd", value: 5 }))).change.status).toBe("applied");
  });
  it("pauses, resumes and undoes", async () => {
    const { ctx, change, paths, log } = await applyCtx();
    const p = await applyChange(ctx, change(3, "pause_agent", { name: "audit" }));
    expect(p.change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(true);
    const u = await applyChange(ctx, change(4, "undo", { action_id: p.change.action_id }));
    expect(u.change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(false);
    expect((await log.list()).find((r) => r.id === u.change.action_id)?.run_id).toBe("console:4");
    expect((await applyChange(ctx, change(5, "pause_agent", { name: "audit" }))).change.status).toBe("applied");
    expect((await applyChange(ctx, change(6, "resume_agent", { name: "audit" }))).change.status).toBe("applied");
    expect((await readAgentState(paths, "audit"))?.paused).toBe(false);
  });
  it("records a mode change in the parameter history and not in the action log", async () => {
    const { ctx, change, paths, log } = await applyCtx();
    const r = await applyChange(ctx, change(7, "set_parameter_mode", { name: "system_work_share", mode: "locked" }));
    expect(r.change.status).toBe("applied");
    expect(readFileSync(paths.parametersHistory, "utf8")).toContain('"field":"mode"');
    expect(await log.list()).toHaveLength(0);
  });
  it("refuses unknown kinds, malformed args, unknown names and bad values, applying nothing", async () => {
    const { ctx, change, log } = await applyCtx();
    for (const [i, c] of [["run_agent", { name: "audit" }], ["set_parameter", { name: "system_work_share" }], ["set_parameter", { name: "nope", value: 1 }], ["set_parameter", { name: "system_work_share", value: 99 }], ["undo", { action_id: "missing" }], ["set_parameter_mode", { name: "nope", mode: "locked" }], ["set_parameter_mode", { name: "system_work_share", mode: "x" }]].entries()) {
      const r = await applyChange(ctx, change(20 + i, c[0] as string, c[1] as Record<string, unknown>));
      expect(r.change.status, String(c[0])).toBe("refused");
      expect(r.change.reason).toBeTruthy();
    }
    expect((await ctx.parameters.read("system_work_share")).value).toBe(0.75);
    expect((await log.list()).every((r) => r.status !== "applied")).toBe(true);
  });
});
