import type { Config } from "../config.ts";
import type { IssueData } from "../types.ts";

export interface RecentMerges {
  feature: number;
  debt: number;
}

export function classOf(issue: IssueData, labels: Config["labels"]): "feature" | "debt" | "none" {
  if (issue.labels.some((l) => labels.feature_classes.includes(l))) return "feature";
  if (issue.labels.some((l) => labels.debt_classes.includes(l))) return "debt";
  return "none";
}

/** Priority label first, then the class behind the 2:1 feature:debt ratio, then oldest (spec section 7). */
export function rankIssues(issues: IssueData[], labels: Config["labels"], recent: RecentMerges): IssueData[] {
  // Prefer feature until two features have been merged per debt item already merged plus the one about to be.
  const preferred: "feature" | "debt" = recent.feature < 2 * (recent.debt + 1) ? "feature" : "debt";
  const rank = (i: IssueData) => {
    if (i.labels.includes(labels.priority)) return 0;
    const c = classOf(i, labels);
    if (c === preferred) return 1;
    if (c === "none") return 3;
    return 2;
  };
  return [...issues].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
}
