import type { StatePaths } from "../state/paths.ts";
import { openIndex } from "./index.ts";

/**
 * Whether the store holds an open `issue.claimed` for the issue: the latest of its `issue.claimed` and `issue.released`
 * events is `issue.claimed` (spec 096 AC-1). The stale-claim drop uses it to record `issue.released` only for a claim
 * whose `issue.claimed` was recorded. Reads only.
 */
export function claimOpen(paths: StatePaths, issue: number): boolean {
  const db = openIndex(paths);
  try {
    const row = db.prepare("SELECT kind FROM events WHERE issue = ? AND kind IN ('issue.claimed', 'issue.released') ORDER BY at DESC, rowid DESC LIMIT 1").get(issue) as { kind: string } | undefined;
    return row !== undefined && row.kind === "issue.claimed";
  } finally {
    db.close();
  }
}
