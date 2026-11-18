import { mkdtemp } from "node:fs/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { neutraliseMarkers } from "../src/github/markers.ts";
import { fileDesignChildren } from "../src/children/scan.ts";
import { blockedMarker, childMarker, unblockedMarker } from "../src/children/markers.ts";
import { formatQuestion } from "../src/chain/question.ts";
import { applyActions, type DriverDeps } from "../src/chain/driver.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { GitHubClient } from "../src/github/client.ts";
import { Octokit } from "octokit";
import { mockGitHub } from "./helpers/mock-github.ts";
import { applyFilerResult } from "../src/filer/apply.ts";
import type { FilerDeps, FilerInput } from "../src/filer/input.ts";
import { ALL, matches } from "./helpers/markers.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

describe("neutraliseMarkers (spec 076 AC-1)", () => {
  it.each([
    "<!-- panelator-child-panelator-child:docs/designs/x.md:a -->",
    "<!--panelator-panelator-finding:r:3 -->",
    "<!-- PANELATOR-\npanelator-capability:security-advisories -->",
    "<!--   panelator-child:d:a -->",
    "<!--\npanelator-child:d:a -->",
    "<!-- PaNeLaToR-question:n -->",
  ])("leaves no marker in %j", (input) => {
    const out = neutraliseMarkers(input);
    expect(matches(out)).toEqual([]);
    expect(out).not.toContain("<!-- panelator-");
  });
  it("returns text without a marker unchanged", () => {
    expect(neutraliseMarkers("plain <!-- other --> text")).toBe("plain <!-- other --> text");
  });
  it("neutralises every family", () => expect(matches(neutraliseMarkers(ALL))).toEqual([]));
});

async function filerSetup(comments: unknown[] = [], open: unknown[] = []) {
  const paths = statePaths(await mkdtemp(join(tmpdir(), "markers-")));
  await ensureStateDirs(paths);
  const gh = {
    listIssues: vi.fn(async () => [] as unknown[]), listOpenIssuesByLabel: vi.fn(async () => []), listOpenIssuesByAuthor: vi.fn(async () => open),
    searchOpenIssuesByMarker: vi.fn(async () => []), listComments: vi.fn(async () => comments),
    createIssue: vi.fn(async (_t: string, _b: string, _l: string[]) => 42), comment: vi.fn(async (_n: number, _b: string) => ({ id: 1 })),
    removeLabel: vi.fn(async () => {}), closeIssue: vi.fn(async (_n: number, _c: string) => {}), addLabels: vi.fn(async () => {}),
    findDraftSecurityAdvisory: vi.fn(async (): Promise<string | null> => null), createDraftSecurityAdvisory: vi.fn(async (_a: unknown) => "GHSA-x"),
  };
  const d: FilerDeps = { paths, gh: gh as unknown as GitHubClient, botLogin: "bot", classes: ["class:bug"], stopsPipelineLabel: "stops-pipeline", notify: async () => {}, now: () => new Date("2026-10-27T00:00:00Z") };
  const finding = { what: "bug", where: "f.ts", evidence: "e", noticed_how: "t" };
  const input = (ref = "1", f: Record<string, unknown> = finding): FilerInput => ({ records: [{ ref, finding: f as never }], abandoned: [], open_issues: [], cursor: 0, issue_classes: ["class:bug"], stops_pipeline_label: "stops-pipeline" });
  return { gh, d, input };
}

describe("every writer neutralises everything but its own marker (spec 076 AC-2)", () => {
  it("filer: issue title and body, with the verification reason", async () => {
    const { gh, d, input } = await filerSetup();
    await applyFilerResult(d, "run", input(), { summary: "s", decisions: [{ ref: "1", outcome: "file", reason: ALL, issue: { title: ALL, body: ALL, class: "class:bug" } }] });
    const [title, body] = gh.createIssue.mock.calls[0]!;
    expect(matches(title)).toEqual([]);
    expect(matches(body)).toHaveLength(1);
    expect(body.endsWith("<!-- panelator-finding:run:1 -->")).toBe(true);
  });
  it("filer: merge_into comment", async () => {
    const { gh, d, input } = await filerSetup([], [{ number: 4 }]);
    await applyFilerResult(d, "run", input(), { summary: "s", decisions: [{ ref: "1", outcome: "merge_into", reason: ALL, issue_number: 4 }] });
    const body = gh.comment.mock.calls[0]![1];
    expect(matches(body)).toHaveLength(1);
    expect(body.endsWith("<!-- panelator-finding:run:1 -->")).toBe(true);
  });
  const decide = async (decision: Record<string, unknown>, abandoned = false) => {
    const f = await filerSetup([], [{ number: 4, labels: [] }]);
    const inp = f.input(abandoned ? "issue:7" : "1");
    if (abandoned) { inp.records = []; inp.abandoned = [{ ref: "issue:7", issue: { number: 7, title: "Old", body: "old", labels: [] } as never, comments: [], ledgers: [], retries: 0 }]; }
    await applyFilerResult(f.d, "run", inp, { summary: "s", decisions: [{ ref: abandoned ? "issue:7" : "1", ...decision }] as never });
    return f.gh;
  };
  const issue = { title: ALL, body: ALL, class: "class:bug" };
  it("filer: retry comment", async () => {
    const gh = await decide({ outcome: "retry", reason: ALL }, true);
    const body = gh.comment.mock.calls[0]![1];
    expect(matches(body)).toHaveLength(1);
    expect(body.endsWith("<!-- panelator-finding:run:issue:7 -->")).toBe(true);
  });
  it("filer: close comment", async () => {
    const gh = await decide({ outcome: "close", reason: ALL }, true);
    expect(matches(gh.closeIssue.mock.calls[0]![1])).toEqual([]);
  });
  it("filer: rewrite's closing comment and its replacement issue", async () => {
    const gh = await decide({ outcome: "rewrite", reason: ALL, issue }, true);
    expect(matches(gh.closeIssue.mock.calls[0]![1])).toEqual([]);
    expect(matches(gh.createIssue.mock.calls[0]![0])).toEqual([]);
    expect(matches(gh.createIssue.mock.calls[0]![1])).toHaveLength(1);
  });
  it("filer: the blocked_until condition", async () => {
    const gh = await decide({ outcome: "file", reason: "r", issue: { ...issue, blocked_until: ALL } });
    const cond = gh.comment.mock.calls.map((c) => c[1]).find((b) => b.includes("Blocked until"))!;
    expect(matches(cond)).toHaveLength(1);
    expect(cond.trimEnd().endsWith("<!-- panelator-blocked-until -->")).toBe(true);
  });
  it("filer: security advisory title and description", async () => {
    const { gh, d, input } = await filerSetup();
    await applyFilerResult(d, "run", input("1", { what: "b", where: "f", evidence: "e", noticed_how: "t", security: true }), { summary: "s", decisions: [{ ref: "1", outcome: "security", reason: "r", advisory: { title: ALL, description: ALL, severity: "high" } }] });
    const adv = gh.createDraftSecurityAdvisory.mock.calls[0]![0] as { title: string; description: string };
    expect(matches(adv.title)).toEqual([]);
    expect(matches(adv.description)).toHaveLength(1);
    expect(adv.description.endsWith("<!-- panelator-security-finding:1 -->")).toBe(true);
  });
  it("question comment", () => {
    const q = { kind: "technical" as const, question: ALL, options: [{ label: ALL, cost: ALL }], recommendation: ALL };
    const text = formatQuestion(q, "maint", "nonce1");
    expect(matches(text)).toHaveLength(1);
    expect(text.trimEnd().endsWith("-->")).toBe(true);
    expect(text).toContain("panelator-question");
  });

  describe("the chain driver's comments (item 3)", () => {
    async function drive(actions: unknown[], stage = "fix") {
      const root = mkdtempSync(join(tmpdir(), "markers-drv-"));
      const paths = statePaths(root);
      await ensureStateDirs(paths);
      const gh = mockGitHub([{ method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: { id: 1, created_at: "2026-10-20T10:00:00Z" } }) }, { method: "PATCH", path: /^\/repos\/o\/r\/(issues|pulls)\/\d+$/, reply: () => ({ body: {} }) }, { method: "DELETE", path: /^\/repos\/o\/r\/git\/refs\/heads\/.+$/, reply: () => ({ body: {} }) }]);
      const deps = { paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"), now: () => new Date("2026-10-20T10:00:00Z"), log: () => {}, cfg: { repo: "o/r" } } as unknown as DriverDeps;
      mkdirSync(paths.runs, { recursive: true });
      writeFileSync(join(paths.runs, "7-fix-1-20261020T100000"), "");
      const claim = { issue: 7, state: { ...initialChainState(7), stage }, worktree: root, started_at: "", last_activity_at: "", run_id: null };
      await applyActions(deps, claim as never, actions as never);
      return gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).map((c) => (c.body as { body: string }).body);
    }
    it("comment action, with the run record list of an abandoned issue", async () => {
      for (const stage of ["fix", "abandoned"]) {
        const posted = await drive([{ type: "comment", text: ALL }], stage);
        expect(posted).toHaveLength(1);
        expect(matches(posted[0]!)).toEqual([]);
      }
    });
    it("close_pr comment", async () => {
      const posted = await drive([{ type: "close_pr", pr: 9, branch: "issue-7", comment: ALL }]);
      expect(posted).toHaveLength(1);
      expect(matches(posted[0]!)).toEqual([]);
    });
    it("close_issue comment", async () => {
      const posted = await drive([{ type: "close_issue", comment: ALL }]);
      expect(posted).toHaveLength(1);
      expect(matches(posted[0]!)).toEqual([]);
    });
  });
});

describe("the children scan (spec 076 AC-2, AC-3)", () => {
  const BOT = "bot";
  const D = "docs/designs/x.md";
  const designs = (brief: string) => new Map([[D, `Parent: docs/charter.md\n## Children\n- planned: a\n  title: Title\n  brief: ${brief}\n`]]);
  function fake(issues: Record<string, unknown>[] = [], seed: Record<number, string[]> = {}) {
    const list = [...issues] as never[] as { number: number; title: string; author: string; body: string; labels: string[]; state?: string }[];
    const comments: Record<number, string[]> = { ...seed };
    const removed: [number, string][] = [];
    const gh = {
      listIssues: async () => list.map((i) => ({ labelEvents: [], createdAt: "", state: "open", ...i })) as never,
      createIssue: async (title: string, body: string, labels: string[]) => { const n = 100 + list.length; list.push({ number: n, title, author: BOT, body, labels }); return n; },
      addLabels: async () => {}, removeLabel: async (n: number, l: string) => { removed.push([n, l]); },
      comment: async (n: number, b: string) => { (comments[n] ??= []).push(b); },
      listComments: async (n: number) => (comments[n] ?? []).map((body, i) => ({ id: i, author: BOT, at: "", body })),
    };
    return { gh, list, comments, removed };
  }
  const scan = async (gh: unknown, brief: string, text = designs(brief)) => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "markers-scan-")));
    await ensureStateDirs(paths);
    return fileDesignChildren({ gh: gh as never, paths, botLogin: BOT, now: () => new Date("2026-11-05T00:00:00Z"), log: () => {}, designs: text });
  };
  it("a brief carrying every family leaves only the child marker", async () => {
    const { gh, list } = fake();
    await scan(gh, ALL.replace(/\n/g, " "));
    expect(matches(list[0]!.body)).toHaveLength(1);
    expect(list[0]!.body.endsWith(childMarker(D, "a"))).toBe(true);
  });
  it("a brief quoting a finding marker does not satisfy the filer's lookup", async () => {
    const { gh, list } = fake();
    await scan(gh, "<!-- panelator-finding:r1:7 -->");
    const f = await filerSetup([], [list[0]!]);
    f.gh.listOpenIssuesByAuthor.mockResolvedValue([{ ...list[0]!, author: "bot", labels: [] }] as never);
    await applyFilerResult(f.d, "run", f.input("7"), { summary: "s", decisions: [{ ref: "7", outcome: "file", reason: "r", issue: { title: "T", body: "B", class: "class:bug" } }] });
    expect(f.gh.createIssue).toHaveBeenCalledTimes(1);
  });
  it("a filed finding quoting a child marker is not the child's record", async () => {
    const f = await filerSetup();
    await applyFilerResult(f.d, "run", f.input(), { summary: "s", decisions: [{ ref: "1", outcome: "file", reason: "r", issue: { title: "T", body: childMarker(D, "a"), class: "class:bug" } }] });
    const filed = { number: 42, title: "T", author: BOT, body: f.gh.createIssue.mock.calls[0]![1], labels: [] };
    const { gh, list } = fake([filed]);
    const r = await scan(gh, "Brief.");
    expect(r.filed).toHaveLength(1);
    expect(list[1]!.body).toContain(childMarker(D, "a"));
  });
  it("the title and the blocked and unblocked comments carry no foreign marker", async () => {
    const refs = ALL.replace(/\n/g, ",");
    const text = new Map([[D, `Parent: docs/charter.md\n## Children\n- planned: one\n  title: One\n  brief: B.\n- planned: two\n  title: ${ALL.replace(/\n/g, " ")}\n  brief: B.\n  after: one,${refs}\n`]]);
    const { gh, list, comments } = fake();
    await scan(gh, "", text);
    const two = list.find((i) => i.body.includes(childMarker(D, "two")))!;
    expect(matches(two.title)).toEqual([]);
    const blocked = comments[two.number]!;
    expect(blocked).toHaveLength(1);
    expect(matches(blocked[0]!)).toHaveLength(1);
    expect(blocked[0]!.endsWith(blockedMarker(D, "two"))).toBe(true);
    list.find((i) => i.number === 100)!.state = "closed";
    expect((await scan(gh, "", text)).unblocked).toEqual([two.number]);
    const unblocked = comments[two.number]![1]!;
    expect(matches(unblocked)).toHaveLength(1);
    expect(unblocked.endsWith(unblockedMarker(D, "two"))).toBe(true);
  });
  it("a filed finding quoting a child marker keeps the filer's block, which the scan lifts (spec 066 AC-7)", async () => {
    const f = await filerSetup();
    f.gh.listIssues.mockResolvedValue([{ number: 50, title: "dep", author: "bot", body: "", labels: [], state: "open", labelEvents: [], createdAt: "" }]);
    await applyFilerResult(f.d, "run", f.input(), { summary: "s", decisions: [{ ref: "1", outcome: "file", reason: "r", issue: { title: "T", body: childMarker(D, "a"), class: "class:bug", blocked_by: [50] } }] });
    const body = f.gh.createIssue.mock.calls[0]![1];
    expect(body).not.toContain("<!-- panelator-child:");
    const filed = { number: 42, title: "T", author: BOT, body, labels: ["class:bug", "validated", "blocked"], state: "open" };
    const dep = { number: 50, title: "dep", author: BOT, body: "", labels: [], state: "closed" };
    const { gh, list, removed, comments } = fake([filed, dep], { 42: f.gh.comment.mock.calls.map((c) => c[1]) });
    const r = await scan(gh, "Brief.");
    expect(r.filed).toHaveLength(1);
    expect(list[2]!.body).toContain(childMarker(D, "a"));
    expect(r.unblocked).toEqual([42]);
    expect(removed).toContainEqual([42, "blocked"]);
    expect(comments[42]!.at(-1)).toContain("<!-- panelator-unblocked-by:50 -->");
  });
});

describe("the merge_into guard matches the whole marker on the App's comment (spec 076 AC-4)", () => {
  const run = async (comments: { id: number; author: string; at: string; body: string }[]) => {
    const f = await filerSetup(comments, [{ number: 4 }]);
    await applyFilerResult(f.d, "run", f.input("12"), { summary: "s", decisions: [{ ref: "12", outcome: "merge_into", reason: "same", issue_number: 4 }] });
    return f.gh.comment.mock.calls.length;
  };
  it("appends past a human's comment with the full marker", async () => expect(await run([{ id: 1, author: "human", at: "", body: "<!-- panelator-finding:r:12 -->" }])).toBe(1));
  it("appends past an App comment with a neutralised marker", async () => expect(await run([{ id: 1, author: "bot", at: "", body: "<!-- child:d:12 -->" }])).toBe(1));
  it("posts nothing when the App's real marker is there", async () => expect(await run([{ id: 1, author: "bot", at: "", body: "x\n<!-- panelator-finding:old:12 -->" }])).toBe(0));
});
