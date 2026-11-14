import { dirname } from "node:path";
import { DISK_FULL } from "../chain/transient.ts";
import type { Adapter, ApiRetries, Command, Judgement, StageRun, Usage } from "./types.ts";

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
    ...(run.resume?['--resume',run.resume.sessionId]:['--session-id',run.sessionId]),
    "--permission-mode", "dontAsk",
    // A run must not inherit the maintainer's desktop: no user MCP servers or claude.ai connectors, and no user settings,
    // which is where the hooks and enabled plugins come from. Login is not a setting, so subscription auth still works;
    // "project" keeps the profile skills linked at .claude/skills, and AGENTS.md loads regardless.
    "--strict-mcp-config",
    "--setting-sources", "project",
  ];
  if (run.effort) argv.push("--effort", run.effort);
  if (run.fallbackModel) argv.push("--fallback-model", run.fallbackModel);
  // I5: plan, review and the question check only read, whatever the profile allows; the result file is their one write.
  const readOnly = run.conversation || run.stage === "plan" || run.stage === "review" || run.stage === "question-check";
  const tools = !readOnly && run.profile && run.profile.tools.length ? run.profile.tools : ["Read", "Glob", "Grep"];
  // Absolute-path permission rule: the // prefix replaces the leading slash (Edit(//tmp/x) means /tmp/x). Claude Code
  // matches file-path rules for Edit and Read only; an Edit rule also covers the Write tool, while a Write(path) rule
  // is accepted but never consulted (confirmed at the AC-29 hand-run: the plan stage's result write was denied).
  const writeResult = `Edit(/${run.resultPath})`;
  argv.push("--add-dir", dirname(run.resultPath));
  argv.push("--allowedTools", [...tools, writeResult].join(","));
  if(run.conversation)argv.push('--tools','Read,Glob,Grep,Write,Edit');
  return { argv, env: { CI: "true", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(run.bounds.timeout_min * 60_000) } };
}

const isRetry = (e: Rec): boolean => e.type === "system" && e.subtype === "api_retry";
const isObject = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Spec 061 AC-2: the count of `api_retry` records, how many had `no_response`, and what the last one said; undefined with none. */
export function claudeApiRetries(events: unknown[]): ApiRetries | undefined {
  const retries = events.map(rec).filter(isRetry);
  if (!retries.length) return undefined;
  const last = retries[retries.length - 1];
  const nr = isObject(last.no_response) ? last.no_response : null;
  return {
    count: retries.length,
    noResponses: retries.filter((r) => isObject(r.no_response)).length,
    last: {
      status: num(last.error_status),
      error: typeof last.error === "string" ? last.error : null,
      noResponse: nr ? { waitedMs: num(nr.waited_ms), retryWaitMs: num(nr.retry_wait_ms) } : null,
    },
  };
}

function judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const j = judgeOutcome(events, exitCode, timedOut);
  const apiRetries = claudeApiRetries(events);
  return apiRetries ? { ...j, apiRetries } : j;
}

function judgeOutcome(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const result = claudeResult(events);
  const retries = events.map(rec).filter(isRetry);
  const lastRetryStatus = retries.length ? retries[retries.length - 1].error_status : null;
  const retryStatus = typeof lastRetryStatus === "number" ? lastRetryStatus : null;
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

const REFUSAL_PREFIX = "The command was not started:";

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (typeof c === "string" ? c : String(rec(c).text ?? ""))).join("");
}

/**
 * Spec 059 AC-2: `ENOSPC` when the run has a Bash call and every one was answered with the harness's "not started"
 * refusal for a full disk; null otherwise (no Bash call, a Bash call that ran, or one with no result).
 */
export function claudeHostRefusal(events: unknown[]): string | null {
  const calls: string[] = [];
  const results = new Map<string, string>();
  for (const e of events.map(rec)) {
    const content = rec(e.message).content;
    if (!Array.isArray(content)) continue;
    for (const b of content.map(rec)) {
      if (e.type === "assistant" && b.type === "tool_use" && b.name === "Bash" && typeof b.id === "string") calls.push(b.id);
      else if (e.type === "user" && b.type === "tool_result" && typeof b.tool_use_id === "string") results.set(b.tool_use_id, resultText(b.content));
    }
  }
  if (!calls.length) return null;
  for (const id of calls) {
    const text = results.get(id);
    if (text === undefined || !text.startsWith(REFUSAL_PREFIX) || !text.includes("ENOSPC")) return null;
  }
  return DISK_FULL;
}

export const claudeAdapter: Adapter = { harness: "claude", buildCommand, judge, usage, hostRefusal: claudeHostRefusal };
