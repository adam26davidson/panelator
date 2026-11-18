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
