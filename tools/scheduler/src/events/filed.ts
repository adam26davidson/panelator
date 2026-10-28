import type { StatePaths } from "../state/paths.ts";
import { recordEvent } from "./store.ts";

/** Pull request numbers a body cites (`#123`, `pull/123`): what the post-merge defect metric joins on. */
export function citedPrs(body: string): number[] {
  return [...new Set([...body.matchAll(/(?:pull\/|#)(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** Spec 012 AC-2: `issue.filed` for every issue the scheduler creates. */
export async function recordIssueFiled(paths: StatePaths, f: { number: number; by: string; cls: string; labels: string[]; marker: string | null; body: string; at: Date }): Promise<void> {
  await recordEvent(paths, {
    kind: "issue.filed", at: f.at.toISOString(),
    payload: { number: f.number, by: f.by, class: f.cls, labels: f.labels, marker: f.marker, prs: citedPrs(f.body) },
  });
}
