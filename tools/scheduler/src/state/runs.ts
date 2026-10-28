import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { AgentStageName, Harness } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export type RunOutcome = "ok" | "failed" | "timeout" | "bounds";

export interface UsageRecord {
  run_id: string;
  issue: number;
  stage: string;
  attempt: number;
  outcome: RunOutcome;
  harness: Harness;
  model: string;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  turns: number;
  tool_calls: number;
  wall_seconds: number;
  started_at: string;
  ended_at: string;
  events_path: string;
}

export function newRunId(issue: number, stage: string, attempt: number, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `${issue}-${stage}-${attempt}-${ts}`;
}

export function runDir(p: StatePaths, runId: string): string {
  return join(p.runs, runId);
}

export async function writeUsageRecord(p: StatePaths, rec: UsageRecord): Promise<void> {
  const v = validate("usage-record", rec);
  if (!v.ok) throw new Error(`invalid usage record: ${v.errors.join("; ")}`);
  await mkdir(runDir(p, rec.run_id), { recursive: true });
  const text = JSON.stringify(rec, null, 2);
  await writeAtomic(join(p.usage, `${rec.run_id}.json`), text);
  await writeAtomic(join(runDir(p, rec.run_id), "usage.json"), text);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = path + ".tmp";
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function readUsageRecord(p: StatePaths, runId: string): Promise<UsageRecord | null> {
  try {
    return JSON.parse(await readFile(join(p.usage, `${runId}.json`), "utf8")) as UsageRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** 180-day retention (spec section 11). Returns the number of records removed. */
export async function pruneUsage(p: StatePaths, now: Date, retentionDays = 180): Promise<number> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  for (const n of await readdir(p.usage)) {
    if (!n.endsWith(".json")) continue;
    let ended: number;
    try {
      ended = new Date((JSON.parse(await readFile(join(p.usage, n), "utf8")) as UsageRecord).ended_at).getTime();
    } catch {
      continue; // unreadable file: skip it rather than block retention
    }
    if (Number.isNaN(ended)) continue;
    if (ended < cutoff) {
      await unlink(join(p.usage, n));
      removed++;
    }
  }
  return removed;
}
