import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validate, type SchemaName } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { EVENT_KINDS, PAYLOAD_SCHEMAS, type EventKind } from "./kinds.ts";

export interface EventInput {
  id?: string;
  at: string;
  kind: EventKind;
  issue?: number;
  run_id?: string;
  agent?: string;
  payload: Record<string, unknown>;
}
export interface PanelatorEvent extends EventInput {
  id: string;
}

/** The only writer of `events/<YYYY-MM>.jsonl` (spec 012 AC-1): one line appended, awaited, before the caller continues. */
export async function recordEvent(paths: StatePaths, event: EventInput, opts: { backfill?: boolean } = {}): Promise<{ event: PanelatorEvent; oldShape: boolean }> {
  const full: PanelatorEvent = { ...event, id: event.id ?? randomUUID() };
  if (!(EVENT_KINDS as readonly string[]).includes(full.kind)) throw new Error(`unknown event kind: ${full.kind}`);
  if (Number.isNaN(Date.parse(full.at))) throw new Error(`invalid event time: ${full.at}`);
  let oldShape = false;
  if (opts.backfill) {
    const env = validate("event", full, "envelope");
    if (!env.ok) throw new Error(`invalid ${full.kind} event: ${env.errors.join("; ")}`);
    const schema = PAYLOAD_SCHEMAS[full.kind];
    if (schema) {
      const { backfilled: _b, ...rest } = full.payload;
      oldShape = !validate(schema as SchemaName, rest).ok;
    }
  } else {
    const v = validate("event", full);
    if (!v.ok) throw new Error(`invalid ${full.kind} event: ${v.errors.join("; ")}`);
  }
  await mkdir(paths.events, { recursive: true });
  await appendFile(join(paths.events, `${full.at.slice(0, 7)}.jsonl`), JSON.stringify(full) + "\n");
  return { event: full, oldShape };
}

/** Records an event for a producer that must not lose it: failures surface as thrown errors. */
export const record = (paths: StatePaths, kind: EventKind, at: Date | string, payload: Record<string, unknown>, who: { issue?: number; run_id?: string; agent?: string } = {}) =>
  recordEvent(paths, { at: typeof at === "string" ? at : at.toISOString(), kind, payload, ...who }).then((r) => r.event);
