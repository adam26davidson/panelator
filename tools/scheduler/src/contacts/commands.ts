import type { ActionLog } from "../actions/log.ts";
import { readParties, removeParty } from "./gate.ts";
import type { StatePaths } from "../state/paths.ts";

/** Spec 030 AC-12: the parties list and its removal, the latter logged as the maintainer. */
export async function contactsList(paths: StatePaths): Promise<string> {
  const parties = await readParties(paths);
  if (!parties.length) return "no approved parties";
  return parties.map((p) => `${p.party}\t${p.channel}\tapproved ${p.approved_at}\tissue #${p.issue}\tquestion ${p.question_comment_id ?? "-"}`).join("\n");
}

export async function contactsRemove(paths: StatePaths, log: ActionLog, party: string): Promise<string> {
  const row = await log.writePending({ agent: "maintainer", run_id: "command", kind: "contacts_remove", args: { party }, why: "Maintainer command line contacts remove", undo: null });
  const removed = await removeParty(paths, party);
  await log.settle(row.id, removed ? "applied" : "failed", removed ? undefined : "party not found");
  if (!removed) throw new Error(`no approved party ${party}`);
  return `removed ${party}`;
}
