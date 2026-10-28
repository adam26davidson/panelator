import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatePaths } from "../state/paths.ts";
import type { EventKind } from "./kinds.ts";
import { openIndex } from "./index.ts";
import { recordEvent } from "./store.ts";

export interface BackfillCounts {
  recorded: Record<string, number>;
  already_present: number;
  old_shape: number;
  skipped: number;
}

const id = (kind: string, file: string, key: string | number) => createHash("sha256").update(`${kind}:${file}:${key}`).digest("hex").slice(0, 32);

async function lines(path: string): Promise<string[]> {
  try { return (await readFile(path, "utf8")).split("\n").filter(Boolean); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
}

/** Records the records that exist before spec 012 as events (AC-4). The id derives from the source record, so a second run records nothing. */
export async function backfillEvents(paths: StatePaths, log: (rec: Record<string, unknown>) => void = () => {}): Promise<BackfillCounts> {
  const counts: BackfillCounts = { recorded: {}, already_present: 0, old_shape: 0, skipped: 0 };
  const db = openIndex(paths, { log });
  const present = new Set((db.prepare("SELECT id FROM events").all() as { id: string }[]).map((r) => r.id));
  db.close();
  const put = async (kind: EventKind, file: string, key: string | number, at: unknown, payload: Record<string, unknown>, who: { issue?: number; run_id?: string; agent?: string }) => {
    const eid = id(kind, file, key);
    if (present.has(eid)) { counts.already_present++; return; }
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) { counts.skipped++; return; }
    const { oldShape } = await recordEvent(paths, { id: eid, at, kind, payload: { ...payload, backfilled: true }, ...who }, { backfill: true });
    present.add(eid);
    counts.recorded[kind] = (counts.recorded[kind] ?? 0) + 1;
    if (oldShape) counts.old_shape++;
  };
  const issueOf = (r: Record<string, unknown>) => (Number.isInteger(r.issue) && (r.issue as number) >= 0 ? { issue: r.issue as number } : {});
  for (const f of (await readdir(paths.usage).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const r = JSON.parse(await readFile(join(paths.usage, f), "utf8")) as Record<string, unknown>;
      await put("run.ended", f, String(r.run_id ?? f), r.ended_at, r, { ...issueOf(r), ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}) });
    } catch (e) { if (!(e instanceof SyntaxError)) throw e; counts.skipped++; }
  }
  const jsonl = async (file: string, path: string, kind: EventKind, at: (r: Record<string, unknown>) => unknown, who: (r: Record<string, unknown>) => { issue?: number; run_id?: string; agent?: string }, payload: (r: Record<string, unknown>) => Record<string, unknown> = (r) => r) => {
    for (const [i, line] of (await lines(path)).entries()) {
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { counts.skipped++; continue; }
      await put(kind, file, i, at(r), payload(r), who(r));
    }
  };
  await jsonl("merges.jsonl", join(paths.root, "merges.jsonl"), "merge", (r) => r.at, issueOf);
  await jsonl("actions/log.jsonl", paths.actionsLog, "action", (r) => r.at, (r) => ({ ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}), ...(typeof r.agent === "string" ? { agent: r.agent } : {}) }));
  await jsonl("questions/log.jsonl", paths.questionsLog, "question", (r) => r.at, issueOf);
  await jsonl("findings/queue.jsonl", paths.findingsQueue, "finding.queued", (r) => r.timestamp, (r) => ({ ...issueOf(r), ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}) }));
  await jsonl("findings/triage.jsonl", paths.findingsTriage, "finding.triaged", (r) => r.at, (r) => (typeof r.run_id === "string" ? { run_id: r.run_id } : {}));
  await jsonl("parameters/history.jsonl", paths.parametersHistory, "parameter.changed", (r) => r.at, () => ({}));
  await writeFile(paths.eventsBackfilled, JSON.stringify({ at: new Date().toISOString(), ...counts }, null, 2));
  log({ kind: "events-backfill", ...counts });
  return counts;
}
