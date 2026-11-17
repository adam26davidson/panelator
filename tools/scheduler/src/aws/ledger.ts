import { randomUUID } from "node:crypto";
import { withStateLock } from "../parameters/store.ts";
import { record } from "../events/store.ts";
import { readLedger, readNotices, reservedUsd, round, writeLedger, writeNotices, forecastUsd, type Reservation } from "./book.ts";
import { currentCost, judge, refresh } from "./cost.ts";
import { daysInMonth, monthOf, readCap, type AwsContext } from "./context.ts";
import { ensureOn } from "./identity.ts";

export interface ReserveRequest {
  what: string;
  expected_monthly_usd: number;
  why: string;
  by: string;
}
export type ReserveResult = { ok: true; id: string } | { ok: false; reason: string; shortfall_usd: number };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);

/**
 * Spec 022 AC-6: the one function any code that creates a billable resource calls first. A reservation is written only
 * when AWS is on, the cap is above 0, the forecast is not over the cap and stays at or below it with the reservation
 * added; anything else is refused and becomes a funds request (AC-7).
 */
export async function reserveSpend(ctx: AwsContext, req: ReserveRequest): Promise<ReserveResult> {
  const bad = invalid(req);
  if (bad) return { ok: false, reason: bad, shortfall_usd: 0 };
  const on = await ensureOn(ctx);
  const cap = await readCap(ctx);
  const result = await withStateLock(ctx.paths.awsLedger, async (): Promise<ReserveResult & { forecast: number; reserved: number }> => {
    const ledger = await readLedger(ctx.paths);
    const reserved = reservedUsd(ledger);
    const cost = await currentCost(ctx);
    const now = ctx.now();
    const actual = cost?.actual_usd ?? 0;
    const elapsed = cost?.days_elapsed ?? now.getUTCDate();
    const dim = cost?.days_in_month ?? daysInMonth(now);
    const current = forecastUsd(actual, reserved, elapsed, dim);
    const withIt = forecastUsd(actual, reserved + req.expected_monthly_usd, elapsed, dim);
    const refuse = (reason: string, shortfall: number) => ({ ok: false as const, reason, shortfall_usd: round(shortfall), forecast: current, reserved });
    if (!on) return refuse(`aws is off: ${ctx.state.reason}`, req.expected_monthly_usd);
    if (cap === 0) return refuse("aws_cap_usd is 0: nothing is launched", req.expected_monthly_usd);
    if (current > cap) return refuse(`the forecast ${current} USD is over the cap of ${cap} USD`, withIt - cap);
    if (withIt > cap) return refuse(`the forecast with this reservation, ${withIt} USD, is over the cap of ${cap} USD`, withIt - cap);
    const id = randomUUID();
    const r: Reservation = { id, ...req, at: now.toISOString(), released_at: null };
    await writeLedger(ctx.paths, { reservations: [...ledger.reservations, r] });
    return { ok: true, id, forecast: withIt, reserved: reserved + req.expected_monthly_usd };
  });
  const base = { what: req.what, expected_monthly_usd: req.expected_monthly_usd, why: req.why, by: req.by };
  if (result.ok) {
    await record(ctx.paths, "aws.reserve", ctx.now(), { id: result.id, ...base, outcome: "reserved" });
    await afterChange(ctx, cap);
    return { ok: true, id: result.id };
  }
  const refusal = { ok: false as const, reason: result.reason, shortfall_usd: result.shortfall_usd };
  await record(ctx.paths, "aws.reserve", ctx.now(), { id: "", ...base, outcome: "refused" });
  await fundsRequest(ctx, req, refusal, cap, result.forecast, result.reserved);
  return refusal;
}

export async function releaseSpend(ctx: AwsContext, id: string): Promise<boolean> {
  const released = await withStateLock(ctx.paths.awsLedger, async () => {
    const ledger = await readLedger(ctx.paths);
    const r = ledger.reservations.find((x) => x.id === id && x.released_at === null);
    if (!r) return null;
    r.released_at = ctx.now().toISOString();
    await writeLedger(ctx.paths, ledger);
    return r;
  });
  if (!released) return false;
  await record(ctx.paths, "aws.reserve", ctx.now(), { id, what: released.what, expected_monthly_usd: released.expected_monthly_usd, why: released.why, by: released.by, outcome: "released" });
  await afterChange(ctx, await readCap(ctx));
  return true;
}

/** The forecast follows the ledger at once (AC-5, AC-9). */
async function afterChange(ctx: AwsContext, cap: number): Promise<void> {
  const cost = await currentCost(ctx);
  if (!cost || cap === 0) return;
  const next = await refresh(ctx, cost, cap);
  await judge(ctx, next, await readNotices(ctx.paths, monthOf(ctx.now())), { pulled: false });
}

function invalid(req: ReserveRequest): string | null {
  if (typeof req.expected_monthly_usd !== "number" || !Number.isFinite(req.expected_monthly_usd) || req.expected_monthly_usd < 0) return "expected_monthly_usd must be a number of at least 0";
  if (typeof req.what !== "string" || req.what.length < 10) return "what must be at least 10 characters";
  if (typeof req.why !== "string" || req.why.length < 10) return "why must be at least 10 characters";
  if (typeof req.by !== "string" || !req.by) return "by is required";
  return null;
}

/** AC-7 and spec 068 AC-5: one notification, carrying the contact the recorder writes as the one `maintainer.contact` event. */
async function fundsRequest(ctx: AwsContext, req: ReserveRequest, refusal: { reason: string; shortfall_usd: number }, cap: number, forecast: number, reserved: number): Promise<void> {
  const now = ctx.now();
  const notices = await readNotices(ctx.paths, monthOf(now));
  const windowMs = ctx.notifyHours * 3_600_000;
  const last = notices.funds[req.what];
  if (last && now.getTime() - Date.parse(last) < windowMs) return;
  const amount = Math.ceil(refusal.shortfall_usd * 100) / 100;
  const steps = cap === 0
    ? `The cap is 0. To admit this: panelator-scheduler param set aws_cap_usd ${amount}, and set the budget amount in the management account to ${amount} USD.`
    : `To raise the cap: panelator-scheduler param set aws_cap_usd ${round(cap + amount)}, and set the budget amount in the management account (spec 022 section 8, step 3) to the same.`;
  const text = [
    `Amount: ${amount} USD a month`,
    `Purpose: ${req.what} (expected ${req.expected_monthly_usd} USD a month)`,
    `Charter goal: ${req.why}`,
    `Forecast: ${forecast} USD against a cap of ${cap} USD (reserved ${reserved} USD)`,
    `Asked by: ${req.by}`,
    `Refused: ${refusal.reason}`,
    steps,
    "Whoever asked retries the launch once the cap allows it.",
  ].join("\n");
  await ctx.notifier.notify({
    issue: 0, gate: `aws-funds:${slug(req.what)}`, label: "aws-funds", text,
    contact: { kind: "funds", request: { type: "funds", amount_usd: amount, purpose: req.what, charter_goal: req.why } },
  });
  const funds = Object.fromEntries(Object.entries({ ...notices.funds, [req.what]: now.toISOString() }).filter(([, t]) => now.getTime() - Date.parse(t) < windowMs));
  await writeNotices(ctx.paths, { ...notices, funds });
}

