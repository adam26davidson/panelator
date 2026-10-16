export interface PullRequestInfo {
  number: number;
  head_sha: string;
  /** I1: the branch the PR merges into and the branch it comes from. */
  base_ref: string;
  head_ref: string;
  url: string;
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
