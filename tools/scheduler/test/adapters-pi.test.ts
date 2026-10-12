import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonlFile } from "../src/adapters/jsonl.ts";
import { piAdapter } from "../src/adapters/pi.ts";
import type { StageRun } from "../src/adapters/types.ts";

const fx = async (n: string) => (await readJsonlFile(join(import.meta.dirname, "fixtures", "streams", n))).records;
const run: StageRun = {
  runId: "r", stage: "implement", attempt: 1, issue: 7, prompt: "Implement; write /tmp/r.json", model: "openai/gpt-6.1-sol",
  bounds: { timeout_min: 90, max_turns: 300, max_cost_usd: 10 }, worktree: "/w", sessionId: "s-1", resultPath: "/tmp/r.json",
  profile: { name: "backend", dir: "/a", skillsDir: "/a/skills", instructions: "", tools: ["read", "bash", "edit", "write"] }, effort: "medium",
};

describe("piAdapter.buildCommand (AC-19)", () => {
  it("selects json mode, provider/model, session id, non-interactive approval and the profile tools", () => {
    const { argv, env } = piAdapter.buildCommand(run);
    expect(argv[0]).toBe("pi");
    expect(argv.slice(argv.indexOf("--mode"), argv.indexOf("--mode") + 2)).toEqual(["--mode", "json"]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", "openai/gpt-6.1-sol"]);
    expect(argv.slice(argv.indexOf("--session-id"), argv.indexOf("--session-id") + 2)).toEqual(["--session-id", "s-1"]);
    expect(argv).toContain("--approve");
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2)).toEqual(["--tools", "read,bash,edit,write"]);
    expect(argv.slice(argv.indexOf("--skill"), argv.indexOf("--skill") + 2)).toEqual(["--skill", "/a/skills"]);
    expect(argv.slice(argv.indexOf("--thinking"), argv.indexOf("--thinking") + 2)).toEqual(["--thinking", "medium"]);
    expect(argv[argv.length - 1]).toContain("/tmp/r.json");
    expect(env.CI).toBe("true");
  });
  it("adds -e for each extension", () => {
    const { argv } = piAdapter.buildCommand({ ...run, extensions: ["/x/container.ts"] } as StageRun & { extensions: string[] });
    expect(argv.slice(argv.indexOf("-e"), argv.indexOf("-e") + 2)).toEqual(["-e", "/x/container.ts"]);
  });
});

describe("piAdapter.isTurnEnd", () => {
  it("recognises turn_end records only", () => {
    expect(piAdapter.isTurnEnd?.({ type: "turn_end" })).toBe(true);
    expect(piAdapter.isTurnEnd?.({ type: "message_end" })).toBe(false);
    expect(piAdapter.isTurnEnd?.(null)).toBe(false);
  });
});

describe("piAdapter.judge (AC-20)", () => {
  it("ok on a clean stream", async () => {
    expect(piAdapter.judge(await fx("pi-success.jsonl"), 0, false)).toMatchObject({ outcome: "ok", finalText: "pong" });
  });
  it("failed when the last assistant message is in error state even though exit is 0", async () => {
    expect(piAdapter.judge(await fx("pi-error-exit0.jsonl"), 0, false)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("not supported"), apiErrorStatus: 400 });
  });
  it("failed without agent_end", async () => {
    const ev = (await fx("pi-success.jsonl")).slice(0, 5);
    expect(piAdapter.judge(ev, 0, false)).toMatchObject({ outcome: "failed", reason: "no agent_end event" });
  });
  it("bounds on the runner's synthetic bounds record", async () => {
    const ev = [...(await fx("pi-success.jsonl")), { type: "scheduler_bounds", reason: "max_turns" }];
    expect(piAdapter.judge(ev, null, false)).toMatchObject({ outcome: "bounds", reason: "max_turns" });
  });
  it("timeout wins", async () => {
    expect(piAdapter.judge(await fx("pi-success.jsonl"), null, true).outcome).toBe("timeout");
  });
});

describe("piAdapter.usage (AC-24)", () => {
  it("sums assistant message_end usage, counts turns and tool calls", async () => {
    expect(piAdapter.usage(await fx("pi-tool-calls.jsonl"))).toEqual({
      cost_usd: 0.00375, input_tokens: 300, output_tokens: 15, cache_read_tokens: 200, cache_write_tokens: 20, turns: 2, tool_calls: 1,
    });
  });
});
