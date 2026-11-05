import { checkCredential, type CredDeps } from "../credentials/check.ts";
import type { PausedRecord } from "../state/paused.ts";
import type { Question } from "../types.ts";
import { approveParty } from "./gate.ts";
import type { StatePaths } from "../state/paths.ts";

export type Outcome = "approved" | "denied" | "declined" | "verified" | "check_failed" | "text";

const firstWord = (t: string) => (/^\s*([A-Za-z']+)/.exec(t)?.[1] ?? "").toLowerCase();
const APPROVING = ["approve", "approved", "yes", "ok"];

/**
 * Spec 030 AC-8: before the asking session resumes, a first-contact approval registers the party and a credential
 * "done" is verified by the entry's own check. Returns the answer the stage receives; funds pass through.
 */
export async function applyRequestAnswer(d: { paths: StatePaths; credentialDeps?: CredDeps; now: () => Date }, rec: Pick<PausedRecord, "question" | "issue" | "question_comment_id">, text: string): Promise<string> {
  const req = rec.question.request;
  if (!req) return text;
  if (req.type === "first_contact") {
    if (APPROVING.includes(firstWord(text)))
      await approveParty(d.paths, { party: req.party, channel: req.channel, approved_at: d.now().toISOString(), question_comment_id: rec.question_comment_id, issue: rec.issue });
    return text;
  }
  if (req.type === "credential" && firstWord(text) === "done") {
    const entry = d.credentialDeps?.catalogue[req.name];
    if (!d.credentialDeps || !entry) return `done (not verified: ${req.name} is not in the catalogue yet)`;
    const r = await checkCredential(d.credentialDeps, req.name);
    return r.status === "ok" ? "done (verified)" : `done (check failed: ${r.status === "missing" ? "credential is not set; run cred set" : r.status.replace(/^failed: /, "")})`;
  }
  return text;
}

/** The outcome recorded on the answer record, derived from the answer the stage received. */
export function outcomeOf(q: Question, answer: string): Outcome | undefined {
  const req = q.request;
  if (!req) return undefined;
  const w = firstWord(answer);
  if (req.type === "first_contact") return APPROVING.includes(w) ? "approved" : ["deny", "denied", "no"].includes(w) ? "denied" : "text";
  if (req.type === "funds") return w === "approved" ? "approved" : w === "declined" ? "declined" : "text";
  if (answer.startsWith("done (verified)")) return "verified";
  if (answer.startsWith("done (check failed")) return "check_failed";
  return w === "can't" || w === "cant" ? "declined" : "text";
}
