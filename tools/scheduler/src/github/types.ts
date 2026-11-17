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

export interface IssueComment {
  id: number;
  author: string;
  at: string;
  body: string;
}

/** Spec 070: a check run with its output, as the HIL check is read. */
export interface CheckRunDetail {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  html_url: string;
  output_text: string | null;
}

/** Spec 070 AC-8: a GitHub Release as the scheduler reads it. */
export interface ReleaseInfo {
  id: number;
  tag: string;
  prerelease: boolean;
  published_at: string;
  url: string;
}
