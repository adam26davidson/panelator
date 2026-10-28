import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { openIndex } from "./index.ts";
import type { EventKind } from "./kinds.ts";
import { recordEvent, type EventInput } from "./store.ts";

export interface BackfillCounts {
  read: number;
  recorded: number;
  already_present: number;
  /** Records whose payload failed its schema (an old shape): recorded as they are, and counted here. */
  old_shape: number;
  by_kind: Record<string, number>;
}

async function lines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a torn line verifies nothing */
    }
  }
  return out;
}

const backfillId = (source: string, key: string): string => "bf-" + createHash("sha256").update(`${source}\n${key}`).digest("hex").slice(0, 24);

interface Candidate {
  source: string;
  key: string;
  input: EventInput;
}

/**
 * Spec 012 AC-4: the records that exist before the event store, recorded as events with the record's own time and
 * `payload.backfilled: true`. The id derives from the source record, so a second run finds every id present.
 */
export async function backfillEvents(paths: StatePaths, log?: (rec: Record<string, unknown>) => void): Promise<BackfillCounts> {
  const candidates: Candidate[] = [];
  const add = (source: string, key: string, kind: EventKind, at: unknown, rest: Partial<EventInput>, payload: Record<string, unknown>) => {
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return;
    candidates.push({ source, key, input: { kind, at, ...rest, payload } });
  };
  for (const name of (await readdir(paths.usage).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort()) {
    let u: Record<string, unknown>;
    try {
      u = JSON.parse(await readFile(join(paths.usage, name), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const issue = Number(u.issue);
    add("usage", name, "run.ended", u.ended_at, { ...(issue > 0 ? { issue } : {}), run_id: String(u.run_id), ...(issue === 0 ? { agent: String(u.stage) } : {}) }, u);
  }
  const jsonl = async (file: string, source: string, kind: EventKind, atKey: string, extra: (r: Record<string, unknown>) => Partial<EventInput>) => {
    for (const [i, r] of (await lines(file)).entries()) {
      const rec = r as Record<string, unknown>;
      add(source, String(i), kind, rec[atKey], extra(rec), rec);
    }
  };
  const num = (v: unknown) => (typeof v === "number" ? { issue: v } : {});
  await jsonl(join(paths.root, "merges.jsonl"), "merges", "merge", "at", (r) => num(r.issue));
  await jsonl(paths.actionsLog, "actions", "action", "at", (r) => ({ run_id: String(r.run_id ?? ""), agent: String(r.agent ?? "") }));
  await jsonl(paths.questionsLog, "questions", "question", "at", (r) => num(r.issue));
  await jsonl(paths.findingsQueue, "findings-queue", "finding.queued", "timestamp", (r) => ({ ...num(r.issue), ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}) }));
  await jsonl(paths.findingsTriage, "findings-triage", "finding.triaged", "at", (r) => ({ ...(typeof r.run_id === "string" ? { run_id: r.run_id } : {}) }));
  await jsonl(paths.parametersHistory, "parameters", "parameter.changed", "at", () => ({}));

  const db = openIndex(paths, { log });
  const present = new Set((db.prepare("SELECT id FROM events WHERE id LIKE 'bf-%'").all() as { id: string }[]).map((r) => r.id));
  db.close();
  const counts: BackfillCounts = { read: candidates.length, recorded: 0, already_present: 0, old_shape: 0, by_kind: {} };
  for (const c of candidates) {
    const id = backfillId(c.source, c.key);
    if (present.has(id)) {
      counts.already_present++;
      continue;
    }
    // Empty strings from missing optional envelope fields are dropped.
    const input: EventInput = { ...c.input, id, payload: { ...c.input.payload, backfilled: true } };
    if (input.run_id === "") delete input.run_id;
    if (input.agent === "") delete input.agent;
    const { backfilled: _b, ...bare } = input.payload;
    if (!validate("event", { id, at: input.at, kind: input.kind, ...(input.issue ? { issue: input.issue } : {}), ...(input.run_id ? { run_id: input.run_id } : {}), ...(input.agent ? { agent: input.agent } : {}), payload: bare }).ok) counts.old_shape++;
    await recordEvent(paths, input, { trustPayload: true });
    present.add(id);
    counts.recorded++;
    counts.by_kind[input.kind] = (counts.by_kind[input.kind] ?? 0) + 1;
  }
  await writeFile(paths.eventsBackfilled, JSON.stringify({ at: new Date().toISOString(), counts }, null, 2));
  return counts;
}
