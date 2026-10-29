import { describe, expect, it } from "vitest";
import { RequestError } from "octokit";
import { forgiveTransientChainErrors, outageBackoffS, OUTAGE_ALARM_MS, transientCause } from "../src/chain/transient.ts";
import { ledgerOf, initialChainState, POSTPONE_WAIT_S } from "../src/chain/machine.ts";

const errno = (code: string, message = `${code} x`) => Object.assign(new Error(message), { code });
const gh = (status: number, message = "x", headers: Record<string, string> = {}) =>
  new RequestError(message, status, { request: { method: "GET", url: "https://api.github.com/x", headers: {} }, response: { status, url: "", headers, data: { message } } });
/** What a failed execFile of git looks like: the message carries the command and git's stderr. */
const gitErr = (cmd: string, stderr: string) => Object.assign(new Error(`Command failed: git ${cmd}\n${stderr}`), { code: 128, stderr });

describe("transientCause (spec 015 AC-4)", () => {
  it("classifies DNS and socket errors by code", () => {
    expect(transientCause(errno("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.github.com"))).toBe("EAI_AGAIN");
    expect(transientCause(errno("ENOTFOUND"))).toBe("ENOTFOUND");
    expect(transientCause(errno("ECONNRESET", "read ECONNRESET"))).toBe("ECONNRESET");
    expect(transientCause(errno("ETIMEDOUT"))).toBe("ETIMEDOUT");
    expect(transientCause(errno("UND_ERR_CONNECT_TIMEOUT"))).toBe("UND_ERR_CONNECT_TIMEOUT");
    expect(transientCause(new Error("socket hang up"))).toBe("socket hang up");
  });

  it("looks through Octokit's wrapped fetch failure to its cause", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: errno("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.github.com") });
    const wrapped = Object.assign(new RequestError("getaddrinfo EAI_AGAIN api.github.com", 500, { request: { method: "GET", url: "u", headers: {} } }), { cause: fetchFailed });
    expect(transientCause(wrapped)).toBe("EAI_AGAIN");
    // A message alone carries the code too (an error rethrown with the message only).
    expect(transientCause(new Error("getaddrinfo EAI_AGAIN api.github.com"))).toBe("EAI_AGAIN");
  });

  it("classifies GitHub 5xx as transient and 4xx, rate limits included, as genuine", () => {
    expect(transientCause(gh(502, "Bad Gateway"))).toBe("HTTP 502");
    expect(transientCause(gh(503, "Service Unavailable"))).toBe("HTTP 503");
    expect(transientCause(gh(404, "Not Found"))).toBeNull();
    expect(transientCause(gh(422, "Validation Failed"))).toBeNull();
    expect(transientCause(gh(403, "You have exceeded a secondary rate limit", { "retry-after": "60" }))).toBeNull();
    expect(transientCause(gh(429, "API rate limit exceeded"))).toBeNull();
  });

  it("classifies git transport failures by git's message", () => {
    expect(transientCause(gitErr("fetch -q origin", "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com"))).toBe("Could not resolve host");
    expect(transientCause(gitErr("ls-remote --heads origin x", "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\nfatal: Could not read from remote repository."))).toBe("Could not resolve hostname");
    expect(transientCause(gitErr("push", "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"))).toBe("RPC failed");
    expect(transientCause(gitErr("fetch", "fatal: The remote end hung up unexpectedly"))).toBe("The remote end hung up unexpectedly");
  });

  it("classifies everything else as genuine", () => {
    expect(transientCause(gitErr("rebase origin/main", "CONFLICT (content): Merge conflict in a.txt"))).toBeNull();
    expect(transientCause(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBeNull();
    expect(transientCause(new Error("boom"))).toBeNull();
    expect(transientCause("a string")).toBeNull();
    expect(transientCause(null)).toBeNull();
  });

  it("stops after five levels of cause", () => {
    let e: Error = errno("EAI_AGAIN");
    for (let i = 0; i < 6; i++) e = Object.assign(new Error(`wrap ${i}`), { cause: e });
    expect(transientCause(e)).toBeNull();
  });
});

describe("outageBackoffS (spec 015 AC-5)", () => {
  it("doubles from 60 s and caps at POSTPONE_WAIT_S", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(outageBackoffS)).toEqual([60, 120, 240, 480, 960, POSTPONE_WAIT_S, POSTPONE_WAIT_S, POSTPONE_WAIT_S]);
    expect(OUTAGE_ALARM_MS).toBe(2 * 3600_000);
  });
});

describe("forgiveTransientChainErrors (spec 015 AC-11)", () => {
  const base = ledgerOf(initialChainState(13));
  it("lowers chainErrors once per transient chain-error entry and marks the entry", () => {
    const ledger = { ...base, chainErrors: 1, history: ["plan attempt 1 failed: x", "chain error in verify: getaddrinfo EAI_AGAIN api.github.com"] };
    const r = forgiveTransientChainErrors(ledger);
    expect(r.forgiven).toBe(1);
    expect(r.ledger.chainErrors).toBe(0);
    expect(r.ledger.history).toEqual(["plan attempt 1 failed: x", "chain error in verify (transient, not counted): getaddrinfo EAI_AGAIN api.github.com"]);
    // Idempotent: a second pass forgives nothing.
    expect(forgiveTransientChainErrors(r.ledger)).toEqual({ ledger: r.ledger, forgiven: 0 });
  });
  it("keeps a genuine chain error and never goes below 0", () => {
    const ledger = { ...base, chainErrors: 0, history: ["chain error in fix: boom", "chain error in verify: Command failed: git fetch\nfatal: Could not resolve host: github.com"] };
    const r = forgiveTransientChainErrors(ledger);
    expect(r.forgiven).toBe(1);
    expect(r.ledger.chainErrors).toBe(0);
    expect(r.ledger.history[0]).toBe("chain error in fix: boom");
  });
});
