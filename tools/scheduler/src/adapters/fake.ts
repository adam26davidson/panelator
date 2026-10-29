import type { Adapter, StageRun } from "./types.ts";

export interface FakeOptions {
  events: unknown[];
  result?: unknown;
  exitCode?: number;
  scriptPath: string;
  sleepMs?: number;
  eventsFile?: string;
  /** When set, records of this type count as turn ends (lets runner tests exercise max_turns). */
  turnEndType?: string;
}

const rec = (e: unknown): Record<string, unknown> => (typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {});

/** Replays a recorded stream through a throwaway script and writes a canned result (spec section 13). */
export function fakeAdapter(opts: FakeOptions): Adapter & { opts: FakeOptions; runs:StageRun[] } {
  const runs:StageRun[]=[];
  return {
    runs,
    harness: "fake",
    opts,
    buildCommand(run: StageRun) {
      runs.push(run);
      const argv = [
        process.execPath, opts.scriptPath, opts.eventsFile ?? "", run.resultPath, String(opts.exitCode ?? 0), String(opts.sleepMs ?? 0),
      ];
      if (opts.result !== undefined) argv.push(JSON.stringify(opts.result));
      return { argv, env: {} };
    },
    judge(_events, exitCode, timedOut) {
      if (timedOut) return { outcome: "timeout", reason: "stage timeout", apiErrorStatus: null, finalText: null };
      if (exitCode !== 0) return { outcome: "failed", reason: `exit ${exitCode}`, apiErrorStatus: null, finalText: null };
      return { outcome: "ok", reason: null, apiErrorStatus: null, finalText: "fake" };
    },
    usage() {
      return { cost_usd: null, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0 };
    },
    ...(opts.turnEndType !== undefined ? { isTurnEnd: (e: unknown) => rec(e).type === opts.turnEndType } : {}),
  };
}
