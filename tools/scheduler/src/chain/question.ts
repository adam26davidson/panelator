import type { Question } from "../types.ts";

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
    ...q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.cost}`),
    "",
    `Recommendation: ${q.recommendation}`,
    "",
    "Reply in a comment on this issue; the scheduler resumes on your reply.",
  ].join("\n");
}

/** The issue comment of AC-13: heading, mention, question, options with costs, recommendation, and the nonce last. */
export function formatQuestion(q: Question, maintainer: string, nonce: string): string {
  return `${questionBody(q, maintainer)}\n\n${questionMarker(nonce)}`;
}
