import { POSTPONE_WAIT_S, type LedgerCounts } from "./machine.ts";

/**
 * Spec 015: transient infrastructure failures (the network, DNS, GitHub's servers) are not defects of the chain. A driver
 * step that fails on one is retried with backoff and counts toward no bound, up to the outage's ceiling; every other
 * error is genuine.
 */

const CODES = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
/** A request its signal aborted or timed out (fetch's `AbortError`, `AbortSignal.timeout`'s `TimeoutError`). */
const ABORT_NAMES = new Set(["AbortError", "TimeoutError"]);
const CODE_IN_MESSAGE = new RegExp(`\\b(${[...CODES].join("|")})\\b`);
/** git's transport messages (https and ssh), matched whatever their case, in this order; the first match is the label. */
const GIT_MESSAGES = [
  "Could not resolve hostname", "Could not resolve host", "Temporary failure in name resolution", "Connection timed out", "Connection reset",
  "Failed to connect to", "The remote end hung up unexpectedly", "early EOF", "RPC failed", "socket hang up",
];
const GIT_HTTP_5XX = /The requested URL returned error: 5\d\d/i;
const MAX_DEPTH = 5;

/**
 * A short label for a transient error (its code, `HTTP <status>`, the abort's name or git's message), else null. Looks
 * through `cause` five levels deep. An HTTP 4xx is genuine whatever its message says, GitHub rate limits included, as
 * today: no spec plans GitHub rate-limit retries.
 */
export function transientCause(error: unknown): string | null {
  let e: unknown = error;
  for (let depth = 0; depth <= MAX_DEPTH && e !== null && e !== undefined; depth++) {
    if (typeof e !== "object") return null;
    const o = e as { code?: unknown; status?: unknown; message?: unknown; stderr?: unknown; cause?: unknown; name?: unknown };
    if (typeof o.status === "number" && o.status >= 400 && o.status <= 499) return null;
    if (typeof o.code === "string" && CODES.has(o.code)) return o.code;
    if (typeof o.name === "string" && ABORT_NAMES.has(o.name)) return o.name;
    if (typeof o.status === "number" && o.status >= 500 && o.status <= 599) {
      // Octokit reports a fetch that never got a response as a 500 whose message is the cause's: name the cause when it is there.
      return labelOf(String(o.message ?? "")) ?? `HTTP ${o.status}`;
    }
    const label = labelOf(`${typeof o.message === "string" ? o.message : ""}\n${typeof o.stderr === "string" ? o.stderr : ""}`);
    if (label) return label;
    e = o.cause;
  }
  return null;
}

function labelOf(text: string): string | null {
  const code = CODE_IN_MESSAGE.exec(text);
  if (code) return code[1];
  const lower = text.toLowerCase();
  for (const m of GIT_MESSAGES) if (lower.includes(m.toLowerCase())) return m;
  return GIT_HTTP_5XX.test(text) ? "HTTP 5xx" : null;
}

/** AC-5: the wait after the `count`th consecutive transient failure: 60 s, doubling, capped at POSTPONE_WAIT_S. */
export function outageBackoffS(count: number): number {
  return Math.min(60 * 2 ** Math.max(0, count - 1), POSTPONE_WAIT_S);
}

/** AC-8: an outage this long raises one notification, one finding and one infra_alarm event. */
export const OUTAGE_ALARM_MS = 2 * 3600_000;
/**
 * AC-13: an outage this long is no longer treated as transient: a deterministic failure (a host that does not resolve, a
 * port that refuses) would otherwise retry forever. Its failures count as genuine from then on.
 */
export const OUTAGE_CEILING_MS = 24 * 3600_000;
/**
 * AC-13: the outage's age is wall-clock time and counts a laptop asleep; its failures count as genuine only once this
 * many failed past the ceiling, spanning at least CEILING_MIN_SPAN_MS.
 */
export const CEILING_MIN_FAILURES = 3;
export const CEILING_MIN_SPAN_MS = 30 * 60_000;
/** AC-13: the prefix of the error a failure past the ceiling is counted with; the release's history entry carries it. */
export const PAST_CEILING = "outage past ceiling: ";

const CHAIN_ERROR_ENTRY = /^chain error in (\S+): ([\s\S]*)$/;

/**
 * AC-11: a chain-error release recorded for a transient cause before spec 015 is not counted. Each such history entry
 * is rewritten so it is forgiven once. An entry recorded since spec 015 reads `chain error in <stage> (counted): ...`
 * (a genuine error, or one past the outage ceiling) and never matches.
 */
export function forgiveTransientChainErrors<L extends Pick<LedgerCounts, "chainErrors" | "history">>(ledger: L): { ledger: L; forgiven: number } {
  let forgiven = 0;
  const history = ledger.history.map((entry) => {
    const m = CHAIN_ERROR_ENTRY.exec(entry);
    if (!m || transientCause(new Error(m[2])) === null) return entry;
    forgiven++;
    return `chain error in ${m[1]} (transient, not counted): ${m[2]}`;
  });
  if (!forgiven) return { ledger, forgiven };
  return { ledger: { ...ledger, history, chainErrors: Math.max(0, ledger.chainErrors - forgiven) }, forgiven };
}
