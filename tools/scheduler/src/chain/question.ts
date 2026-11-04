import type { Question, Request } from "../types.ts";

/** Spec 030 AC-7: the request's fields as a labelled list; setup steps numbered, the message quoted in full. */
export function renderRequest(r: Request): string[] {
  const quote = (t: string) => t.split("\n").map((l) => `> ${l}`);
  switch (r.type) {
    case "credential":
      return ["Credential request", `Name: ${r.name}`, `Provider: ${r.provider}`, `Access: ${r.access.join("; ")}`, "Setup:", ...r.setup.map((s, i) => `${i + 1}. ${s}`)];
    case "funds":
      return ["Funds request", `Amount: $${r.amount_usd}`, `Purpose: ${r.purpose}`, `Charter goal: ${r.charter_goal}`];
    case "first_contact":
      return ["First-contact request", `Party: ${r.party}`, `Channel: ${r.channel}`, `Why: ${r.why}`, "Message that would be sent:", ...quote(r.message)];
  }
}

/** C9: a leaf module, so the paused-record code and the driver share the comment format without importing the machine. */

/** The hidden last line of a question comment; recovery adopts a bot comment only when it carries the paused record's nonce (AC-13). */
export function questionMarker(nonce: string): string {
  return `<!-- panelator-question:${nonce} -->`;
}

/** The question comment without its marker: also the question as a stage prompt shows it. */
export function questionBody(q: Question, maintainer: string): string {
  return [
    "### Question for the maintainer",
    `@${maintainer}`,
    "",
    q.question,
    "",
    ...(q.request ? [...renderRequest(q.request), ""] : []),
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
  return `${body}\n\n${questionMarker(nonce)}`;
}
