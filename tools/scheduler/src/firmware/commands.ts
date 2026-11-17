import { applyAction, type ActionContext } from "../actions/index.ts";
import { readBoard } from "./board.ts";
import { readReleases } from "./releases.ts";

export interface FirmwareOutput { lines: string[]; exitCode: 0 | 1 }

const usage = "usage: board [back|bricked <reason>]; firmware [promote <tag>|demote <tag> <reason>]";

/**
 * Spec 070 AC-12: `board` and `firmware` print and write nothing; the rest go through `applyAction` as the maintainer,
 * with the `why` built as the `cred` commands build theirs.
 */
export async function firmwareCommand(command: "board" | "firmware", rest: string[], ctx: ActionContext): Promise<FirmwareOutput> {
  const [verb, ...more] = rest;
  if (verb === undefined) {
    if (command === "board") return { lines: [JSON.stringify(await readBoard(ctx.paths), null, 2)], exitCode: 0 };
    const rs = await readReleases(ctx.paths);
    return { lines: [JSON.stringify(rs.map((r) => ({ tag: r.tag, channel: r.channel, hil: r.hil, soak: r.soak, promoted_by: r.promoted_by, demoted_at: r.demoted_at, criteria: r.criteria })), null, 2)], exitCode: 0 };
  }
  const run = async (kind: string, args: Record<string, unknown>): Promise<FirmwareOutput> => {
    const row = await applyAction(ctx, { agent: "maintainer", run_id: "command", kind, args, why: `Maintainer command line ${kind.replace("_", " ")} request` }, "maintainer");
    return row.status === "applied" ? { lines: [JSON.stringify(row)], exitCode: 0 } : { lines: [row.reason ?? row.status], exitCode: 1 };
  };
  if (command === "board" && verb === "back") {
    const cur = await readBoard(ctx.paths);
    if (cur.status === "ok" || cur.status === "unknown") return { lines: [`The board is already ${cur.status}; nothing changed.`], exitCode: 0 };
    return run("board_back", {});
  }
  if (command === "board" && verb === "bricked" && more.length) return run("board_bricked", { reason: more.join(" ") });
  if (command === "firmware" && verb === "promote" && more.length === 1) return run("firmware_promote", { tag: more[0] });
  if (command === "firmware" && verb === "demote" && more.length >= 2) return run("firmware_demote", { tag: more[0], reason: more.slice(1).join(" ") });
  return { lines: [usage], exitCode: 1 };
}
