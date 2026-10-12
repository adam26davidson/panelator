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
  it("throws when the count disagrees with the server total (review focus 1)", async () => {
    const { c } = client([issuesRoute([[issue(1)]]), total(5), timeline(1)]);
    await expect(c.listOpenIssues()).rejects.toThrow(/incomplete: got 1, server reports 5/);
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
  const pr = { number: 9, head: { sha: "a".repeat(40) }, html_url: "https://github.com/o/r/pull/9", mergeable: true, mergeable_state: "clean", merged: false, state: "open" };
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
    expect(await c.pullRequest(9)).toEqual({ number: 9, head_sha: "a".repeat(40), url: pr.html_url, mergeable: true, mergeable_state: "clean", merged: false, state: "open" });
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
