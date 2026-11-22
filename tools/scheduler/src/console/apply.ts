import { appendFile } from "node:fs/promises";
import { applyAction, type ActionContext } from "../actions/index.ts";
import { undoAction } from "../actions/undo.ts";
import { setParameterModeCommand } from "../parameters/command.ts";
import { validate } from "../schema/validate.ts";
import { readChanges, type ChangeRecord } from "./state.ts";

export interface Change { id: number; at: string; by: string; kind: string; args: Record<string, unknown> }
export type Outcome = { status: "applied"; action_id?: string } | { status: "refused"; reason: string };

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The cursor of the change poll: the last id recorded in `console/changes.jsonl` (spec 051 AC-4). */
export async function cursor(ctx: ActionContext): Promise<number> {
  const rows = await readChanges(ctx.paths);
  return rows.reduce((m, r) => Math.max(m, r.id), 0);
}

async function run(ctx: ActionContext, c: Change): Promise<Outcome> {
  const run_id = `console:${c.id}`;
  const a = c.args;
  const only = (keys: string[]) => Object.keys(a).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(a, k));
  const viaAction = async (kind: string, args: Record<string, unknown>, why: string): Promise<Outcome> => {
    const row = await applyAction(ctx, { agent: "maintainer", run_id, kind, args, why }, "maintainer");
    return row.status === "applied" ? { status: "applied", action_id: row.id } : { status: "refused", reason: row.reason ?? `action ${row.status}` };
  };
  switch (c.kind) {
    case "set_parameter":
      if (!only(["name", "value"]) || !str(a.name)) return { status: "refused", reason: "set_parameter needs name and value" };
      return viaAction("set_parameter", { name: a.name, value: a.value }, `Set parameter ${a.name} from the maintainer console`);
    case "pause_agent": case "resume_agent":
      if (!only(["name"]) || !str(a.name)) return { status: "refused", reason: `${c.kind} needs name` };
      return viaAction(c.kind, { name: a.name }, `${c.kind === "pause_agent" ? "Pause" : "Resume"} agent ${a.name} from the maintainer console`);
    case "undo": {
      if (!only(["action_id"]) || !str(a.action_id)) return { status: "refused", reason: "undo needs action_id" };
      const row = await undoAction(ctx, a.action_id, "maintainer", run_id);
      return row.status === "applied" ? { status: "applied", action_id: row.id } : { status: "refused", reason: row.reason ?? `action ${row.status}` };
    }
    case "set_parameter_mode":
      if (!only(["name", "mode"]) || !str(a.name) || !str(a.mode)) return { status: "refused", reason: "set_parameter_mode needs name and mode" };
      await setParameterModeCommand(ctx.parameters, a.name, a.mode);
      return { status: "applied" };
    default:
      return { status: "refused", reason: `unknown change kind ${c.kind}` };
  }
}

/**
 * Applies one pulled change as the maintainer and records it with its outcome. An id already recorded is not applied again;
 * its recorded outcome is returned (spec 051 AC-4).
 */
export async function applyChange(ctx: ActionContext, raw: unknown): Promise<{ change: ChangeRecord; fresh: boolean }> {
  const v = validate("console-change", raw);
  const maybe = raw as { id?: unknown };
  const known = typeof maybe?.id === "number" ? (await readChanges(ctx.paths)).find((r) => r.id === maybe.id) : undefined;
  if (known) return { change: known, fresh: false };
  const at = ctx.now().toISOString();
  let outcome: Outcome;
  let c: Change;
  if (!v.ok) {
    const r = (raw ?? {}) as Partial<Change>;
    c = { id: Number(r.id), at: r.at ?? at, by: r.by ?? "", kind: String(r.kind ?? ""), args: (r.args ?? {}) as Record<string, unknown> };
    outcome = { status: "refused", reason: `malformed change: ${v.errors[0]}` };
    if (!Number.isInteger(c.id)) throw new Error("change without an id");
  } else {
    c = raw as Change;
    try { outcome = await run(ctx, c); } catch (e) { outcome = { status: "refused", reason: (e as Error).message }; }
  }
  const rec: ChangeRecord = { id: c.id, at: c.at, by: c.by, kind: c.kind, args: c.args, ...outcome };
  await appendFile(ctx.paths.consoleChanges, JSON.stringify(rec) + "\n");
  return { change: rec, fresh: true };
}

