export interface PullRequestInfo {
  number: number;
  head_sha: string;
  /** I1: the branch the PR merges into and the branch it comes from. */
  base_ref: string;
  head_ref: string;
  url: string;
  body: string;
  mergeable: boolean | null;
  mergeable_state: string;
  merged: boolean;
  state: "open" | "closed";
}

export interface CheckRun {
  name: string;
  id: number;
  status: string;
  conclusion: string | null;
}

export interface CheckSummary {
  status: "green" | "failed" | "pending";
  runs: CheckRun[];
  failed: { name: string; id: number }[];
}

/** An issue as the REST list returns it, without the timeline reads `listOpenIssues` makes. */
export interface RawIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
}

export interface IssueComment {
  id: number;
  author: string;
  at: string;
  body: string;
}
