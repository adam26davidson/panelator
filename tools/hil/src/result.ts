import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

export type Outcome = "pass" | "fail" | "bricked" | "absent";
export type Kind = "pr" | "main" | "soak";
export type BoardStatus = "ok" | "bricked" | "absent";

export interface BoardFields {
  status: BoardStatus;
  firmware_sha: string | null;
  uptime_s: number | null;
  resets: number | null;
  free_heap: number | null;
  free_psram: number | null;
}

export interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  duration_ms: number;
  message?: string;
}

export interface HilResult {
  outcome: Outcome;
  kind: Kind;
  sha: string;
  run_id: number;
  board: BoardFields;
  tests: TestResult[];
  reason?: string;
  log: string;
}

export const LOG_LIMIT = 32 * 1024;

export function emptyBoard(status: BoardStatus): BoardFields {
  return { status, firmware_sha: null, uptime_s: null, resets: null, free_heap: null, free_psram: null };
}

/** The tail of `text`, at most `limit` bytes of UTF-8, starting at a line boundary. */
export function cutLog(text: string, limit = LOG_LIMIT): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= limit) return text;
  let start = buf.length - limit;
  // The cut is on a line boundary when the byte before it ends a line; otherwise drop the partial line.
  if (buf[start - 1] !== 0x0a) {
    const nl = buf.indexOf(0x0a, start);
    start = nl === -1 ? buf.length : nl + 1;
  }
  return buf.subarray(start).toString("utf8");
}

const schemaUrl = new URL("../../../schemas/scheduler/hil-result.json", import.meta.url);
let validator: ((data: unknown) => boolean) | undefined;
let lastErrors = "";

/** Validates against schemas/scheduler/hil-result.json; returns the error text, or null when valid. */
export function schemaErrors(result: unknown): string | null {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaUrl, "utf8")) as object);
    validator = (data) => {
      const ok = validate(data) as boolean;
      lastErrors = ok ? "" : ajv.errorsText(validate.errors);
      return ok;
    };
  }
  return validator(result) ? null : lastErrors;
}
