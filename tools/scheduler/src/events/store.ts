import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { EVENT_KINDS, type EventKind } from "./kinds.ts";
import type { CheckRun } from "../github/types.ts";

/** Spec 012 AC-1: one raw event. `payload` is the record as the scheduler had it. */
export interface SchedulerEvent {
  id: string;
  at: string;
  kind: EventKind;
  issue?: number;
  run_id?: string;
  agent?: string;
  payload: Record<string, unknown>;
}

export type EventInput = Omit<SchedulerEvent, "id" | "at"> & { id?: string; at?: string };

export const eventFile = (p: StatePaths, at: string): string => join(p.events, `${at.slice(0, 7)}.jsonl`);

/**
 * The only writer of `events/<YYYY-MM>.jsonl`: one line appended before the caller continues. An unknown kind or a
 * payload that fails its schema throws and nothing is written. `trustPayload` is for the backfill only, which
 * validates itself so that an old-shape record is kept and counted rather than dropped.
 */
export async function recordEvent(paths: StatePaths, input: EventInput, opts: { trustPayload?: boolean } = {}): Promise<SchedulerEvent> {
  if (!(EVENT_KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown event kind: ${input.kind}`);
  const at = input.at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(at))) throw new Error(`invalid event time: ${at}`);
  const { id: given, at: _at, ...rest } = input;
  const event: SchedulerEvent = { id: given ?? randomBytes(8).toString("hex"), at, ...rest };
  if (event.issue === 0) delete event.issue;
  if (!opts.trustPayload) {
    const v = validate("event", event);
    if (!v.ok) throw new Error(`invalid ${input.kind} event: ${v.errors.join("; ")}`);
  }
  await mkdir(paths.events, { recursive: true });
  await appendFile(eventFile(paths, at), JSON.stringify(event) + "\n");
  return event;
}

const seenChecks = new Set<string>();

/** Spec 012 AC-2: `ci.check` for each completed check run read for a head or `main`, once per (sha, check, status). */
export async function recordCiChecks(paths: StatePaths, runs: CheckRun[], at: Date, ctx: { sha: string; pr?: number; issue?: number }): Promise<void> {
  for (const r of runs) {
    if (r.status !== "completed") continue;
    const status = r.conclusion ?? "unknown";
    const key = `${paths.root}|${ctx.sha}|${r.name}|${status}`;
    if (seenChecks.has(key)) continue;
    seenChecks.add(key);
    await recordEvent(paths, {
      kind: "ci.check", at: at.toISOString(), ...(ctx.issue ? { issue: ctx.issue } : {}),
      payload: { sha: ctx.sha, ...(ctx.pr === undefined ? {} : { pr: ctx.pr }), check: r.name, status, run_id: r.id },
    });
  }
}

/** Pull request numbers a body cites (`#123`, `pull/123`): what the post-merge defect metric joins on. */
export function citedPrs(body: string): number[] {
  return [...new Set([...body.matchAll(/(?:pull\/|#)(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** Spec 012 AC-2: `issue.filed` for every issue the scheduler creates. */
export async function recordIssueFiled(paths: StatePaths, f: { number: number; by: string; cls: string; labels: string[]; marker: string | null; body: string; at: Date }): Promise<void> {
  await recordEvent(paths, {
    kind: "issue.filed", at: f.at.toISOString(),
    payload: { number: f.number, by: f.by, class: f.cls, labels: f.labels, marker: f.marker, prs: citedPrs(f.body) },
  });
}
