import { isDone } from "../children/markers.ts";
import type { ChildrenGh } from "../children/scan.ts";
import type { IssueComment } from "../github/types.ts";
import type { IssueData } from "../types.ts";

export { isDone };

export const BLOCKED_LABEL = "blocked";
/** On the comment saying the filer's issue waits for no issue; nothing lifts it by code (spec 066 AC-4). */
export const BLOCKED_UNTIL_MARKER = "<!-- panelator-blocked-until -->";

const ascending = (nums: number[]) => [...new Set(nums)].sort((a, b) => a - b);
/** On the comment saying which issues the filed issue waits for (spec 066 AC-3). */
export const blockedByMarker = (nums: number[]) => `<!-- panelator-blocked-by:${ascending(nums).join(",")} -->`;
/** On the comment saying the scan removed the block (spec 066 AC-7). */
export const unblockedByMarker = (nums: number[]) => `<!-- panelator-unblocked-by:${ascending(nums).join(",")} -->`;

/** The numbers of the first blocked-by marker in a comment body, or null. */
export function parseBlockedBy(body: string): number[] | null {
  const m = /<!-- panelator-blocked-by:(\d+(?:,\d+)*) -->/.exec(body);
  return m ? m[1]!.split(",").map(Number) : null;
}
export const hasUnblockedByMarker = (body: string) => /<!-- panelator-unblocked-by:/.test(body);
export const hasBlockedUntilMarker = (body: string) => body.includes(BLOCKED_UNTIL_MARKER);


const list = (nums: number[]) => ascending(nums).map((n) => `#${n}`).join(", ");

export const blockedByComment = (nums: number[], repointed?: { from: number; to: number }) =>
  `Blocked until ${list(nums)} are done${repointed ? ` (#${repointed.from} was superseded by #${repointed.to})` : ""}.\n\n${blockedByMarker(nums)}`;
export const blockedUntilComment = (text: string) =>
  `Blocked until ${text}. Nothing lifts this label by itself: remove it by hand when the condition holds.\n\n${BLOCKED_UNTIL_MARKER}`;
export const unblockedComment = (nums: number[]) => `Unblocked: ${list(nums)} are done.\n\n${unblockedByMarker(nums)}`;

/**
 * The numbers of the latest blocked-by marker comment by the bot, or null when there is none or a later bot
 * comment lifted it. A comment by any other account never counts.
 */
export function latestBlockedBy(comments: IssueComment[], botLogin: string): number[] | null {
  let latest: number[] | null = null;
  for (const c of comments) {
    if (c.author !== botLogin) continue;
    const nums = parseBlockedBy(c.body);
    if (nums) latest = nums;
    else if (hasUnblockedByMarker(c.body)) latest = null;
  }
  return latest;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Spec 066 AC-7: remove `blocked` from the filer's issues whose blocked-by issues are all done. */
export async function liftFilerBlocks(d: {
  gh: Pick<ChildrenGh, "comment" | "listComments" | "removeLabel">;
  issues: IssueData[];
  botLogin: string;
  log: (rec: Record<string, unknown>) => void;
}): Promise<{ unblocked: number[]; errors: string[] }> {
  const out = { unblocked: [] as number[], errors: [] as string[] };
  for (const issue of d.issues) {
    if (issue.author !== d.botLogin || issue.state !== "open" || !issue.labels.includes(BLOCKED_LABEL)) continue;
    // A planned child's block is spec 031 AC-6's, not this pass's.
    if (issue.body.includes("<!-- panelator-child:")) continue;
    try {
      const nums = latestBlockedBy(await d.gh.listComments(issue.number), d.botLogin);
      if (!nums) continue;
      let waiting = false;
      for (const n of nums) {
        const dep = d.issues.find((i) => i.number === n);
        if (!dep) d.log({ kind: "filer-blocked-by-unknown", issue: issue.number, blocked_by: n });
        else if (!isDone(dep)) waiting = true;
      }
      if (waiting) continue;
      await d.gh.removeLabel(issue.number, BLOCKED_LABEL);
      issue.labels = issue.labels.filter((l) => l !== BLOCKED_LABEL);
      await d.gh.comment(issue.number, unblockedComment(nums));
      out.unblocked.push(issue.number);
      d.log({ kind: "filer-unblocked", issue: issue.number, blocked_by: nums });
    } catch (e) {
      out.errors.push(`#${issue.number}: unblock: ${message(e)}`);
    }
  }
  return out;
}
