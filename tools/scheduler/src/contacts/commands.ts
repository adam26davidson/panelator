import type { StatePaths } from "../state/paths.ts";
import { writeParties } from "./approve.ts";
import { readParties } from "./gate.ts";
import { appendContactLog } from "./log.ts";

/** Spec 099 AC-9: `contacts list` and `contacts remove <party>`; `contacts log` is spec 083's. */
export async function contactsCommand(verb: string, party: string | undefined, deps: { paths: StatePaths; now: () => Date }): Promise<{ lines: string[]; exitCode: number }> {
  const parties = await readParties(deps.paths);
  if (verb === "list") return { lines: [JSON.stringify(parties, null, 2)], exitCode: 0 };
  if (verb === "remove") {
    const found = party ? parties.find((p) => p.party === party) : undefined;
    if (!party || !found) return { lines: [`no approved party ${party ?? ""}`.trim()], exitCode: 1 };
    await writeParties(deps.paths, parties.filter((p) => p.party !== party));
    await appendContactLog(deps.paths, { at: deps.now().toISOString(), event: "removed", actor: "maintainer", party, entry: found });
    return { lines: [`removed ${party}`], exitCode: 0 };
  }
  return { lines: ["usage: contacts list|remove <party>|log [--since time]"], exitCode: 1 };
}
