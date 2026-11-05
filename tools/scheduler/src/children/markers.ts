import type { ChildEntry } from "../spec/parse.ts";
import type { IssueData } from "../types.ts";

/** The marker in a filed child's body: the idempotency key of the scan (spec 031 AC-4). */
export const childMarker = (design: string, slug: string) => `<!-- panelator-child:${design}:${slug} -->`;
/** On the comment saying the scan blocked the child's issue (AC-5). */
export const blockedMarker = (design: string, slug: string) => `<!-- panelator-child-blocked:${design}:${slug} -->`;
/** On the comment saying the scan removed the block (AC-6). */
export const unblockedMarker = (design: string, slug: string) => `<!-- panelator-child-unblocked:${design}:${slug} -->`;

/** Free text must not carry a marker: only the scan's own does (as stripCapabilityMarkers does for the filer). */
export const neutraliseChildMarkers = (text: string) => text.replace(/<!--\s*panelator-child[:-]/gi, "<!-- ");

/** True when the issue is the App's record of the planned child; an issue by any other account never is. */
export const isChildIssue = (issue: IssueData, design: string, slug: string, botLogin: string) =>
  issue.author === botLogin && issue.body.includes(childMarker(design, slug));

/** Done: closed and not abandoned (an abandoned issue is re-triaged into a new one). */
export const isDone = (issue: IssueData) => issue.state === "closed" && !issue.labels.includes("abandoned");

export interface ResolvedChild {
  /** The child's issue number, or null when it has none. */
  number: number | null;
  issue: IssueData | null;
  /** A recorded `issue:` that does not exist or is closed with `abandoned` (AC-7). */
  dead: boolean;
}

/** AC-4 and AC-7: the entry's `issue:` wins; else the bot-authored issue carrying the marker, open or closed. */
export function resolveChildIssue(entry: ChildEntry, design: string, issues: IssueData[], botLogin: string): ResolvedChild {
  if (entry.issue !== undefined) {
    const issue = issues.find((i) => i.number === entry.issue) ?? null;
    const dead = !issue || (issue.state === "closed" && issue.labels.includes("abandoned"));
    return { number: entry.issue, issue, dead };
  }
  const issue = issues.find((i) => isChildIssue(i, design, entry.slug ?? "", botLogin)) ?? null;
  return { number: issue?.number ?? null, issue, dead: false };
}
