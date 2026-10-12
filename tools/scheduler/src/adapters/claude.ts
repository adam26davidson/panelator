import { dirname } from "node:path";
import type { Adapter, Command, Judgement, StageRun, Usage } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (e: unknown): Rec => (typeof e === "object" && e !== null ? (e as Rec) : {});

export interface ClaudeStageRun extends StageRun {
  fallbackModel?: string;
}

export function claudeInit(events: unknown[]): Rec | null {
  return events.map(rec).find((e) => e.type === "system" && e.subtype === "init") ?? null;
}

export function claudeResult(events: unknown[]): Rec | null {
  const results = events.map(rec).filter((e) => e.type === "result");
  return results.length ? results[results.length - 1] : null;
}

function buildCommand(run: ClaudeStageRun): Command {
  const argv = [
    "claude", "-p", run.prompt,
    "--output-format", "stream-json", "--verbose",
    "--model", run.model,
    "--max-turns", String(run.bounds.max_turns),
    "--max-budget-usd", String(run.bounds.max_cost_usd),
    "--session-id", run.sessionId,
    "--permission-mode", "dontAsk",
  ];
  if (run.effort) argv.push("--effort", run.effort);
  if (run.fallbackModel) argv.push("--fallback-model", run.fallbackModel);
  const tools = run.profile && run.profile.tools.length ? run.profile.tools : ["Read", "Glob", "Grep"];
  // Absolute-path permission rule: the // prefix replaces the leading slash (Write(//tmp/x) means /tmp/x); syntax to be confirmed at the AC-29 hand-run.
  const writeResult = `Write(/${run.resultPath})`;
  argv.push("--add-dir", dirname(run.resultPath));
  argv.push("--allowedTools", [...tools, writeResult].join(","));
  return { argv, env: { CI: "true", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(run.bounds.timeout_min * 60_000) } };
}

function judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const result = claudeResult(events);
  const retries = events.map(rec).filter((e) => e.type === "system" && e.subtype === "api_retry");
  const retryStatus = retries.length ? Number(retries[retries.length - 1].error_status) : null;
  const apiErrorStatus = (result && typeof result.api_error_status === "number" ? result.api_error_status : null) ?? retryStatus;
  const finalText = result && typeof result.result === "string" ? result.result : null;
  if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus, finalText };
  if (!result) return { outcome: "failed", reason: "no result event", apiErrorStatus, finalText };
  const subtype = String(result.subtype ?? "");
  if (subtype === "error_max_turns" || subtype === "error_max_budget_usd") {
    return { outcome: "bounds", reason: subtype === "error_max_turns" ? "max turns reached" : "max budget reached", apiErrorStatus, finalText };
  }
  if (result.is_error === true) return { outcome: "failed", reason: finalText ?? subtype, apiErrorStatus, finalText };
  const init = claudeInit(events);
  const pluginErrors = (init?.plugin_errors as unknown[] | undefined) ?? [];
  const mcpErrors = (init?.mcp_server_errors as unknown[] | undefined) ?? [];
  if (pluginErrors.length || mcpErrors.length) {
    return { outcome: "failed", reason: `plugin errors: ${JSON.stringify([...pluginErrors, ...mcpErrors])}`, apiErrorStatus, finalText };
  }
  if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus, finalText };
  return { outcome: "ok", reason: null, apiErrorStatus, finalText };
}

function usage(events: unknown[]): Usage {
  const assistants = events.map(rec).filter((e) => e.type === "assistant");
  const tool_calls = assistants.reduce((n, e) => {
    const content = (rec(e.message).content as unknown[] | undefined) ?? [];
    return n + content.filter((c) => rec(c).type === "tool_use").length;
  }, 0);
  const result = claudeResult(events);
  if (result) {
    const u = rec(result.usage);
    return {
      cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
      input_tokens: Number(u.input_tokens ?? 0),
      output_tokens: Number(u.output_tokens ?? 0),
      cache_read_tokens: Number(u.cache_read_input_tokens ?? 0),
      cache_write_tokens: Number(u.cache_creation_input_tokens ?? 0),
      turns: Number(result.num_turns ?? 0),
      tool_calls,
    };
  }
  const sum = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  for (const e of assistants) {
    const u = rec(rec(e.message).usage);
    sum.input_tokens += Number(u.input_tokens ?? 0);
    sum.output_tokens += Number(u.output_tokens ?? 0);
    sum.cache_read_tokens += Number(u.cache_read_input_tokens ?? 0);
    sum.cache_write_tokens += Number(u.cache_creation_input_tokens ?? 0);
  }
  return { cost_usd: null, ...sum, turns: assistants.length, tool_calls };
}

export const claudeAdapter: Adapter = { harness: "claude", buildCommand, judge, usage };
