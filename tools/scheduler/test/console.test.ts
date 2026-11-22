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
