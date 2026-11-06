/** Every event kind of spec 012 AC-2; `aws.cost` has no producer until spec F1. */
export const EVENT_KINDS = [
  "run.ended", "chain.transition", "issue.eligible", "issue.claimed", "issue.released", "merge", "pr.opened", "ci.check",
  "review.result", "finding.queued", "finding.triaged", "action", "question", "pause.started", "pause.ended", "slots.sample",
  "maintainer.contact", "parameter.changed", "agent.run", "issue.filed", "reflection.plan", "metrics.snapshot", "aws.cost",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The payload schema per kind (`schemas/scheduler/<name>.json`); kinds absent here take any object. */
export const PAYLOAD_SCHEMAS: Partial<Record<EventKind, string>> = {
  "run.ended": "usage-record",
  action: "action-log-entry",
  question: "question-log-entry",
  "finding.triaged": "triage-entry",
};
