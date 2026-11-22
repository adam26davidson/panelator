import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendFindings } from "../state/findings.ts";
import { record } from "../events/store.ts";
import { readCost, readLedger, readNotices, reservedUsd, round, writeCost, writeNotices, forecastUsd, type AwsCost, type AwsNotices } from "./book.ts";
import { daysInMonth, monthOf, readCap, type AwsContext } from "./context.ts";
import { checkIdentity } from "./identity.ts";

const HOUR = 3_600_000;
const MAX_PULL_FAILURES_PER_DAY = 6;

/** The shape of the tick's service-log `aws` field (spec 022 AC-10, spec 050 AC-8). */
export type AwsTickField =
  | { off: string }
  | { actual_usd: number | null; forecast_usd: number | null; cap_usd: number; reserved_usd: number | null; as_of: string | null; pull_skipped?: "cap 0" };

/** Whether the scheduled pull is due now: none yet, a new month, the interval gone, and not within the retry limits (AC-4). */
export async function pullDue(ctx: AwsContext, cost: AwsCost | null, notices: AwsNotices): Promise<boolean> {
  const now = ctx.now();
  const f = notices.pull_failures;
  if (f && f.day === now.toISOString().slice(0, 10)) {
    if (f.count >= MAX_PULL_FAILURES_PER_DAY) return false;
    if (now.getTime() - Date.parse(f.last_at) < HOUR) return false;
  } else if (f && now.getTime() - Date.parse(f.last_at) < HOUR) return false;
  if (!cost || cost.month !== monthOf(now)) return true;
  return now.getTime() - Date.parse(cost.as_of) >= ctx.config!.pull_interval_h * HOUR;
}

function sumCost(res: unknown): number {
  const rows = (res as { ResultsByTime?: { Total?: { UnblendedCost?: { Amount?: string } } }[] }).ResultsByTime;
  if (!Array.isArray(rows)) throw new Error("aws ce get-cost-and-usage returned no ResultsByTime");
  const total = rows.reduce((a, r) => a + Number(r.Total?.UnblendedCost?.Amount ?? 0), 0);
  if (!Number.isFinite(total)) throw new Error("aws ce get-cost-and-usage returned a cost that is not a number");
  return total;
}

/** Month-to-date cost of the configured account, MONTHLY, UnblendedCost (AC-4). */
export async function fetchActual(ctx: AwsContext): Promise<number> {
  const now = ctx.now();
  const start = `${monthOf(now)}-01`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const res = await ctx.cli!.run([
    "ce", "get-cost-and-usage",
    "--time-period", `Start=${start},End=${next}`,
    "--granularity", "MONTHLY",
    "--metrics", "UnblendedCost",
    "--filter", JSON.stringify({ Dimensions: { Key: "LINKED_ACCOUNT", Values: [ctx.config!.account_id] } }),
  ]);
  return sumCost(res);
}

/** The cost record for a pulled `actual` at the context's time. */
async function figures(ctx: AwsContext, actual: number, cap: number): Promise<AwsCost> {
  const now = ctx.now();
  const dim = daysInMonth(now);
  const elapsed = now.getUTCDate();
  const reserved = reservedUsd(await readLedger(ctx.paths));
  return { month: monthOf(now), actual_usd: round(actual), as_of: now.toISOString(), cap_usd: cap, reserved_usd: reserved, forecast_usd: forecastUsd(actual, reserved, elapsed, dim), days_elapsed: elapsed, days_in_month: dim, source: "ce" };
}

/**
 * Spec 022 AC-4: one pull. The identity is checked first (AC-2); on success `cost.json` is written and one `aws.cost`
 * event recorded, then the thresholds and the forecast are judged. On failure the old file stays and the failure is counted.
 */
export async function pull(ctx: AwsContext): Promise<{ ok: true; cost: AwsCost } | { ok: false; reason: string }> {
  const id = await checkIdentity(ctx);
  if (!id.on) return { ok: false, reason: id.reason ?? "aws is off" };
  const now = ctx.now();
  let notices = await readNotices(ctx.paths, monthOf(now));
  let actual: number;
  try {
    actual = await fetchActual(ctx);
  } catch (e) {
    const day = now.toISOString().slice(0, 10);
    const prev = notices.pull_failures;
    notices = { ...notices, pull_failures: { day, count: prev && prev.day === day ? prev.count + 1 : 1, last_at: now.toISOString() } };
    await writeNotices(ctx.paths, notices);
    ctx.log({ kind: "aws-pull-failed", error: (e as Error).message, failures_today: notices.pull_failures!.count });
    return { ok: false, reason: (e as Error).message };
  }
  const cap = await readCap(ctx);
  const cost = await figures(ctx, actual, cap);
  await writeCost(ctx.paths, cost);
  await record(ctx.paths, "aws.cost", now, { ...cost });
  notices = { ...notices, pull_failures: null };
  await judge(ctx, cost, notices, { pulled: true });
  return { ok: true, cost };
}

/** Rewrites `cost.json` with the current cap, reservations and forecast, keeping the pull's actual and time (AC-5). */
export async function refresh(ctx: AwsContext, cost: AwsCost, cap: number): Promise<AwsCost> {
  const reserved = reservedUsd(await readLedger(ctx.paths));
  const forecast = forecastUsd(cost.actual_usd, reserved, cost.days_elapsed, cost.days_in_month);
  if (cap === cost.cap_usd && reserved === cost.reserved_usd && forecast === cost.forecast_usd) return cost;
  const next = { ...cost, cap_usd: cap, reserved_usd: reserved, forecast_usd: forecast };
  await writeCost(ctx.paths, next);
  return next;
}

function monthEvents(ctx: AwsContext, month: string): unknown[] {
  const file = join(ctx.paths.events, `${month}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; payload: unknown }).filter((e) => e.kind === "aws.cost").map((e) => e.payload);
}

/** Days until the trend reaches the cap; 0 when already at it (AC-9). */
export function daysToCap(cost: AwsCost, cap: number): number {
  if (cost.actual_usd >= cap) return 0;
  const rate = cost.actual_usd / Math.max(cost.days_elapsed, 1);
  const left = rate > 0 ? (cap - cost.actual_usd) / rate : cost.days_in_month - cost.days_elapsed;
  return Math.round(left * 10) / 10;
}

/**
 * The thresholds of AC-8 (on a pull only) and the forecast alarm of AC-9 (on a pull, a ledger change or a cap change),
 * each against a non-zero cap; notices already sent are in `notices` and persisted after.
 */
export async function judge(ctx: AwsContext, cost: AwsCost, notices: AwsNotices, opts: { pulled: boolean }): Promise<void> {
  const cap = cost.cap_usd;
  let n = notices;
  const notify = (label: string, text: string) => ctx.notifier.notify({ issue: 0, gate: "aws", label, text });
  if (cap > 0 && opts.pulled) {
    const pct = (cost.actual_usd / cap) * 100;
    if (pct >= 100 && !n.hit) {
      await notify("aws-cap-hit", `Incident: the delivery-system AWS spend for ${cost.month} reached its cap: ${cost.actual_usd} USD of ${cap} USD. AWS Budgets blocks new resources at 100%. Reserved: ${cost.reserved_usd} USD a month; forecast ${cost.forecast_usd} USD. This is a planning failure; a finding was filed for reflection.`);
      const ledger = await readLedger(ctx.paths);
      await appendFindings(ctx.paths, { issue: 0, stage: "scheduler", run_id: `aws-cap-hit-${cost.month}`, timestamp: ctx.now().toISOString() }, [{
        what: `AWS cap hit: planning failure (${cost.month})`,
        where: "aws/cost.json",
        evidence: `Actual ${cost.actual_usd} USD against a cap of ${cap} USD. The month's aws.cost payloads: ${JSON.stringify(monthEvents(ctx, cost.month))}. The ledger: ${JSON.stringify(ledger.reservations)}.`,
        noticed_how: "scheduler AWS cost pull",
      }]);
      n = { ...n, hit: true, cap80: true };
    } else if (pct >= 80 && !n.cap80 && !n.hit) {
      await notify("aws-cap-80", `The delivery-system AWS spend for ${cost.month} is at ${Math.floor(pct)}% of its cap: ${cost.actual_usd} USD of ${cap} USD. Forecast ${cost.forecast_usd} USD, reserved ${cost.reserved_usd} USD a month.`);
      n = { ...n, cap80: true };
    }
  }
  const over = cap > 0 && cost.forecast_usd > cap;
  if (over) {
    const last = n.forecast_notified_at ? Date.parse(n.forecast_notified_at) : 0;
    if (!n.forecast_over || ctx.now().getTime() - last >= 24 * HOUR) {
      const days = daysToCap(cost, cap);
      const shortfall = round(cost.forecast_usd - cap);
      await ctx.emitEvent?.("infra_alarm", { kind: "aws_forecast_over_cap", forecast_usd: cost.forecast_usd, cap_usd: cap, actual_usd: cost.actual_usd, reserved_usd: cost.reserved_usd, days_to_cap: days });
      await notify("aws-forecast", `The delivery-system AWS forecast for ${cost.month} is ${cost.forecast_usd} USD against a cap of ${cap} USD: ${days} days remain at the current rate. Reserved ${cost.reserved_usd} USD a month; the shortfall is ${shortfall} USD. New launches are refused until the forecast is back under the cap. To raise the cap: panelator-scheduler param set aws_cap_usd ${round(cap + shortfall)}, and the budget amount in the management account.`);
      n = { ...n, forecast_over: true, forecast_notified_at: ctx.now().toISOString() };
    }
  } else if (n.forecast_over) {
    if (cap > 0) await notify("aws-forecast", `The delivery-system AWS forecast for ${cost.month} is back under the cap: ${cost.forecast_usd} USD against ${cap} USD. Launches are allowed again.`);
    n = { ...n, forecast_over: false, forecast_notified_at: null };
  }
  await writeNotices(ctx.paths, n);
}

/** Whether the forecast stands over a non-zero cap (AC-9: reservations are refused while it does). */
export const isOver = (cost: AwsCost | null, cap: number): boolean => cap > 0 && cost !== null && cost.forecast_usd > cap;

/** The cost record of this month, or null when none was pulled this month. */
export async function currentCost(ctx: AwsContext): Promise<AwsCost | null> {
  const cost = await readCost(ctx.paths);
  return cost && cost.month === monthOf(ctx.now()) ? cost : null;
}

/**
 * The AWS step of a tick (spec 022 AC-1, AC-2, AC-4, AC-11; spec 050 AC-5, AC-8). Never throws: a failure is the
 * result's `off`, the pull's logged failure, or the caller's error list.
 */
export async function awsTick(ctx: AwsContext): Promise<AwsTickField> {
  if (!ctx.config || !ctx.cli) {
    if (ctx.state.identityAt === null) await checkIdentity(ctx);
    return { off: ctx.state.reason ?? "off" };
  }
  const now = ctx.now();
  const cap = await readCap(ctx);
  let cost = await readCost(ctx.paths);
  const notices = await readNotices(ctx.paths, monthOf(now));
  const due = cap > 0 && (await pullDue(ctx, cost, notices));
  const intervalMs = ctx.config.pull_interval_h * HOUR;
  if (ctx.state.identityAt === null || due || now.getTime() - ctx.state.identityAt >= intervalMs) await checkIdentity(ctx);
  if (!ctx.state.on) return { off: ctx.state.reason ?? "off" };
  if (cap === 0) {
    if (!ctx.state.skipping) {
      ctx.state.skipping = true;
      ctx.log({ kind: "aws-pull-skipped", reason: "aws_cap_usd is 0" });
    }
    if (notices.forecast_over) await writeNotices(ctx.paths, { ...notices, forecast_over: false, forecast_notified_at: null });
    return { ...fieldOf(cost, cap), pull_skipped: "cap 0" };
  }
  if (ctx.state.skipping) {
    ctx.state.skipping = false;
    ctx.log({ kind: "aws-pull-resumed" });
  }
  if (due) {
    const res = await pull(ctx);
    if (res.ok) cost = res.cost;
  } else if (cost && cost.month === monthOf(now)) {
    // A cap or ledger change since the last write: recompute without a pull (AC-11).
    const next = await refresh(ctx, cost, cap);
    if (next !== cost || notices.forecast_over || isOver(next, cap)) await judge(ctx, next, notices, { pulled: false });
    cost = next;
  }
  return fieldOf(cost, cap);
}

function fieldOf(cost: AwsCost | null, cap: number): AwsTickField {
  return { actual_usd: cost?.actual_usd ?? null, forecast_usd: cost?.forecast_usd ?? null, cap_usd: cap, reserved_usd: cost?.reserved_usd ?? null, as_of: cost?.as_of ?? null };
}
