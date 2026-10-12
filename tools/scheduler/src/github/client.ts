import type { Octokit } from "octokit";
import type { IssueData, LabelEvent } from "../types.ts";
import type { CheckRun, CheckSummary, PullRequestInfo } from "./types.ts";

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec => (typeof x === "object" && x !== null ? (x as Rec) : {});

export class GitHubClient {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  constructor(octokit: Octokit, repo: string) {
    this.octokit = octokit;
    [this.owner, this.repo] = repo.split("/") as [string, string];
  }

  private get base() {
    return { owner: this.owner, repo: this.repo };
  }

  /** Full pagination, PRs dropped, count asserted against the GraphQL total (process-spec 6.4). */
  async listOpenIssues(): Promise<IssueData[]> {
    const raw = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues", { ...this.base, state: "open", per_page: 100 })) as Rec[];
    const issues = raw.filter((i) => !i.pull_request);
    const g = (await this.octokit.graphql(
      `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(states:OPEN){totalCount}}}`,
      this.base,
    )) as { repository: { issues: { totalCount: number } } };
    const total = g.repository.issues.totalCount;
    if (issues.length !== total) throw new Error(`issue list incomplete: got ${issues.length}, server reports ${total}`);
    const out: IssueData[] = [];
    for (const i of issues) {
      out.push({
        number: Number(i.number),
        title: String(i.title ?? ""),
        author: String(rec(i.user).login ?? ""),
        body: String(i.body ?? ""),
        labels: ((i.labels as unknown[]) ?? []).map((l) => (typeof l === "string" ? l : String(rec(l).name))),
        labelEvents: await this.labelEvents(Number(i.number)),
        createdAt: String(i.created_at),
      });
    }
    return out;
  }

  async labelEvents(issue: number): Promise<LabelEvent[]> {
    const events = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", { ...this.base, issue_number: issue, per_page: 100 })) as Rec[];
    return events
      .filter((e) => e.event === "labeled" || e.event === "unlabeled")
      .map((e) => ({ label: String(rec(e.label).name), actor: String(rec(e.actor).login ?? ""), action: e.event as LabelEvent["action"], at: String(e.created_at) }));
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", { ...this.base, issue_number: issue, labels });
  }

  async removeLabel(issue: number, label: string): Promise<void> {
    try {
      await this.octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", { ...this.base, issue_number: issue, name: label });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  async comment(issue: number, body: string): Promise<void> {
    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...this.base, issue_number: issue, body });
  }

  async issueLabels(issue: number): Promise<string[]> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue });
    return (data.labels as unknown[]).map((l) => (typeof l === "string" ? l : String(rec(l).name)));
  }

  async issueActivityAt(issue: number): Promise<string> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue });
    return String(data.updated_at);
  }

  async pullRequest(n: number): Promise<PullRequestInfo> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { ...this.base, pull_number: n });
    return { number: data.number, head_sha: data.head.sha, url: data.html_url, mergeable: data.mergeable ?? null, mergeable_state: String(data.mergeable_state ?? ""), merged: Boolean(data.merged), state: data.state as "open" | "closed" };
  }

  /** `required` empty means every check run on the sha must succeed; a required name not yet reported is pending. */
  async checks(sha: string, required: string[]): Promise<CheckSummary> {
    let total = 0;
    const raw = await this.octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...this.base, ref: sha, per_page: 100 }, (response) => {
      total = response.data.total_count;
      return response.data;
    });
    const runs: CheckRun[] = raw.map((r) => ({ name: r.name, id: Number(r.id), status: r.status, conclusion: r.conclusion ?? null }));
    if (runs.length !== total) throw new Error(`check runs incomplete: got ${runs.length}, server reports ${total}`);
    const considered = required.length ? runs.filter((r) => required.includes(r.name)) : runs;
    const missing = required.filter((n) => !runs.some((r) => r.name === n));
    const failed = considered.filter((r) => r.status === "completed" && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "neutral").map((r) => ({ name: r.name, id: r.id }));
    if (failed.length) return { status: "failed", runs, failed };
    if (missing.length || considered.some((r) => r.status !== "completed") || considered.length === 0) return { status: "pending", runs, failed };
    return { status: "green", runs, failed };
  }

  async jobLogExcerpt(jobId: number, lines = 200): Promise<string> {
    const res = await this.octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", { ...this.base, job_id: jobId });
    const text = typeof res.data === "string" ? res.data : res.data instanceof ArrayBuffer ? new TextDecoder().decode(res.data) : String(res.data ?? "");
    return text.split("\n").filter((l) => l.length).slice(-lines).join("\n");
  }

  async mergePullRequest(n: number, sha: string): Promise<{ merged: boolean; message: string }> {
    try {
      const { data } = await this.octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { ...this.base, pull_number: n, merge_method: "squash", sha, request: { retries: 0 } });
      return { merged: Boolean(data.merged), message: String(data.message ?? "") };
    } catch (e) {
      const err = e as { status?: number; message?: string; response?: { data?: { message?: string } } };
      if (err.status === 405 || err.status === 409 || err.status === 422) return { merged: false, message: err.response?.data?.message ?? err.message ?? `HTTP ${err.status}` };
      throw e;
    }
  }
}
