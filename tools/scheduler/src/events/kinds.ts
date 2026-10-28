/** The event kinds of spec 012 AC-2. `aws.cost` is reserved with no producer until spec F2/F1 record it. */
export const EVENT_KINDS = [
  "run.ended", "chain.transition", "issue.eligible", "issue.claimed", "issue.released", "merge", "pr.opened", "ci.check",
  "review.result", "finding.queued", "finding.triaged", "action", "question", "pause.started", "pause.ended", "slots.sample",
  "maintainer.contact", "parameter.changed", "agent.run", "issue.filed", "reflection.plan", "metrics.snapshot", "aws.cost",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Kinds with no producer in this spec: the every-kind assertion skips them. */
export const UNPRODUCED_KINDS: readonly EventKind[] = ["aws.cost"];

/** F2 adds these contact kinds; here only the first three are recorded. */
export const CONTACT_KINDS = ["notification", "question", "reminder", "funds", "credential", "first_contact"] as const;
