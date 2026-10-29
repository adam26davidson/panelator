import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";

const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
function issue(n: number, labels: string[] = ["validated"], extra: Record<string, unknown> = {}) {
  return { number: n, title: `i${n}`, body: `Spec: specs/0${n}0-x/spec.md`, user: BOT, labels: labels.map((name) => ({ name })), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...extra };
}
const timeline = (n: number): Route => ({
  method: "GET", path: new RegExp(`^/repos/o/r/issues/${n}/timeline$`),
  reply: () => ({ body: [
    { event: "labeled", actor: { login: "adam26davidson" }, label: { name: "validated" }, created_at: "2026-10-01T01:00:00Z" },
    { event: "commented", actor: { login: "x" }, created_at: "2026-10-01T02:00:00Z" },
    { event: "unlabeled", actor: { login: "adam26davidson" }, label: { name: "validated" }, created_at: "2026-10-01T03:00:00Z" },
    { event: "labeled", actor: { login: "panelator-pipeline[bot]" }, label: { name: "validated" }, created_at: "2026-10-01T04:00:00Z" },
  ] }),
});
function client(routes: Route[]) {
  const gh = mockGitHub(routes);
  const octokit = new Octokit({ auth: "ghs_mock", request: { fetch: gh.fetch } });
  return { c: new GitHubClient(octokit, "o/r"), gh };
}

describe('standing agent App writes',()=>{
 it('creates issues and private advisories; reruns and cancels workflow runs',async()=>{
  const {c,gh}=client([
   {method:'POST',path:/^\/repos\/o\/r\/issues$/,reply:()=>({status:201,body:{number:42}})},
   {method:'POST',path:/^\/repos\/o\/r\/security-advisories$/,reply:()=>({status:201,body:{ghsa_id:'GHSA-private'}})},
   {method:'POST',path:/^\/repos\/o\/r\/actions\/runs\/7\/(rerun|cancel)$/,reply:()=>({status:202,body:{}})},
   {method:'POST',path:/^\/repos\/o\/r\/issues\/42\/comments$/,reply:()=>({status:201,body:{id:1,created_at:'now'}})},
   {method:'PATCH',path:/^\/repos\/o\/r\/issues\/42$/,reply:()=>({body:{}})},
  ]);
  expect(await c.createIssue('Bug','Evidence',['validated','class:bug'])).toBe(42);
  expect(await c.createDraftSecurityAdvisory({title:'Private',description:'Details',severity:'high'})).toBe('GHSA-private');
  await c.rerunWorkflowRun(7);await c.cancelWorkflowRun(7);await c.closeIssue(42,'Superseded');
  expect(gh.calls[1].body).toMatchObject({summary:'Private',description:'Details',severity:'high'});expect(gh.unmatched).toEqual([]);
  const before=gh.calls.length;await c.closeIssue(42,'');
  expect(gh.calls.slice(before).map(x=>x.method)).toEqual(['PATCH']);
 },20000);
 it('surfaces actions:read permission failures without retrying a write',async()=>{
  const {c,gh}=client([{method:'POST',path:/^\/repos\/o\/r\/actions\/runs\/7\/rerun$/,reply:()=>({status:403,body:{message:'Resource not accessible by integration'}})}]);
  await expect(c.rerunWorkflowRun(7)).rejects.toThrow(/Resource not accessible/);expect(gh.calls).toHaveLength(1);
 });
});

describe("listOpenIssues (process-spec 6.4)", () => {
  const issuesRoute = (pages: unknown[][]): Route => ({
    method: "GET", path: /^\/repos\/o\/r\/issues$/,
    reply: (_m, _b, url) => { const page = Number(url.searchParams.get("page") ?? "1"); return { body: pages[page - 1] ?? [], headers: pageLink(url, page, pages.length) }; },
  });
  const total = (n: number): Route => ({ method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: n } } } } }) });
  it("paginates fully, drops pull requests, and attaches label events", async () => {
    const { c, gh } = client([issuesRoute([[issue(1), { ...issue(2), pull_request: { url: "x" } }], [issue(3)]]), total(2), timeline(1), timeline(3)]);
    const list = await c.listOpenIssues();
    expect(list.map((i) => i.number)).toEqual([1, 3]);
    expect(list[0]).toMatchObject({ author: "panelator-pipeline[bot]", labels: ["validated"], createdAt: "2026-10-01T00:00:00Z" });
    expect(list[0].labelEvents).toEqual([
      { label: "validated", actor: "adam26davidson", action: "labeled", at: "2026-10-01T01:00:00Z" },
      { label: "validated", actor: "adam26davidson", action: "unlabeled", at: "2026-10-01T03:00:00Z" },
      { label: "validated", actor: "panelator-pipeline[bot]", action: "labeled", at: "2026-10-01T04:00:00Z" },
    ]);
    expect(gh.calls.filter((x) => x.url.startsWith("/repos/o/r/issues?"))).toHaveLength(2);
  });
  it("throws when the count still disagrees after re-listing (review focus 1, spec 014 AC-7)", async () => {
    const gh = mockGitHub([issuesRoute([[issue(1)]]), total(5), timeline(1)]);
    const c = new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [0, 0, 0] });
    await expect(c.listOpenIssues()).rejects.toThrow(/incomplete: got 1, server reports 5/);
    expect(gh.calls.filter((x) => x.url === "/graphql")).toHaveLength(4);
  });
  it("re-lists after a short listing right after the scheduler's own write (spec 014 AC-7, #26)", async () => {
    let listings = 0;
    const lagging: Route = { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: listings++ === 0 ? [issue(1)] : [issue(1), issue(2)], headers: pageLink(url, 1, 1) }) };
    const gh = mockGitHub([lagging, total(2), timeline(1), timeline(2)]);
    const waits: number[] = [];
    const c = new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [5, 7, 9], sleep: async (ms) => { waits.push(ms); } });
    expect((await c.listOpenIssues()).map((i) => i.number)).toEqual([1, 2]);
    expect(waits).toEqual([5]);
  });
});

describe("labels, comments, activity", () => {
  it("adds and removes labels, tolerating a 404 on remove, and comments", async () => {
    const { c, gh } = client([
      { method: "POST", path: /^\/repos\/o\/r\/issues\/4\/labels$/, reply: () => ({ body: [] }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/issues\/4\/labels\/in-progress$/, reply: () => ({ status: 404, body: { message: "Label does not exist" } }) },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/4\/comments$/, reply: () => ({ status: 201, body: { id: 1 } }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/4$/, reply: () => ({ body: issue(4, ["validated", "in-progress"]) }) },
    ]);
    await c.addLabels(4, ["needs-spec"]);
    await c.removeLabel(4, "in-progress");
    await c.comment(4, "hello");
    expect(await c.issueLabels(4)).toEqual(["validated", "in-progress"]);
    expect(await c.issueActivityAt(4)).toBe("2026-10-02T00:00:00Z");
    expect(gh.calls.find((x) => x.method === "POST" && x.url.endsWith("/labels"))?.body).toEqual({ labels: ["needs-spec"] });
    expect(gh.calls.find((x) => x.url.endsWith("/comments"))?.body).toEqual({ body: "hello" });
  });
});

describe("pull requests, checks, merge (AC-14)", () => {
  const pr = { number: 9, base: { ref: "main" }, head: { ref: "issue-12", sha: "a".repeat(40) }, html_url: "https://github.com/o/r/pull/9", mergeable: true, mergeable_state: "clean", merged: false, state: "open" };
  const runs = (list: unknown[]): Route => ({ method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: list.length, check_runs: list } }) });
  it("summarises check runs as green, failed or pending, honouring the required list", async () => {
    const { c } = client([runs([
      { id: 1, name: "test", status: "completed", conclusion: "success" },
      { id: 2, name: "lint", status: "completed", conclusion: "failure" },
      { id: 3, name: "deploy", status: "in_progress", conclusion: null },
    ])]);
    expect((await c.checks("a".repeat(40), ["test"])).status).toBe("green");
    expect((await c.checks("a".repeat(40), ["test", "lint"]))).toMatchObject({ status: "failed", failed: [{ name: "lint", id: 2 }] });
    expect((await c.checks("a".repeat(40), [])).status).toBe("failed");
    expect((await c.checks("a".repeat(40), ["deploy"])).status).toBe("pending");
  });
  it("treats a required check that has not been reported yet as pending", async () => {
    const { c } = client([runs([])]);
    expect((await c.checks("a".repeat(40), ["test"])).status).toBe("pending");
  });
  it("paginates check runs fully, finding a required check on page 2", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ id: i + 10, name: `other-${i}`, status: "completed", conclusion: "success" })),
      [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    ];
    const { c, gh } = client([{
      method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/,
      reply: (_m, _b, url) => { const page = Number(url.searchParams.get("page") ?? "1"); return { body: { total_count: 101, check_runs: pages[page - 1] ?? [] }, headers: pageLink(url, page, pages.length) }; },
    }]);
    const summary = await c.checks("a".repeat(40), ["test"]);
    expect(summary.status).toBe("green");
    expect(summary.runs).toHaveLength(101);
    expect(gh.calls.filter((x) => x.url.includes("/check-runs"))).toHaveLength(2);
  });
  it("throws when the check runs disagree with the server total", async () => {
    const { c } = client([{ method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 3, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) }]);
    await expect(c.checks("a".repeat(40), ["test"])).rejects.toThrow(/check runs incomplete: got 1, server reports 3/);
  });
  it("reads a PR and squash-merges with the sha guard", async () => {
    const { c, gh } = client([
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: pr }) },
      { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "Pull Request successfully merged", sha: "m" } }) },
    ]);
    expect(await c.pullRequest(9)).toEqual({ number: 9, head_sha: "a".repeat(40), base_ref: "main", head_ref: "issue-12", url: pr.html_url, body: "", mergeable: true, mergeable_state: "clean", merged: false, state: "open" });
    expect(await c.mergePullRequest(9, "a".repeat(40))).toEqual({ merged: true, message: "Pull Request successfully merged" });
    expect(gh.calls.find((x) => x.method === "PUT")?.body).toEqual({ merge_method: "squash", sha: "a".repeat(40) });
  });
  it("returns merged:false with the message on a 405", async () => {
    const { c } = client([{ method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ status: 405, body: { message: "Pull Request is not mergeable" } }) }]);
    expect(await c.mergePullRequest(9, "a".repeat(40))).toEqual({ merged: false, message: "Pull Request is not mergeable" });
  });
  it("fetches the tail of a job log", async () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const gh = mockGitHub([]);
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/actions/jobs/2/logs")) return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
      return gh.fetch(input, init);
    }) as typeof fetch;
    const c = new GitHubClient(new Octokit({ auth: "x", request: { fetch: fetchFn } }), "o/r");
    const excerpt = await c.jobLogExcerpt(2, 50);
    expect(excerpt.split("\n")).toHaveLength(50);
    expect(excerpt.endsWith("line 299")).toBe(true);
  });
  it("decodes a binary (octet-stream) job log before taking the tail", async () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const gh = mockGitHub([]);
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/actions/jobs/2/logs")) return new Response(new TextEncoder().encode(text), { status: 200, headers: { "content-type": "application/octet-stream" } });
      return gh.fetch(input, init);
    }) as typeof fetch;
    const c = new GitHubClient(new Octokit({ auth: "x", request: { fetch: fetchFn } }), "o/r");
    const excerpt = await c.jobLogExcerpt(2, 50);
    expect(excerpt.split("\n")).toHaveLength(50);
    expect(excerpt.endsWith("line 299")).toBe(true);
  });
});

describe("spec 006 calls", () => {
  const cm = (id: number, login: string, body: string) => ({ id, user: { login }, created_at: "2026-10-20T00:00:00Z", body });
  it("comment returns the id and created_at", async () => {
    const { c } = client([{ method: "POST", path: /^\/repos\/o\/r\/issues\/4\/comments$/, reply: () => ({ status: 201, body: { id: 55, created_at: "2026-10-20T00:00:00Z" } }) }]);
    expect(await c.comment(4, "hi")).toEqual({ id: 55, created_at: "2026-10-20T00:00:00Z" });
  });
  it("listComments follows pages and maps fields", async () => {
    const pages = [[cm(1, "a", "one")], [cm(2, "b", "two")]];
    const { c, gh } = client([{
      method: "GET", path: /^\/repos\/o\/r\/issues\/4\/comments$/,
      reply: (_m, _b, url) => { const page = Number(url.searchParams.get("page") ?? "1"); return { body: pages[page - 1], headers: pageLink(url, page, 2) }; },
    }]);
    expect(await c.listComments(4)).toEqual([
      { id: 1, author: "a", at: "2026-10-20T00:00:00Z", body: "one" },
      { id: 2, author: "b", at: "2026-10-20T00:00:00Z", body: "two" },
    ]);
    expect(gh.calls[0].url).toContain("per_page=100");
  });
  it("issueComment maps a comment and returns null on 404", async () => {
    const { c } = client([
      { method: "GET", path: /^\/repos\/o\/r\/issues\/comments\/7$/, reply: () => ({ body: cm(7, "a", "x") }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/comments\/8$/, reply: () => ({ status: 404, body: { message: "Not Found" } }) },
    ]);
    expect(await c.issueComment(7)).toEqual({ id: 7, author: "a", at: "2026-10-20T00:00:00Z", body: "x" });
    expect(await c.issueComment(8)).toBeNull();
  });
  it("closes a PR, sets an issue body, and deletes a branch tolerating 404 and 422", async () => {
    const { c, gh } = client([
      { method: "PATCH", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: {} }) },
      { method: "PATCH", path: /^\/repos\/o\/r\/issues\/4$/, reply: () => ({ body: {} }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/spec-4$/, reply: () => ({ status: 204, body: null }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/gone$/, reply: () => ({ status: 422, body: { message: "Reference does not exist" } }) },
      { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/missing$/, reply: () => ({ status: 404, body: { message: "Not Found" } }) },
    ]);
    await c.closePullRequest(9);
    await c.setIssueBody(4, "new body");
    await c.deleteBranch("spec-4");
    await c.deleteBranch("gone");
    await c.deleteBranch("missing");
    expect(gh.unmatched).toEqual([]);
    expect(gh.calls.filter((x) => x.method === "DELETE").map((x) => x.url)).toContain("/repos/o/r/git/refs/heads/spec-4");
    expect(gh.calls.find((x) => x.url.endsWith("/pulls/9"))).toMatchObject({ method: "PATCH", body: { state: "closed" } });
    expect(gh.calls.find((x) => x.url.endsWith("/issues/4"))).toMatchObject({ method: "PATCH", body: { body: "new body" } });
  });
  it("lists the open PRs whose head is a branch of this repository (final review T2)", async () => {
    const { c, gh } = client([
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: [{ number: 9 }, { number: 12 }] }) },
    ]);
    expect(await c.openPullRequestsFrom("issue-7")).toEqual([9, 12]);
    const url = new URL(`https://x${gh.calls[0].url}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ head: "o:issue-7", state: "open" });
  });
  it("rerequestCheckRun is true when accepted and false on a 4xx", async () => {
    const { c, gh } = client([
      { method: "POST", path: /^\/repos\/o\/r\/check-runs\/1\/rerequest$/, reply: () => ({ status: 201, body: {} }) },
      { method: "POST", path: /^\/repos\/o\/r\/check-runs\/2\/rerequest$/, reply: () => ({ status: 422, body: { message: "no" } }) },
    ]);
    expect(await c.rerequestCheckRun(1)).toBe(true);
    expect(await c.rerequestCheckRun(2)).toBe(false);
    expect(gh.calls[0].method).toBe("POST");
  });
  it("rerequestCheckRun is false only for 404, 409 and 422, and rethrows any other error", async () => {
    const at = (id: number, status: number): Route => ({ method: "POST", path: new RegExp(`^/repos/o/r/check-runs/${id}/rerequest$`), reply: () => ({ status, body: { message: "x" } }) });
    const { c } = client([at(4, 404), at(9, 409), at(22, 422), at(3, 403), at(1, 401)]);
    expect(await c.rerequestCheckRun(4)).toBe(false);
    expect(await c.rerequestCheckRun(9)).toBe(false);
    expect(await c.rerequestCheckRun(22)).toBe(false);
    await expect(c.rerequestCheckRun(3)).rejects.toMatchObject({ status: 403 });
    await expect(c.rerequestCheckRun(1)).rejects.toMatchObject({ status: 401 });
  }, 20_000); // octokit spaces write requests about a second apart
  it("pullRequest maps the body", async () => {
    const pr = { number: 9, base: { ref: "main" }, head: { ref: "issue-12", sha: "a".repeat(40) }, html_url: "u", body: "Closes #12", mergeable: true, mergeable_state: "clean", merged: false, state: "open" };
    const { c } = client([{ method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: pr }) }]);
    expect((await c.pullRequest(9)).body).toBe("Closes #12");
  });
});
