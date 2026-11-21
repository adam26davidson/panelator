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
  /** The URL of the workflow run's job (spec 101 AC-2); null when the API omits it. */
  details_url: string | null;
}

export interface CheckSummary {
  status: "green" | "failed" | "pending";
  runs: CheckRun[];
  failed: { name: string; id: number }[];
}

/** Spec 028: one issue read by number, with the pull requests merged against it (from its timeline). */
export interface IssueState {
  number: number;
  author: string;
  state: "open" | "closed";
  labels: string[];
  closedAt: string | null;
  pullRequests: number[];
}

export interface IssueComment {
  id: number;
  author: string;
  at: string;
  body: string;
}
