import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/claude.ts";
import { readJsonlFile } from "../src/adapters/jsonl.ts";
import type { StageRun } from "../src/adapters/types.ts";

const fx = async (n: string) => (await readJsonlFile(join(import.meta.dirname, "fixtures", "streams", n))).records;

const run: StageRun = {
  runId: "r", stage: "review", attempt: 1, issue: 7, prompt: "Review and write /tmp/r.json", model: "claude-fable-5-1",
  bounds: { timeout_min: 40, max_turns: 150, max_cost_usd: 6 }, worktree: "/w", sessionId: "11111111-1111-4111-8111-111111111111",
  resultPath: "/tmp/r.json", profile: null, effort: "high",
};

describe("claudeAdapter.buildCommand (AC-18)", () => {
  it("builds the headless command with bounds, session id and no-prompt permission", () => {
    const { argv, env } = claudeAdapter.buildCommand(run);
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toContain("/tmp/r.json");
    expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);
    expect(argv).toContain("--verbose");
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "claude-fable-5-1"]);
    expect(argv.slice(argv.indexOf("--max-turns"), argv.indexOf("--max-turns") + 2)).toEqual(["--max-turns", "150"]);
    expect(argv.slice(argv.indexOf("--max-budget-usd"), argv.indexOf("--max-budget-usd") + 2)).toEqual(["--max-budget-usd", "6"]);
    expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", run.sessionId]);
    expect(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
    expect(argv).toContain("--effort");
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--fallback-model");
    expect(env.CI).toBe("true");
    expect(env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(String(40 * 60_000));
  });
  it("passes the profile tool allowlist and a fallback model when given (AC-26, AC-25)", () => {
    const { argv } = claudeAdapter.buildCommand({ ...run, profile: { name: "backend", dir: "/a", skillsDir: "/a/skills", instructions: "", tools: ["Read", "Bash"] }, fallbackModel: "claude-opus-5-5" } as StageRun & { fallbackModel: string });
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Read,Bash,Write(//tmp/r.json)"]);
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/tmp"]);
    expect(argv.slice(argv.indexOf("--fallback-model"), argv.indexOf("--fallback-model") + 2)).toEqual(["--fallback-model", "claude-opus-5-5"]);
  });
  it("without a profile still allows reading and writing the result file outside the worktree (plan stage)", () => {
    const { argv } = claudeAdapter.buildCommand({ ...run, profile: null });
    expect(argv.slice(argv.indexOf("--allowedTools"), argv.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "Read,Glob,Grep,Write(//tmp/r.json)"]);
    expect(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2)).toEqual(["--add-dir", "/tmp"]);
  });
});

describe("claudeAdapter.judge (AC-21)", () => {
  it("ok on a clean result and exit 0", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), 0, false)).toMatchObject({ outcome: "ok", reason: null, finalText: "pong" });
  });
  it("failed on is_error with the result text and api status", async () => {
    expect(claudeAdapter.judge(await fx("claude-is-error.jsonl"), 1, false)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("Invalid API key"), apiErrorStatus: 401 });
  });
  it("failed on non-zero exit even with a clean result", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), 2, false)).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/exit 2/) });
  });
  it("failed on plugin errors in the init event", async () => {
    expect(claudeAdapter.judge(await fx("claude-plugin-errors.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/plugin errors.*hooks\.json/) });
  });
  it("bounds on error_max_turns (review focus 1)", async () => {
    expect(claudeAdapter.judge(await fx("claude-max-turns.jsonl"), 1, false)).toMatchObject({ outcome: "bounds", reason: expect.stringMatching(/max turns/i) });
  });
  it("reports 429 from the result and from api_retry events", async () => {
    expect(claudeAdapter.judge(await fx("claude-429.jsonl"), 1, false)).toMatchObject({ outcome: "failed", apiErrorStatus: 429 });
  });
  it("timeout wins over everything", async () => {
    expect(claudeAdapter.judge(await fx("claude-success.jsonl"), null, true).outcome).toBe("timeout");
  });
  it("failed with 'no result event' on a partial stream", async () => {
    expect(claudeAdapter.judge(await fx("claude-partial-tail.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: "no result event" });
  });
});

describe("claudeAdapter.usage (AC-24)", () => {
  it("reads totals from the result event and counts tool calls", async () => {
    expect(claudeAdapter.usage(await fx("claude-success.jsonl"))).toEqual({
      cost_usd: 0.0246593, input_tokens: 20, output_tokens: 12, cache_read_tokens: 500, cache_write_tokens: 100, turns: 2, tool_calls: 1,
    });
  });
  it("sums assistant messages with null cost when there is no result", async () => {
    expect(claudeAdapter.usage(await fx("claude-partial-tail.jsonl"))).toEqual({
      cost_usd: null, input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0,
    });
  });
});
