import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Judgement } from "../adapters/types.ts";
import type { ParameterStore } from "../parameters/store.ts";
import { withStateLock } from "../parameters/store.ts";
import { parseDuration } from "../standing/registry.ts";
import type { StatePaths } from "../state/paths.ts";
import type { UsageRecord } from "../state/runs.ts";
import type { Harness, Tier } from "../types.ts";
import { keyCovers, parseLimit, type LimitScope } from "./parse.ts";

/** Spec 013: the quota book, `quota.json` in the state directory. */
export interface Limit {
  key: string;
  scope: LimitScope;
  resets_at: string;
  source: "stated" | "backoff";
  reason: string;
  hit_at: string;
  run_id: string;
}
export interface Waiting { until: string; key: string; reason: string; since: string }
export interface Book {
  limits: Record<string, Limit>;
  /** Consecutive backoff hits per key (AC-3). */
  backoff: Record<string, number>;
  /** The Claude session window (AC-8). */
  window: { start: string; end: string; spent_usd: number; sampled: boolean } | null;
  /** Window spend at the moment a session limit was hit, last five. */
  capacity: number[];
  /** Cost of the last ten ok runs per `stage|model`. */
  costs: Record<string, number[]>;
  seeded: boolean;
  /** What waits on quota, by `issue:<n>` or `agent:<name>`. */
  waiting: Record<string, Waiting>;
}

export const BACKOFF_BASE_MS = 15 * 60_000;
export const BACKOFF_MAX_MS = 4 * 3_600_000;
const CAPACITY_SAMPLES = 5;
const COST_SAMPLES = 10;
const MIN_CAPACITY_SAMPLES = 2;

export interface QuotaParams {
  modelFallback: boolean;
  modelFallbackModel: string;
  planWindows: boolean;
  sessionWindowMs: number;
}
export const DEFAULT_QUOTA_PARAMS: QuotaParams = { modelFallback: true, modelFallbackModel: "claude-opus-5-5", planWindows: true, sessionWindowMs: 5 * 3_600_000 };

/** The quota parameters from the store; a store without them (older state, tests) gives the defaults. */
export async function quotaParams(store?: ParameterStore): Promise<QuotaParams> {
  const read = async <T>(name: string, fallback: T): Promise<T> => {
    if (!store || !Object.hasOwn(store.definitions, name)) return fallback;
    try {
      return (await store.read(name)).value as T;
    } catch {
      return fallback;
    }
  };
  return {
    modelFallback: await read("quota.model_limit_fallback", DEFAULT_QUOTA_PARAMS.modelFallback),
    modelFallbackModel: await read("quota.model_limit_fallback_model", DEFAULT_QUOTA_PARAMS.modelFallbackModel),
    planWindows: await read("quota.plan_windows", DEFAULT_QUOTA_PARAMS.planWindows),
    sessionWindowMs: parseDuration(await read("quota.session_window", "5h")),
  };
}

const empty = (): Book => ({ limits: {}, backoff: {}, window: null, capacity: [], costs: {}, seeded: false, waiting: {} });

export async function readBook(paths: StatePaths): Promise<Book> {
  try {
    return { ...empty(), ...JSON.parse(await readFile(paths.quota, "utf8")) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw e;
  }
}

async function writeBook(paths: StatePaths, book: Book): Promise<void> {
  await writeFile(paths.quota + ".tmp", JSON.stringify(book, null, 2));
  await rename(paths.quota + ".tmp", paths.quota);
}

function update<T>(paths: StatePaths, fn: (book: Book) => Promise<T> | T): Promise<T> {
  return withStateLock(paths.quota, async () => {
    const book = await readBook(paths);
    const out = await fn(book);
    await writeBook(paths, book);
    return out;
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const push = (xs: number[], x: number, keep: number): number[] => [...xs, x].slice(-keep);

/** AC-8: the first read of the book takes the stage estimates from the usage records already on disk. */
async function seed(paths: StatePaths, book: Book): Promise<void> {
  if (book.seeded) return;
  book.seeded = true;
  const records: UsageRecord[] = [];
  for (const f of await readdir(paths.usage).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(join(paths.usage, f), "utf8")));
    } catch {
      /* a partial record is skipped */
    }
  }
  records.sort((a, b) => a.started_at.localeCompare(b.started_at));
  for (const r of records) if (r.outcome === "ok" && typeof r.cost_usd === "number") book.costs[`${r.stage}|${r.model}`] = push(book.costs[`${r.stage}|${r.model}`] ?? [], r.cost_usd, COST_SAMPLES);
}

/** AC-4, AC-8: every run ends here. Returns the limit a 429 recorded, or null. */
export function observeRun(paths: StatePaths, usage: UsageRecord, judgement: Judgement, now: Date, sessionWindowMs = DEFAULT_QUOTA_PARAMS.sessionWindowMs): Promise<Limit | null> {
  return update(paths, async (book) => {
    await seed(paths, book);
    const cost = usage.cost_usd ?? 0;
    if (usage.harness === "claude") {
      const start = Date.parse(usage.started_at);
      if (!book.window || start >= Date.parse(book.window.end)) {
        book.window = { start: new Date(start).toISOString(), end: new Date(start + sessionWindowMs).toISOString(), spent_usd: 0, sampled: false };
      }
      book.window.spent_usd = Math.round((book.window.spent_usd + cost) * 1e6) / 1e6;
    }
    if (judgement.outcome === "ok") {
      if (typeof usage.cost_usd === "number") book.costs[`${usage.stage}|${usage.model}`] = push(book.costs[`${usage.stage}|${usage.model}`] ?? [], usage.cost_usd, COST_SAMPLES);
      // AC-3: a run that worked proves the limits covering its model have lifted.
      for (const key of Object.keys(book.limits)) if (keyCovers(key, usage.harness, usage.model)) delete book.limits[key];
      for (const key of Object.keys(book.backoff)) if (keyCovers(key, usage.harness, usage.model)) delete book.backoff[key];
      return null;
    }
    if (judgement.apiErrorStatus !== 429) return null;
    const parsed = parseLimit(judgement.reason, usage.harness, usage.model, now);
    let resetsAt = parsed.resetsAt;
    let source: Limit["source"] = "stated";
    if (!resetsAt) {
      const n = book.backoff[parsed.key] ?? 0;
      resetsAt = new Date(now.getTime() + Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS));
      book.backoff[parsed.key] = n + 1;
      source = "backoff";
    }
    const limit: Limit = {
      key: parsed.key, scope: parsed.scope, resets_at: resetsAt.toISOString(), source, reason: (judgement.reason ?? "429").slice(0, 300), hit_at: now.toISOString(), run_id: usage.run_id,
    };
    book.limits[parsed.key] = limit;
    if (parsed.key === "claude" && parsed.scope === "session" && book.window) {
      if (!book.window.sampled && book.window.spent_usd > 0) {
        book.capacity = push(book.capacity, book.window.spent_usd, CAPACITY_SAMPLES);
        book.window.sampled = true;
      }
      if (source === "stated") book.window.end = limit.resets_at;
    }
    return limit;
  });
}

/** The limit that blocks `model` on `harness` at `now` (the one that lifts last), or null. */
export function blocking(book: Book, harness: string, model: string, now: Date): Limit | null {
  let found: Limit | null = null;
  for (const l of Object.values(book.limits)) {
    if (Date.parse(l.resets_at) <= now.getTime() || !keyCovers(l.key, harness, model)) continue;
    if (!found || l.resets_at > found.resets_at) found = l;
  }
  return found;
}

export interface LaunchRequest {
  /** `issue:<n>` or `agent:<name>`, the waiting entry's key. */
  what: string;
  stage: string;
  tier: Tier;
  harness: Harness;
  model: string;
  fallback?: string;
  independent?: boolean;
}
export type LaunchDecision =
  | { kind: "run"; model: string; harness: Harness; note?: { kind: "quota-fallback"; from: string; key: string } }
  | { kind: "wait"; until: string; key: string; reason: string; defer?: { estimate: number; spent: number; capacity: number } };

const harnessOf = (model: string): Harness => (model.includes("/") ? "pi" : "claude");

/** The model a strong-tier stage may move to under a model-scope limit (AC-9), or null. */
export function modelLimitFallback(book: Book, req: Pick<LaunchRequest, "tier" | "harness" | "model">, params: QuotaParams, now: Date): string | null {
  const blk = blocking(book, req.harness, req.model, now);
  if (!blk || blk.scope !== "model" || req.tier !== "strong" || req.harness !== "claude" || !params.modelFallback) return null;
  const to = params.modelFallbackModel;
  if (!to || to === req.model || harnessOf(to) !== "claude" || blocking(book, "claude", to, now)) return null;
  return to;
}

function decide(book: Book, req: LaunchRequest, params: QuotaParams, now: Date): LaunchDecision {
  let model = req.model;
  let harness = req.harness;
  let note: { kind: "quota-fallback"; from: string; key: string } | undefined;
  const blk = blocking(book, harness, model, now);
  if (blk) {
    const viaLimit = modelLimitFallback(book, req, params, now);
    const own = req.fallback && (req.tier !== "strong" || req.independent) && !blocking(book, harnessOf(req.fallback), req.fallback, now) ? req.fallback : null;
    const to = viaLimit ?? own;
    if (!to) return { kind: "wait", until: blk.resets_at, key: blk.key, reason: `${model} limited (${blk.key}, ${blk.source}) until ${blk.resets_at}` };
    note = { kind: "quota-fallback", from: model, key: blk.key };
    model = to;
    harness = harnessOf(to);
  }
  // AC-8: a strong-tier Claude stage that would likely be cut off near the end of the window waits for its end.
  const w = book.window;
  const estimates = book.costs[`${req.stage}|${model}`];
  if (params.planWindows && req.tier === "strong" && harness === "claude" && w && Date.parse(w.end) > now.getTime() && book.capacity.length >= MIN_CAPACITY_SAMPLES && estimates?.length) {
    const estimate = median(estimates);
    const capacity = median(book.capacity);
    if (w.spent_usd + estimate > capacity) {
      return {
        kind: "wait", until: w.end, key: "claude",
        reason: `deferred to the window's end: spent ${w.spent_usd.toFixed(2)} + estimate ${estimate.toFixed(2)} > capacity ${capacity.toFixed(2)}`,
        defer: { estimate, spent: w.spent_usd, capacity },
      };
    }
  }
  return note ? { kind: "run", model, harness, note } : { kind: "run", model, harness };
}

/** AC-6 to AC-9: the launch decision for one stage or agent run; records or clears its waiting entry. */
export function planLaunch(paths: StatePaths, req: LaunchRequest, params: QuotaParams, now: Date): Promise<LaunchDecision> {
  return update(paths, async (book) => {
    await seed(paths, book);
    const d = decide(book, req, params, now);
    if (d.kind === "wait") book.waiting[req.what] = { until: d.until, key: d.key, reason: d.reason, since: book.waiting[req.what]?.since ?? now.toISOString() };
    else delete book.waiting[req.what];
    return d;
  });
}

/** AC-5, AC-7: the wait after a 429, for a run of `model`: the blocking limit's reset, recorded as waiting. */
export function waitAfterLimit(paths: StatePaths, what: string, harness: string, model: string, now: Date): Promise<Waiting> {
  return update(paths, (book) => {
    const blk = blocking(book, harness, model, now);
    const w: Waiting = blk
      ? { until: blk.resets_at, key: blk.key, reason: `${model} limited (${blk.key}, ${blk.source}) until ${blk.resets_at}`, since: now.toISOString() }
      : { until: new Date(now.getTime() + BACKOFF_BASE_MS).toISOString(), key: `${harness}:${model}`, reason: "rate limited", since: now.toISOString() };
    book.waiting[what] = w;
    return w;
  });
}

/** AC-10: the tick's summary, or null when nothing is limited and nothing waits. */
export function quotaSummary(book: Book, now: Date): { limits: { key: string; scope: string; resets_at: string; source: string }[]; waiting: { what: string; until: string; key: string }[] } | null {
  const limits = Object.values(book.limits).filter((l) => Date.parse(l.resets_at) > now.getTime()).map(({ key, scope, resets_at, source }) => ({ key, scope, resets_at, source }));
  const waiting = Object.entries(book.waiting).filter(([, w]) => Date.parse(w.until) > now.getTime()).map(([what, w]) => ({ what, until: w.until, key: w.key }));
  return limits.length || waiting.length ? { limits, waiting } : null;
}
