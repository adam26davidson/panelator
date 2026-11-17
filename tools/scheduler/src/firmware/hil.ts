import type { CheckRunDetail } from "../github/types.ts";
import { validate } from "./validate.ts";
import { record } from "../events/store.ts";
import type { StatePaths } from "../state/paths.ts";

/** The JSON of section 8 of spec 070, read from a completed HIL check's `output.text`. */
export interface HilResult {
  outcome: "pass" | "fail" | "bricked" | "absent";
  kind: "pr" | "main" | "soak";
  sha: string;
  run_id: number;
  board: { status: "ok" | "bricked" | "absent"; firmware_sha: string | null; uptime_s: number; resets: number; free_heap: number; free_psram: number };
  tests: { name: string; status: "pass" | "fail" | "skip"; duration_ms: number; message?: string }[];
  reason?: string;
  log: string;
}

export type HilRead = { ok: true; result: HilResult } | { ok: false; error: string };

/** AC-2: the output must be one JSON object validating against `hil-result.json`; otherwise the first error. */
export function parseHilOutput(text: string | null | undefined): HilRead {
  let data: unknown;
  try {
    data = JSON.parse(text ?? "");
  } catch (e) {
    return { ok: false, error: `output is not JSON: ${(e as Error).message}` };
  }
  const v = validate("hil-result", data);
  return v.ok ? { ok: true, result: data as HilResult } : { ok: false, error: v.errors[0] ?? "invalid" };
}

/** AC-2, spec 056: one line per failed test, then the last 200 lines of the serial log. */
export function hilFixLines(r: HilResult): string {
  const failed = r.tests.filter((t) => t.status === "fail").map((t) => `${t.name}: ${t.message ?? ""}`.trimEnd());
  const tail = r.log.split("\n").slice(-200).join("\n");
  return [...failed, tail].filter(Boolean).join("\n");
}

/** What a chain's verify makes of the HIL check run on a head. */
export type HilVerdict =
  | { state: "pending" }
  | { state: "passed"; result: HilResult; run: CheckRunDetail }
  | { state: "failed"; lines: string; result?: HilResult; run: CheckRunDetail }
  | { state: "board"; result: HilResult; run: CheckRunDetail };

/** The latest HIL check run on a commit decides; a completed one is read, an unfinished or absent one is pending. */
export function hilVerdict(runs: CheckRunDetail[]): HilVerdict {
  const run = [...runs].sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== "completed") return { state: "pending" };
  const read = parseHilOutput(run.output_text);
  if (!read.ok) return { state: "failed", lines: `HIL result invalid: ${read.error}`, run };
  const r = read.result;
  if (r.outcome === "bricked" || r.outcome === "absent") return { state: "board", result: r, run };
  if (r.outcome === "pass" && run.conclusion === "success") return { state: "passed", result: r, run };
  return { state: "failed", lines: hilFixLines(r), result: r, run };
}

/** AC-2: one `hil.result` event per result read; the payload is the result without `log`. */
export async function recordHilResult(paths: StatePaths, at: Date, r: HilResult, checkRunId: number, pr?: number): Promise<void> {
  const { log: _log, ...rest } = r;
  await record(paths, "hil.result", at, { ...rest, check_run_id: checkRunId, ...(pr === undefined ? {} : { pr }) });
}
