import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { recordEvent } from "../events/store.ts";
import type { RecentMerges } from "../shortlist/rank.ts";
import type { StatePaths } from "./paths.ts";

export interface MergeRecord {
  issue: number;
  pr: number;
  cls: "feature" | "debt" | "none";
  work?: 'system'|'product';
  at: string;
}

const file = (p: StatePaths) => join(p.root, "merges.jsonl");

export async function appendMerge(p: StatePaths, m: MergeRecord): Promise<void> {
  await appendFile(file(p), JSON.stringify(m) + "\n");
  await recordEvent(p, { kind: "merge", at: m.at, issue: m.issue, payload: { ...m } });
}

export async function recentMerges(p: StatePaths, now: Date, days = 14): Promise<RecentMerges> {
  const cutoff = now.getTime() - days * 86_400_000;
  const out:RecentMerges = { feature: 0, debt: 0 };
  const text = await readFile(file(p), "utf8").catch(() => "");
  for (const line of text.split("\n").filter(Boolean)) {
    const m = JSON.parse(line) as MergeRecord;
    if (new Date(m.at).getTime() < cutoff) continue;
    if(m.work==='system')out.system=(out.system??0)+1; else if(m.work==='product')out.product=(out.product??0)+1;
    if (m.cls === "feature") out.feature++;
    else if (m.cls === "debt") out.debt++;
  }
  return out;
}
