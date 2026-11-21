import { readFile } from "node:fs/promises";
import { validateSchema } from "../credentials/catalogue.ts";
import type { ParameterStore } from "../parameters/store.ts";
import type { StatePaths } from "../state/paths.ts";

export interface Party { party: string; channel: string; approved_at: string; question_comment_id: number | string | null; issue: number | null }
export type ContactDecision = { status: "allowed" } | { status: "refused"; text: string };

export async function readParties(paths: Pick<StatePaths, "contactsParties">): Promise<Party[]> {
  let raw: string;
  try {
    raw = await readFile(paths.contactsParties, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const data = JSON.parse(raw) as unknown;
  const v = validateSchema("contacts", data);
  if (!v.ok) throw new Error(`contacts/parties.json: ${v.errors.join("; ")}`);
  return data as Party[];
}

/** Spec 099 AC-8: the gate a channel's wrapper calls before a first contact. The caller, not this function, writes spec 083's `refused` line. */
export async function checkContact(ctx: { paths: Pick<StatePaths, "contactsParties">; parameters: Pick<ParameterStore, "read"> }, party: string): Promise<ContactDecision> {
  if ((await ctx.parameters.read("first_contact_needs_approval")) as unknown === false) return { status: "allowed" };
  if ((await readParties(ctx.paths)).some((p) => p.party === party)) return { status: "allowed" };
  return { status: "refused", text: `first contact with ${party} is not approved: raise a capability question with a first_contact request naming it and wait for the maintainer's answer` };
}
