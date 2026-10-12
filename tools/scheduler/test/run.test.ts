import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { runStage, type RunnerContext, type StageRequest } from "../src/runner/run.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { StageDefinition } from "../src/types.ts";

const script = join(import.meta.dirname, "fixtures", "stage-script.ts");
const planDef: StageDefinition = {
  name: "plan", kind: "agent", harness: "claude", model: "claude-fable-5-1", tier: "strong",
  bounds: { timeout_min: 1, max_turns: 10, max_cost_usd: 1 }, permission: "no-prompt", worktree: "issue", profile: "none",
  input: "stage-input", output: "plan-result", prompt: "Plan {{issue}}\n{{spec}}\nWrite {{result_path}}",
};
const goodPlan = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.ts"] }], findings: [{ what: "w", where: "x", evidence: "e", noticed_how: "n" }, { what: "bad" }] };

function setup(opts: { result?: unknown; exitCode?: number; sleepMs?: number; timeoutMin?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "run-"));
  const paths = statePaths(root);
  const eventsFile = join(root, "fixture-events.jsonl");
  writeFileSync(eventsFile, readFileSync(join(import.meta.dirname, "fixtures", "streams", "claude-success.jsonl")));
  const adapter = fakeAdapter({ events: [], result: opts.result, exitCode: opts.exitCode, scriptPath: script, sleepMs: opts.sleepMs, eventsFile });
  const worktree = join(root, "wt");
  mkdirSync(worktree); // the stage's cwd must exist
  const ctx: RunnerContext = { paths, adapter, systemdScope: false, binDir: join(root, "bin"), now: () => new Date("2026-10-12T00:00:00Z"), sessionId: () => "sess-1" };
  const req: StageRequest = {
    def: { ...planDef, bounds: { ...planDef.bounds, timeout_min: opts.timeoutMin ?? 1 } },
    input: { issue: { number: 7, title: "t", body: "b" }, spec: "# s", result_path: "", profile_instructions: "" },
    issue: 7, attempt: 1, worktree, profile: null,
  };
  return { paths, ctx, req, root };
}

describe("runStage", () => {
  it("records a successful run: events, command, result, usage record, findings (AC-22, AC-24, AC-28)", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan });
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("ok");
    expect(out.result).toMatchObject({ verdict: "ready" });
    const dir = join(paths.runs, out.runId);
    for (const f of ["command.txt", "events.jsonl", "stderr.log", "result.json", "usage.json", "prompt.md", "input.json"]) expect(existsSync(join(dir, f))).toBe(true);
    expect(readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(6);
    expect(readFileSync(join(dir, "prompt.md"), "utf8")).toContain(join(dir, "result.json"));
    expect(out.usage).toMatchObject({ run_id: out.runId, issue: 7, stage: "plan", attempt: 1, outcome: "ok", harness: "fake", events_path: `runs/${out.runId}/events.jsonl` });
    expect(existsSync(join(paths.usage, `${out.runId}.json`))).toBe(true);
    expect(out.findings).toEqual({ queued: 1, rejected: [expect.stringContaining("rejected")] });
  });
  it("fails with result: invalid when the result file is missing", async () => {
    const { paths, ctx, req } = setup({});
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("failed");
    expect(out.reason).toBe("result: invalid");
    expect(out.resultErrors[0]).toMatch(/missing/);
  });
  it("fails with result: invalid and the schema errors when the result does not validate", async () => {
    const { paths, ctx, req } = setup({ result: { verdict: "ready" } });
    await ensureStateDirs(paths);
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("failed");
    expect(out.resultErrors.join(" ")).toMatch(/domain|tasks/);
  });
  it("records failed on a non-zero exit", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan, exitCode: 1 });
    await ensureStateDirs(paths);
    expect((await runStage(ctx, req)).outcome).toBe("failed");
  });
  it("records timeout and ignores a result written before the kill (review focus 2)", async () => {
    const { paths, ctx, req } = setup({ result: goodPlan, sleepMs: 5000 });
    await ensureStateDirs(paths);
    req.def = { ...req.def, bounds: { ...req.def.bounds, timeout_min: 1 / 60 } }; // 1 second
    const out = await runStage(ctx, req);
    expect(out.outcome).toBe("timeout");
    expect(out.result).toBeNull();
    expect(out.usage.outcome).toBe("timeout");
  }, 20_000);
});
