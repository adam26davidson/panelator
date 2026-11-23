import { readFile, rename, writeFile } from "node:fs/promises";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import type { ScaleDescriptor } from "./scale.ts";

/** `aws/cost.json` (spec 022 AC-4). */
export interface AwsCost {
  month: string;
  actual_usd: number;
  as_of: string;
  cap_usd: number;
  reserved_usd: number;
  forecast_usd: number;
  days_elapsed: number;
  days_in_month: number;
  source: "ce";
}

/** One reservation of `aws/ledger.json` (spec 022 AC-6). */
export interface Reservation {
  id: string;
  what: string;
  expected_monthly_usd: number;
  why: string;
  by: string;
  at: string;
  released_at: string | null;
  /** Spec 068 AC-6: written by the launcher; `expected_monthly_usd` is the down figure while `scale.state` is down. */
  scale?: ScaleDescriptor & { state: "up" | "down" };
}
export interface AwsLedger {
  reservations: Reservation[];
}

/** What went out this month and the day's pull failures; persisted so a restart does not repeat a notice. */
export interface AwsNotices {
  month: string;
  cap80: boolean;
  hit: boolean;
  forecast_over: boolean;
  forecast_notified_at: string | null;
  pull_failures: { day: string; count: number; last_at: string } | null;
  /** `what` of a refused reservation to the time of its funds request. */
  funds: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.tmp`, path);
}

export const readCost = (p: StatePaths) => readJson<AwsCost>(p.awsCost);
export async function writeCost(p: StatePaths, cost: AwsCost): Promise<void> {
  const v = validate("aws-cost", cost);
  if (!v.ok) throw new Error(`invalid aws cost: ${v.errors.join("; ")}`);
  await writeJson(p.awsCost, cost);
}

export async function readLedger(p: StatePaths): Promise<AwsLedger> {
  return (await readJson<AwsLedger>(p.awsLedger)) ?? { reservations: [] };
}
export async function writeLedger(p: StatePaths, ledger: AwsLedger): Promise<void> {
  const v = validate("aws-ledger", ledger);
  if (!v.ok) throw new Error(`invalid aws ledger: ${v.errors.join("; ")}`);
  await writeJson(p.awsLedger, ledger);
}

export const reservedUsd = (l: AwsLedger): number => round(l.reservations.filter((r) => r.released_at === null).reduce((a, r) => a + r.expected_monthly_usd, 0));

export async function readNotices(p: StatePaths, month: string): Promise<AwsNotices> {
  const n = await readJson<AwsNotices>(p.awsNotices);
  const fresh: AwsNotices = { month, cap80: false, hit: false, forecast_over: false, forecast_notified_at: null, pull_failures: null, funds: {} };
  if (!n) return fresh;
  // A new month resets the per-month notices (AC-4); the forecast alarm and the funds requests carry over.
  return n.month === month ? n : { ...fresh, forecast_over: n.forecast_over, forecast_notified_at: n.forecast_notified_at, pull_failures: n.pull_failures, funds: n.funds };
}
export const writeNotices = (p: StatePaths, n: AwsNotices) => writeJson(p.awsNotices, n);

export const round = (n: number): number => Math.round(n * 100) / 100;

/** Spec 022 AC-5: the larger of the trend and the ledger view. */
export function forecastUsd(actual: number, reserved: number, daysElapsed: number, daysInMonth: number): number {
  const trend = (actual / Math.max(daysElapsed, 1)) * daysInMonth;
  const ledger = actual + (reserved * (daysInMonth - daysElapsed)) / daysInMonth;
  return round(Math.max(trend, ledger));
}
