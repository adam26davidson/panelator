import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, DEFAULT_QUOTA_PARAMS, blocking, observeRun, planLaunch, quotaSummary, readBook, waitAfterLimit } from "../src/quota/book.ts";
import { keyCovers, parseLimit, parseReset } from "../src/quota/parse.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { UsageRecord } from "../src/state/runs.ts";

const SESSION = "You've hit your session limit · resets 8:10am (Europe/Berlin)";
const FABLE = "You've reached your Fable limit. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
const at = (s: string) => new Date(s);

describe("parseLimit (spec 013 AC-1 to AC-3)", () => {
  it("reads a session limit's reset in its zone, today or tomorrow", () => {
    expect(parseLimit(SESSION, "claude", "claude-fable-5-1", at("2026-10-29T02:58:53Z"))).toEqual({ key: "claude", scope: "session", resetsAt: at("2026-10-29T07:10:00Z") });
    // 8:10 Berlin already passed: tomorrow.
    expect(parseLimit(SESSION, "claude", "claude-fable-5-1", at("2026-10-29T08:00:00Z")).resetsAt).toEqual(at("2026-10-30T07:10:00Z"));
    // Before the DST change Berlin is UTC+2.
    expect(parseLimit(SESSION, "claude", "x", at("2026-10-20T03:00:00Z")).resetsAt).toEqual(at("2026-10-20T06:10:00Z"));
  });
  it("reads hours without minutes, 24-hour times, a date and weekly limits", () => {
    const now = at("2026-10-29T12:00:00Z");
    expect(parseReset("3am", "Europe/Berlin", now)).toEqual(at("2026-10-30T02:00:00Z"));
    expect(parseReset("15:10", "UTC", now)).toEqual(at("2026-10-29T15:10:00Z"));
    expect(parseReset("12pm", "UTC", at("2026-10-29T11:00:00Z"))).toEqual(at("2026-10-29T12:00:00Z"));
    expect(parseReset("12am", "UTC", now)).toEqual(at("2026-10-30T00:00:00Z"));
    expect(parseReset("Nov 3, 9am", "Europe/Berlin", now)).toEqual(at("2026-11-03T08:00:00Z"));
    expect(parseLimit("You've hit your weekly limit · resets Nov 3, 9am (Europe/Berlin)", "claude", "m", now)).toEqual({ key: "claude", scope: "weekly", resetsAt: at("2026-11-03T08:00:00Z") });
  });
  it("reads model limits, with or without a reset", () => {
    expect(parseLimit(FABLE, "claude", "claude-fable-5-1", at("2026-10-29T07:15:00Z"))).toEqual({ key: "claude:fable", scope: "model", resetsAt: null });
    expect(parseLimit("You've hit your Opus limit · resets 9pm (UTC)", "claude", "claude-opus-5-5", at("2026-10-29T07:15:00Z"))).toEqual({ key: "claude:opus", scope: "model", resetsAt: at("2026-10-29T21:00:00Z") });
  });
  it("keys an unrecognised message, zone or time by harness and model with no reset", () => {
    expect(parseLimit("rate limited (429)", "pi", "openai/gpt-6.1-sol", at("2026-10-29T07:15:00Z"))).toEqual({ key: "pi:openai/gpt-6.1-sol", scope: "unknown", resetsAt: null });
    expect(parseLimit("You've hit your session limit · resets 8:10am (Mars/Olympus)", "claude", "m", at("2026-10-29T07:15:00Z")).resetsAt).toBeNull();
    expect(parseLimit("You've hit your session limit · resets soon (UTC)", "claude", "m", at("2026-10-29T07:15:00Z")).resetsAt).toBeNull();
    expect(parseLimit(null, "claude", "m", at("2026-10-29T07:15:00Z")).key).toBe("claude:m");
  });
  it("matches keys against models", () => {
    expect(keyCovers("claude", "claude", "claude-opus-5-5")).toBe(true);
    expect(keyCovers("claude", "pi", "openai/gpt-6.1-sol")).toBe(false);
    expect(keyCovers("claude:fable", "claude", "claude-fable-5-1")).toBe(true);
    expect(keyCovers("claude:fable", "claude", "claude-opus-5-5")).toBe(false);
    expect(keyCovers("pi:openai/gpt-6.1-sol", "pi", "openai/gpt-6.1-sol")).toBe(true);
  });
});

function setup() {
  const paths = statePaths(mkdtempSync(join(tmpdir(), "quota-")));
  return paths;
}
let n = 0;
function usage(over: Partial<UsageRecord>): UsageRecord {
  return {
    run_id: `r${n++}`, issue: 1, stage: "review", attempt: 1, outcome: "ok", harness: "claude", model: "claude-fable-5-1", cost_usd: 4, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, turns: 1, tool_calls: 0, wall_seconds: 3, started_at: "2026-10-29T02:10:00Z", ended_at: "2026-10-29T02:15:00Z", events_path: "", ...over,
  };
}
const ok = { outcome: "ok" as const, reason: null, apiErrorStatus: null, finalText: null };
const limited = (reason: string) => ({ outcome: "failed" as const, reason, apiErrorStatus: 429, finalText: null });
const strong = { what: "issue:1", stage: "review", tier: "strong" as const, harness: "claude" as const, model: "claude-fable-5-1" };

describe("the quota book", () => {
  it("records a stated limit and blocks every Claude model until it (AC-4, AC-6)", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    const now = at("2026-10-29T02:58:53Z");
    const l = await observeRun(paths, usage({ outcome: "failed", started_at: now.toISOString() }), limited(SESSION), now);
    expect(l).toMatchObject({ key: "claude", scope: "session", resets_at: "2026-10-29T07:10:00.000Z", source: "stated" });
    const book = await readBook(paths);
    expect(blocking(book, "claude", "claude-opus-5-5", now)?.key).toBe("claude");
    expect(blocking(book, "pi", "openai/gpt-6.1-sol", now)).toBeNull();
    expect(blocking(book, "claude", "claude-opus-5-5", at("2026-10-29T07:10:00Z"))).toBeNull();
    const d = await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, now);
    expect(d).toMatchObject({ kind: "wait", until: "2026-10-29T07:10:00.000Z", key: "claude" });
    // AC-9: a session limit is never routed to another Claude model.
    expect(await planLaunch(paths, { ...strong, what: "x" }, DEFAULT_QUOTA_PARAMS, now)).toMatchObject({ kind: "wait" });
    // A standard stage goes straight to its own fallback.
    expect(await planLaunch(paths, { what: "issue:2", stage: "implement", tier: "standard", harness: "claude", model: "claude-sonnet-5-5", fallback: "openai/gpt-6.1-sol" }, DEFAULT_QUOTA_PARAMS, now))
      .toMatchObject({ kind: "run", model: "openai/gpt-6.1-sol", harness: "pi" });
    expect(quotaSummary(await readBook(paths), now)).toEqual({
      limits: [{ key: "claude", scope: "session", resets_at: "2026-10-29T07:10:00.000Z", source: "stated" }],
      waiting: [{ what: "issue:1", until: "2026-10-29T07:10:00.000Z", key: "claude" }, { what: "x", until: "2026-10-29T07:10:00.000Z", key: "claude" }],
    });
    // A launch that runs clears its waiting entry.
    await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, at("2026-10-29T07:11:00Z"));
    expect(Object.keys((await readBook(paths)).waiting)).toEqual(["x"]);
  });

  it("backs off exponentially on a limit with no reset, up to 4 hours, and a success clears it (AC-3)", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    let now = at("2026-10-29T07:15:00Z");
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const l = (await observeRun(paths, usage({ outcome: "failed", cost_usd: 0, started_at: now.toISOString() }), limited(FABLE), now))!;
      waits.push((Date.parse(l.resets_at) - now.getTime()) / 60_000);
      now = new Date(l.resets_at);
    }
    expect(waits).toEqual([15, 30, 60, 120, 240, BACKOFF_MAX_MS / 60_000]);
    await observeRun(paths, usage({ started_at: now.toISOString() }), ok, now);
    const book = await readBook(paths);
    expect(book.backoff).toEqual({});
    expect(book.limits).toEqual({});
  });

  it("moves a strong stage to the fallback model on a model limit only, as the parameter allows (AC-9)", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    const now = at("2026-10-29T07:15:00Z");
    await observeRun(paths, usage({ outcome: "failed", cost_usd: 0, started_at: now.toISOString() }), limited(FABLE), now);
    expect(await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, now)).toEqual({ kind: "run", model: "claude-opus-5-5", harness: "claude", note: { kind: "quota-fallback", from: "claude-fable-5-1", key: "claude:fable" } });
    expect(await planLaunch(paths, strong, { ...DEFAULT_QUOTA_PARAMS, modelFallback: false }, now)).toMatchObject({ kind: "wait", key: "claude:fable", until: "2026-10-29T07:30:00.000Z" });
    // An Opus stage is not covered by the Fable limit.
    expect(await planLaunch(paths, { ...strong, model: "claude-opus-5-5" }, DEFAULT_QUOTA_PARAMS, now)).toEqual({ kind: "run", model: "claude-opus-5-5", harness: "claude" });
    // Fallback model limited too: wait.
    await observeRun(paths, usage({ outcome: "failed", cost_usd: 0, model: "claude-opus-5-5" }), limited("You've hit your Opus limit · resets 9pm (UTC)"), now);
    expect(await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, now)).toMatchObject({ kind: "wait", key: "claude:fable" });
  });

  it("samples window capacity and defers a strong stage likely to be cut off (AC-8)", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    // Two windows that each held $40 before the session limit.
    for (const [start, hit, reset] of [["2026-10-28T21:10:00Z", "2026-10-28T22:31:00Z", "3:10am"], ["2026-10-29T02:10:00Z", "2026-10-29T02:58:00Z", "8:10am"]]) {
      for (let i = 0; i < 9; i++) await observeRun(paths, usage({ started_at: new Date(Date.parse(start) + i * 60_000).toISOString(), cost_usd: 4 }), ok, at(start));
      await observeRun(paths, usage({ outcome: "failed", cost_usd: 4, started_at: hit }), limited(`You've hit your session limit · resets ${reset} (Europe/Berlin)`), at(hit));
      // A second hit in the same window does not sample again.
      await observeRun(paths, usage({ outcome: "failed", cost_usd: 0, started_at: hit }), limited(`You've hit your session limit · resets ${reset} (Europe/Berlin)`), at(hit));
    }
    let book = await readBook(paths);
    expect(book.capacity).toEqual([40, 40]);
    expect(book.window).toMatchObject({ start: "2026-10-29T02:10:00.000Z", end: "2026-10-29T07:10:00.000Z" });
    // A new window after the reset: $34 spent, review estimate $4, capacity $40: runs; at $37 spent: defers.
    const w = "2026-10-29T07:10:30Z";
    for (let i = 0; i < 17; i++) await observeRun(paths, usage({ stage: "implement", model: "claude-sonnet-5-5", cost_usd: 2, started_at: w }), ok, at(w));
    book = await readBook(paths);
    expect(book.window).toMatchObject({ start: "2026-10-29T07:10:30.000Z", end: "2026-10-29T12:10:30.000Z", spent_usd: 34 });
    const later = at("2026-10-29T09:00:00Z");
    expect(await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, later)).toEqual({ kind: "run", model: "claude-fable-5-1", harness: "claude" });
    await observeRun(paths, usage({ stage: "implement", model: "claude-sonnet-5-5", cost_usd: 3, started_at: "2026-10-29T09:00:00Z" }), ok, later);
    expect(await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, later)).toMatchObject({ kind: "wait", until: "2026-10-29T12:10:30.000Z", defer: { estimate: 4, spent: 37, capacity: 40 } });
    // Standard tier is not deferred; planning off is not deferred.
    expect(await planLaunch(paths, { ...strong, tier: "standard", stage: "implement", model: "claude-sonnet-5-5" }, DEFAULT_QUOTA_PARAMS, later)).toMatchObject({ kind: "run" });
    expect(await planLaunch(paths, strong, { ...DEFAULT_QUOTA_PARAMS, planWindows: false }, later)).toMatchObject({ kind: "run" });
  });

  it("seeds stage estimates from the usage records on disk", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    mkdirSync(paths.usage, { recursive: true });
    writeFileSync(join(paths.usage, "a.json"), JSON.stringify(usage({ run_id: "a", cost_usd: 3 })));
    writeFileSync(join(paths.usage, "b.json"), JSON.stringify(usage({ run_id: "b", cost_usd: 0, outcome: "failed" })));
    await planLaunch(paths, strong, DEFAULT_QUOTA_PARAMS, at("2026-10-29T09:00:00Z"));
    expect((await readBook(paths)).costs).toEqual({ "review|claude-fable-5-1": [3] });
  });

  it("waitAfterLimit uses the blocking limit, else a short backoff", async () => {
    const paths = setup(); await ensureStateDirs(paths);
    const now = at("2026-10-29T02:58:53Z");
    expect(await waitAfterLimit(paths, "agent:f", "claude", "claude-fable-5-1", now)).toMatchObject({ until: "2026-10-29T03:13:53.000Z" });
    await observeRun(paths, usage({ outcome: "failed", started_at: now.toISOString() }), limited(SESSION), now);
    expect(await waitAfterLimit(paths, "agent:f", "claude", "claude-fable-5-1", now)).toMatchObject({ until: "2026-10-29T07:10:00.000Z", key: "claude" });
  });
});
