import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { EVENT_KINDS, type EventKind } from "./kinds.ts";

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
