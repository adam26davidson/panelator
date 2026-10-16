import type { Adapter, Command, Judgement, StageRun, Usage } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (e: unknown): Rec => (typeof e === "object" && e !== null ? (e as Rec) : {});

export interface PiStageRun extends StageRun {
  extensions?: string[];
}

/** I5: tools plan and review never get, whatever the profile allows. */
const WRITE_TOOLS = ["edit", "write", "bash"];

/** Claude Code tool names (as profiles list them) to pi's. */
const PI_TOOL: Record<string, string> = { read: "read", edit: "edit", write: "write", bash: "bash", glob: "find", grep: "grep" };

/** What plan and review get when no profile narrows it. */
const READ_ONLY_TOOLS = ["read", "grep", "find"];

export function piToolNames(tools: string[]): string[] {
  // Own keys only: a profile naming `toString` or `constructor` must be dropped, not resolved through Object.prototype.
  const mapped = tools.map((t) => t.toLowerCase()).filter((k) => Object.hasOwn(PI_TOOL, k)).map((k) => PI_TOOL[k]);
  return [...new Set(mapped)];
}

function buildCommand(run: PiStageRun): Command {
  const argv = ["pi", "--mode", "json", "--model", run.model, "--session-id", run.sessionId, "--approve"];
  if (run.effort) argv.push("--thinking", run.effort);
  const readOnly = run.stage === "plan" || run.stage === "review";
  let tools: string[] = [];
  if (run.profile) {
    tools = piToolNames(run.profile.tools);
    if (readOnly) {
      tools = tools.filter((t) => !WRITE_TOOLS.includes(t));
      if (!tools.length) tools = READ_ONLY_TOOLS;
    }
  } else if (readOnly) {
    tools = READ_ONLY_TOOLS;
  }
  if (tools.length) argv.push("--tools", tools.join(","));
  if (run.profile) argv.push("--skill", run.profile.skillsDir);
  for (const e of run.extensions ?? []) argv.push("-e", e);
  argv.push(run.prompt);
  return { argv, env: { CI: "true" } };
}

function lastAssistant(events: unknown[]): Rec | null {
  const ends = events.map(rec).filter((e) => e.type === "message_end" && rec(e.message).role === "assistant");
  if (ends.length) return rec(ends[ends.length - 1].message);
  const end = events.map(rec).find((e) => e.type === "agent_end");
  const msgs = ((end?.messages as unknown[] | undefined) ?? []).map(rec).filter((m) => m.role === "assistant");
  return msgs.length ? msgs[msgs.length - 1] : null;
}

function textOf(msg: Rec | null): string | null {
  if (!msg) return null;
  const content = (msg.content as unknown[] | undefined) ?? [];
  const text = content.map(rec).filter((c) => c.type === "text").map((c) => String(c.text ?? "")).join("");
  return text || null;
}

function judge(events: unknown[], exitCode: number | null, timedOut: boolean): Judgement {
  const last = lastAssistant(events);
  const finalText = textOf(last);
  const errorMessage = last && typeof last.errorMessage === "string" ? last.errorMessage : null;
  const statusMatch = errorMessage ? /\((\d{3})\)/.exec(errorMessage) : null;
  const apiErrorStatus = statusMatch ? Number(statusMatch[1]) : null;
  if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus, finalText };
  const bounds = events.map(rec).find((e) => e.type === "scheduler_bounds");
  if (bounds) return { outcome: "bounds", reason: String(bounds.reason), apiErrorStatus, finalText };
  if (!events.map(rec).some((e) => e.type === "agent_end")) return { outcome: "failed", reason: "no agent_end event", apiErrorStatus, finalText };
  const stop = last ? String(last.stopReason ?? "") : "";
  if (stop === "error" || stop === "aborted") return { outcome: "failed", reason: errorMessage ?? `assistant ${stop}`, apiErrorStatus, finalText };
  if (!last) return { outcome: "failed", reason: "no assistant message", apiErrorStatus, finalText };
  if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus, finalText };
  return { outcome: "ok", reason: null, apiErrorStatus, finalText };
}

function usage(events: unknown[]): Usage {
  const u = { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 0, tool_calls: 0 };
  for (const e of events.map(rec)) {
    if (e.type === "turn_end") u.turns++;
    if (e.type === "tool_execution_start") u.tool_calls++;
    if (e.type === "message_end" && rec(e.message).role === "assistant") {
      const m = rec(rec(e.message).usage);
      u.input_tokens += Number(m.input ?? 0);
      u.output_tokens += Number(m.output ?? 0);
      u.cache_read_tokens += Number(m.cacheRead ?? 0);
      u.cache_write_tokens += Number(m.cacheWrite ?? 0);
      u.cost_usd += Number(rec(m.cost).total ?? 0);
    }
  }
  u.cost_usd = Math.round(u.cost_usd * 1e8) / 1e8;
  return u;
}

export const piAdapter: Adapter = { harness: "pi", buildCommand, judge, usage, isTurnEnd: (e) => rec(e).type === "turn_end" };
