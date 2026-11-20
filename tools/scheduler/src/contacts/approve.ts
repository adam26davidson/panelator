import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "../state/paths.ts";
import { readParties, type Party } from "./gate.ts";

export async function writeParties(paths: Pick<StatePaths, "contactsParties">, parties: Party[]): Promise<void> {
  const v = validate("contacts", parties);
  if (!v.ok) throw new Error(`invalid parties: ${v.errors.join("; ")}`);
  await mkdir(dirname(paths.contactsParties), { recursive: true });
  await writeFile(paths.contactsParties + ".tmp", JSON.stringify(parties, null, 2) + "\n");
  await rename(paths.contactsParties + ".tmp", paths.contactsParties);
}

/** Spec 099 AC-5: the one writer of contacts/parties.json besides `contacts remove`; an existing party is replaced. */
export async function approveParty(paths: Pick<StatePaths, "contactsParties">, entry: Party): Promise<void> {
  const parties = (await readParties(paths)).filter((p) => p.party !== entry.party);
  await writeParties(paths, [...parties, entry]);
}
