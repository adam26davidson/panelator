import { mkdtemp } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { neutraliseMarkers } from "../src/github/markers.ts";
import { fileDesignChildren } from "../src/children/scan.ts";
import { childMarker } from "../src/children/markers.ts";
import { formatQuestion } from "../src/chain/question.ts";
import { applyFilerResult } from "../src/filer/apply.ts";
import type { FilerDeps, FilerInput } from "../src/filer/input.ts";
import type { GitHubClient } from "../src/github/client.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

const FAMILIES = [
  "panelator-finding", "panelator-security-finding", "panelator-capability", "panelator-capability-closed", "panelator-child",
  "panelator-child-blocked", "panelator-child-unblocked", "panelator-blocked-by", "panelator-unblocked-by", "panelator-blocked-until",
  "panelator-question", "panelator-telegram-answer", "panelator-reflection",
];
const ALL = FAMILIES.map((f) => `<!-- ${f}:docs/designs/x.md:a -->`).join("\n");
const OPEN = /<!--\s*panelator-/gi;
const matches = (text: string) => text.match(OPEN) ?? [];

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
    removeLabel: vi.fn(async () => {}), closeIssue: vi.fn(async () => {}), addLabels: vi.fn(async () => {}),
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
});

describe("the children scan (spec 076 AC-2, AC-3)", () => {
  const BOT = "bot";
  const D = "docs/designs/x.md";
  const designs = (brief: string) => new Map([[D, `Parent: docs/charter.md\n## Children\n- planned: a\n  title: Title\n  brief: ${brief}\n`]]);
  function fake(issues: Record<string, unknown>[] = []) {
    const list = [...issues] as never[] as { number: number; title: string; author: string; body: string; labels: string[] }[];
    const comments: Record<number, string[]> = {};
    const gh = {
      listIssues: async () => list.map((i) => ({ ...i, labelEvents: [], createdAt: "", state: "open" })) as never,
      createIssue: async (title: string, body: string, labels: string[]) => { const n = 100 + list.length; list.push({ number: n, title, author: BOT, body, labels }); return n; },
      addLabels: async () => {}, removeLabel: async () => {},
      comment: async (n: number, b: string) => { (comments[n] ??= []).push(b); },
      listComments: async (n: number) => (comments[n] ?? []).map((body, i) => ({ id: i, author: BOT, at: "", body })),
    };
    return { gh, list, comments };
  }
  const scan = async (gh: unknown, brief: string) => {
    const paths = statePaths(mkdtempSync(join(tmpdir(), "markers-scan-")));
    await ensureStateDirs(paths);
    return fileDesignChildren({ gh: gh as never, paths, botLogin: BOT, now: () => new Date("2026-11-05T00:00:00Z"), log: () => {}, designs: designs(brief) });
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
