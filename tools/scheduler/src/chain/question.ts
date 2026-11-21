import type { Question } from "../types.ts";
import { neutraliseMarkers } from "../github/markers.ts";

/** C9: a leaf module, so the paused-record code and the driver share the comment format without importing the machine. */

/** The hidden last line of a question comment; recovery adopts a bot comment only when it carries the paused record's nonce (AC-13). */
export function questionMarker(nonce: string): string {
  return `<!-- panelator-question:${nonce} -->`;
}

/** Spec 067 AC-3: the request, field by field, so the question check (which sees only this body) can find it. Empty for a question without one. */
function requestLines(q: Question): string[] {
  if (q.request === undefined) return [];
  const fields = Object.entries(q.request as Record<string, unknown>).filter(([k]) => k !== "type");
  return [
    `Request (${String(q.request.type)}):`,
    ...fields.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.map(String).join("; ") : String(v)}`),
    "",
  ];
}

/** The question comment without its marker: also the question as a stage prompt shows it. */
export function questionBody(q: Question, maintainer: string): string {
  return [
    "### Question for the maintainer",
    `@${maintainer}`,
    "",
    q.question,
    "",
    ...requestLines(q),
    ...q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.cost}`),
    "",
    `Recommendation: ${q.recommendation}`,
    "",
    "Reply in a comment on this issue; the scheduler resumes on your reply.",
  ].join("\n");
}

/** The issue comment of AC-13: heading, mention, question, options with costs, recommendation, and the nonce last. */
export function formatQuestion(q: Question, maintainer: string, nonce: string, channel:'telegram'|'issue'='issue'): string {
  const body=channel==='telegram'?questionBody(q,maintainer).replace(`@${maintainer}\n`,'').replace('Reply in a comment on this issue; the scheduler resumes on your reply.','This question was asked on Telegram. Reply there or comment here to resume the work.'):questionBody(q,maintainer);
  return `${neutraliseMarkers(body)}\n\n${questionMarker(nonce)}`;
}

/** Spec 067 AC-1: the fields of each request type, in the order a reason names them. */
const REQUEST_FIELDS = {
  credential: ["name", "provider", "access", "setup"],
  funds: ["amount_usd", "purpose", "charter_goal"],
  first_contact: ["party", "channel", "why", "message"],
} as const;

const blank = (v: unknown): boolean => typeof v !== "string" || v.trim() === "";

function emptyField(value: unknown, field: string): boolean {
  if (field === "amount_usd") return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
  if (field === "access" || field === "setup") return !Array.isArray(value) || value.length === 0 || value.some(blank);
  return blank(value);
}

/** Spec 067 AC-1: null when the question has no request or a complete one; otherwise the reason, naming every empty field. */
export function checkRequest(question: Question): string | null {
  const request = question.request as (Record<string, unknown> & { type?: unknown }) | undefined;
  if (request === undefined) return null;
  const type = request.type;
  if (type !== "credential" && type !== "funds" && type !== "first_contact") return "a request's type must be credential, funds or first_contact";
  const missing = REQUEST_FIELDS[type].filter((f) => emptyField(request[f], f));
  return missing.length === 0 ? null : `a ${type} request must give ${missing.join(", ")}`;
}

export type RequestOutcomeName = "approved" | "denied" | "verified" | "check_failed" | "declined" | "text";
export const REQUEST_BUTTONS = { credential: ["Done", "Can't do this"], funds: ["Approved", "Declined"], first_contact: ["Approve", "Deny"] } as const;

/** Spec 099 AC-5: what the scheduler does for an answer to a request, before the stage resumes. Pure. */
export function actOnAnswer(request: { type: string } | undefined, answer: string): { action: "approve_party" | "run_check" | "none"; outcome: RequestOutcomeName | null } {
  if (!request) return { action: "none", outcome: null };
  const text = answer.trim();
  const first = (text.split(/\s+/)[0] ?? "").toLowerCase().replace(/[.,!;:]+$/, "");
  if (request.type === "first_contact") {
    if (["approve", "approved", "yes", "ok"].includes(first)) return { action: "approve_party", outcome: "approved" };
    if (["deny", "denied", "no"].includes(first)) return { action: "none", outcome: "denied" };
    return { action: "none", outcome: "text" };
  }
  if (request.type === "credential") {
    if (first.startsWith("done")) return { action: "run_check", outcome: "verified" };
    if (text.toLowerCase().startsWith("can't do this") || text.toLowerCase().startsWith("cannot do this")) return { action: "none", outcome: "declined" };
    return { action: "none", outcome: "text" };
  }
  if (first === "approved") return { action: "none", outcome: "approved" };
  if (first === "declined") return { action: "none", outcome: "declined" };
  return { action: "none", outcome: "text" };
}

export function approvedAnswer(party: string): string {
  return `approved (recorded; no channel can reach ${party} yet: a credential that can is a credential request)`;
}

/** The answer the stage receives for a credential "Done", from the check's result; `skipped` and unknown names are `text` (nothing verified, nothing failed). */
export function doneAnswer(result: { status: "ok" } | { status: "failed"; reason: string } | { status: "skipped"; reason: string } | { status: "unknown"; name: string }): { answer: string; outcome: RequestOutcomeName } {
  if (result.status === "ok") return { answer: "done (verified)", outcome: "verified" };
  if (result.status === "failed") return { answer: `done (check failed: ${result.reason})`, outcome: "check_failed" };
  if (result.status === "skipped") return { answer: `done (not checked: ${result.reason})`, outcome: "text" };
  return { answer: `done (unverified: ${result.name} is not in the catalogue)`, outcome: "text" };
}

/** Spec 099 AC-4: the request as a Telegram message body: setup steps numbered, a first_contact message quoted in full. */
export function requestMessageLines(q: Question): string[] {
  if (q.request === undefined) return [];
  const r = q.request as Record<string, unknown>;
  const out = [`Request (${String(r.type)}):`];
  for (const [k, v] of Object.entries(r)) {
    if (k === "type") continue;
    if (k === "setup" && Array.isArray(v)) out.push("setup:", ...v.map((s, i) => `${i + 1}. ${String(s)}`));
    else if (k === "message") out.push("message:", ...String(v).split("\n").map((l) => `> ${l}`));
    else out.push(`${k}: ${Array.isArray(v) ? v.map(String).join("; ") : String(v)}`);
  }
  return out;
}
