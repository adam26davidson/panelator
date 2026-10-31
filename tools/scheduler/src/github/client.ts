import type { Octokit } from "octokit";
import type { IssueData, LabelEvent } from "../types.ts";
import type { CheckRun, CheckSummary, IssueComment, PullRequestInfo } from "./types.ts";

type Rec = Record<string, unknown>;
const toComment = (c: Rec): IssueComment => ({ id: Number(c.id), author: String(rec(c.user).login ?? ""), at: String(c.created_at), body: String(c.body ?? "") });
const rec = (x: unknown): Rec => (typeof x === "object" && x !== null ? (x as Rec) : {});

export class GitHubClient {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;

  /** Waits before each re-list when the issue count disagrees with the server total (spec 014 AC-7). */
  readonly settleDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(octokit: Octokit, repo: string, opts: { settleDelaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}) {
    this.octokit = octokit;
    [this.owner, this.repo] = repo.split("/") as [string, string];
    this.settleDelaysMs = opts.settleDelaysMs ?? [1000, 3000, 9000];
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get base() {
    return { owner: this.owner, repo: this.repo };
  }

  /** Full pagination, PRs dropped, count asserted against the GraphQL total (process-spec 6.4). */
  async listOpenIssues(): Promise<IssueData[]> {
    // Right after a write the REST listing and the GraphQL total can briefly disagree (eventual
    // consistency, #26): re-list a bounded number of times, then fail loudly as before.
    let issues: Rec[] = [];
    for (let attempt = 0; ; attempt++) {
      const raw = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues", { ...this.base, state: "open", per_page: 100 })) as Rec[];
      issues = raw.filter((i) => !i.pull_request);
      const g = (await this.octokit.graphql(
        `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){issues(states:OPEN){totalCount}}}`,
        this.base,
      )) as { repository: { issues: { totalCount: number } } };
      const total = g.repository.issues.totalCount;
      if (issues.length === total) break;
      if (attempt >= this.settleDelaysMs.length) throw new Error(`issue list incomplete: got ${issues.length}, server reports ${total}`);
      await this.sleep(this.settleDelaysMs[attempt]!);
    }
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

  async comment(issue: number, body: string): Promise<{ id: number; created_at: string }> {
    const { data } = await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...this.base, issue_number: issue, body });
    return { id: Number(data.id), created_at: String(data.created_at) };
  }

  async listComments(issue: number): Promise<IssueComment[]> {
    const raw = (await this.octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { ...this.base, issue_number: issue, per_page: 100 })) as Rec[];
    return raw.map(toComment);
  }

  async issueComment(id: number): Promise<IssueComment | null> {
    try {
      const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", { ...this.base, comment_id: id });
      return toComment(data as Rec);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  }

  async closePullRequest(n: number): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", { ...this.base, pull_number: n, state: "closed" });
  }

  /** The numbers of the open pull requests whose head is `branch` in this repository (final review T2). */
  async openPullRequestsFrom(branch: string): Promise<number[]> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls", { ...this.base, head: `${this.owner}:${branch}`, state: "open", per_page: 100 });
    return (data as { number: number }[]).map((p) => p.number);
  }

  /** A branch that is already gone (404) or not a ref (422) is not an error. */
  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.octokit.request("DELETE /repos/{owner}/{repo}/git/refs/heads/{+branch}", { ...this.base, branch });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404 && status !== 422) throw e;
    }
  }

  async setIssueBody(issue: number, body: string): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue, body });
  }

  /** False when GitHub refuses to re-run the check (404 gone, 409 or 422 not re-runnable), true once accepted; any other error is thrown. */
  async rerequestCheckRun(id: number): Promise<boolean> {
    try {
      // No client retry: a 409 or 422 will not change on a second try, and the caller logs any error.
      await this.octokit.request("POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest", { ...this.base, check_run_id: id, request: { retries: 0 } });
      return true;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409 || status === 422) return false;
      throw e;
    }
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
    return { number: data.number, head_sha: data.head.sha, base_ref: data.base.ref, head_ref: data.head.ref, url: data.html_url, body: String(data.body ?? ""), mergeable: data.mergeable ?? null, mergeable_state: String(data.mergeable_state ?? ""), merged: Boolean(data.merged), state: data.state as "open" | "closed" };
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

  async createIssue(title:string,body:string,labels:string[]):Promise<number> {
    const {data}=await this.octokit.request('POST /repos/{owner}/{repo}/issues',{...this.base,title,body,labels,request:{retries:0}}); return data.number;
  }
  /** An issue's state and labels, for a reflection's `previous_plans` (spec 012 AC-15). */
  async issueState(issue: number): Promise<{ state: "open" | "closed"; labels: string[]; closed_at: string | null }> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", { ...this.base, issue_number: issue });
    return { state: data.state as "open" | "closed", labels: (data.labels as unknown[]).map((l) => (typeof l === "string" ? l : String(rec(l).name))), closed_at: data.closed_at ? String(data.closed_at) : null };
  }
  /** Creates the labels that do not exist yet, as the claim label is (spec 012 AC-16). */
  async ensureLabels(labels: string[]): Promise<void> {
    const have = new Set(((await this.octokit.paginate("GET /repos/{owner}/{repo}/labels", { ...this.base, per_page: 100 })) as Rec[]).map((l) => String(l.name)));
    for (const name of labels.filter((l) => !have.has(l))) await this.octokit.request("POST /repos/{owner}/{repo}/labels", { ...this.base, name, request: { retries: 0 } });
  }
  async listOpenIssuesByLabel(label:string):Promise<IssueData[]> {return (await this.listOpenIssues()).filter(i=>i.labels.includes(label));}
  async listOpenIssuesByAuthor(login:string):Promise<IssueData[]> {return (await this.listOpenIssues()).filter(i=>i.author===login);}
  async searchOpenIssuesByMarker(marker:string):Promise<IssueData[]> {return (await this.listOpenIssues()).filter(i=>i.body.includes(marker));}
  /** An empty comment closes without commenting (a caller that already posted its comment, spec 014). */
  async closeIssue(n:number,comment:string):Promise<void> {
    if(comment)await this.comment(n,comment);
    await this.octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}',{...this.base,issue_number:n,state:'closed'});
  }
  async findDraftSecurityAdvisory(marker:string):Promise<string|null> {
    const rows=await this.octokit.paginate('GET /repos/{owner}/{repo}/security-advisories',{...this.base,state:'draft',per_page:100});
    return rows.find(r=>r.description?.includes(marker))?.ghsa_id??null;
  }
  async createDraftSecurityAdvisory(input:{title:string;description:string;severity:'low'|'medium'|'high'|'critical'}):Promise<string> {
    const {data}=await this.octokit.request('POST /repos/{owner}/{repo}/security-advisories',{...this.base,summary:input.title,description:input.description,severity:input.severity,vulnerabilities:[],request:{retries:0}});return data.ghsa_id;
  }

  async rerunWorkflowRun(runId: number): Promise<void> {
    await this.octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {...this.base,run_id:runId,request:{retries:0}});
  }

  async cancelWorkflowRun(runId: number): Promise<void> {
    await this.octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {...this.base,run_id:runId,request:{retries:0}});
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
