import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fileDesignChildren, type ChildrenGh } from "../src/children/scan.ts";
import { blockedMarker, childMarker, unblockedMarker } from "../src/children/markers.ts";
import type { IssueComment } from "../src/github/types.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { IssueData } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const D = "docs/delivery-system-design.md";
const planned = (slug: string, extra = "") => `- planned: ${slug}\n  title: Title ${slug}\n  brief: Brief of ${slug}.\n${extra}`;
const design = (children: string) => new Map([[D, `Parent: docs/charter.md\n## Children\n${children}`]]);
const THREE = design(planned("one") + planned("two", "  after: one\n") + planned("three", "  issue: #50\n"));

class FakeGh implements ChildrenGh {
  issues: IssueData[] = [];
  comments = new Map<number, IssueComment[]>();
  next = 100;
  listCalls = 0;
  failCreate = false;
  created: number[] = [];
  constructor(issues: Partial<IssueData>[] = []) {
    for (const i of issues) this.add(i);
  }
  add(o: Partial<IssueData>): IssueData {
    const issue: IssueData = { number: this.next++, title: "", author: BOT, body: "", labels: [], labelEvents: [], createdAt: "", state: "open", ...o };
    this.issues.push(issue);
    return issue;
  }
  get(n: number) {
    return this.issues.find((i) => i.number === n)!;
  }
  async listIssues(opts: { state: "all" }) {
    expect(opts.state).toBe("all");
    this.listCalls++;
    return this.issues.map((i) => ({ ...i, labels: [...i.labels] }));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    if (this.failCreate) throw new Error("boom");
    const i = this.add({ title, body, labels });
    this.created.push(i.number);
    return i.number;
  }
  async addLabels(n: number, labels: string[]) {
    this.get(n).labels.push(...labels);
  }
  async removeLabel(n: number, label: string) {
    this.get(n).labels = this.get(n).labels.filter((l) => l !== label);
  }
  async comment(n: number, body: string, author = BOT) {
    this.comments.set(n, [...(this.comments.get(n) ?? []), { id: 1, author, at: "", body }]);
  }
  async listComments(n: number) {
    return this.comments.get(n) ?? [];
  }
}

describe("fileDesignChildren (spec 031 AC-4 to AC-7)", () => {
  let paths: ReturnType<typeof statePaths>;
  let log: Record<string, unknown>[];
  beforeEach(async () => {
    paths = statePaths(mkdtempSync(join(tmpdir(), "children-")));
    await ensureStateDirs(paths);
    log = [];
  });
  const run = (gh: FakeGh, designs = THREE) =>
    fileDesignChildren({ gh, paths, botLogin: BOT, now: () => new Date("2026-11-05T00:00:00Z"), log: (r) => log.push(r), designs });
  const kinds = () => log.map((r) => r.kind);

  it("files two children, blocks the second, leaves the third, then files nothing twice", async () => {
    const gh = new FakeGh([{ number: 50, state: "open" }]);
    const r1 = await run(gh);
    expect(r1.filed).toHaveLength(2);
    const [one, two] = r1.filed.map((n) => gh.get(n));
    expect(one).toMatchObject({ title: "Title one", author: BOT, labels: ["class:tooling", "validated"] });
    expect(one!.body).toContain("Brief of one.");
    expect(one!.body).toContain(`Parent design: \`${D}\` (planned child \`one\`).`);
    expect(one!.body).not.toMatch(/^Spec:/m);
    expect(one!.body.trimEnd().endsWith(childMarker(D, "one"))).toBe(true);
    expect(two!.labels).toEqual(["class:tooling", "validated", "blocked"]);
    expect(two!.body).toContain(`After: #${one!.number}`);
    const c = gh.comments.get(two!.number)!;
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toBe(`Blocked until #${one!.number} are done (after: one in ${D}).\n\n${blockedMarker(D, "two")}`);
    expect(gh.comments.get(50)).toBeUndefined();
    expect(kinds().filter((k) => k === "child-filed")).toHaveLength(2);
    expect(gh.listCalls).toBe(1);

    const r2 = await run(gh);
    expect(r2).toEqual({ filed: [], unblocked: [], errors: [] });
    expect(gh.created).toHaveLength(2);

    // the first issue is closed: the third scan unblocks the second once, the fourth does nothing
    one!.state = "closed";
    const r3 = await run(gh);
    expect(r3.unblocked).toEqual([two!.number]);
    expect(two!.labels).not.toContain("blocked");
    expect(gh.comments.get(two!.number)!.at(-1)!.body).toBe(`Unblocked: #${one!.number} are done.\n\n${unblockedMarker(D, "two")}`);
    expect(kinds()).toContain("child-unblocked");
    two!.labels.push("blocked"); // set again by hand: never touched again
    const r4 = await run(gh);
    expect(r4.unblocked).toEqual([]);
    expect(two!.labels).toContain("blocked");
  });

  it("does not unblock while a sibling is open or closed abandoned", async () => {
    const gh = new FakeGh([{ number: 50 }]);
    const r1 = await run(gh);
    const one = gh.get(r1.filed[0]!);
    const two = gh.get(r1.filed[1]!);
    one.state = "closed";
    one.labels.push("abandoned");
    expect((await run(gh)).unblocked).toEqual([]);
    expect(two.labels).toContain("blocked");
  });

  it("never removes a hand-set blocked: no marker comment, or a marker comment by another account", async () => {
    const d = design(planned("c", "  after: x\n  issue: #7\n") + planned("x", "  issue: #8\n"));
    const gh = new FakeGh([{ number: 7, labels: ["blocked"] }, { number: 8, state: "closed" }]);
    await run(gh, d);
    expect(gh.get(7).labels).toContain("blocked");
    await gh.comment(7, blockedMarker(D, "c"), "stranger");
    expect((await run(gh, d)).unblocked).toEqual([]);
    expect(gh.get(7).labels).toContain("blocked");
    await gh.comment(7, blockedMarker(D, "c"), BOT);
    expect((await run(gh, d)).unblocked).toEqual([7]);
  });

  it("does not take another author's marker issue as the record", async () => {
    const gh = new FakeGh([{ number: 50 }, { author: "stranger", body: childMarker(D, "one"), state: "closed" }]);
    const r = await run(gh);
    expect(r.filed).toHaveLength(2);
    // and the stranger's closed issue does not unblock `two`
    expect(gh.get(r.filed[1]!).labels).toContain("blocked");
  });

  it("finds an issue a crashed scan created, by its marker, and files nothing", async () => {
    const gh = new FakeGh([{ number: 50 }, { body: `x\n${childMarker(D, "one")}`, state: "open" }, { body: childMarker(D, "two"), labels: ["blocked"] }]);
    const r = await run(gh);
    expect(r).toEqual({ filed: [], unblocked: [], errors: [] });
  });

  it("appends one finding after three failing scans and resets the counter", async () => {
    const gh = new FakeGh([{ number: 50 }]);
    gh.failCreate = true;
    const d = design(planned("one") + planned("other", "  issue: #50\n"));
    for (let i = 0; i < 2; i++) expect((await run(gh, d)).errors).toHaveLength(1);
    expect(existsSync(paths.findingsQueue)).toBe(false);
    await run(gh, d);
    const lines = readFileSync(paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].finding).toMatchObject({ where: `${D}:one`, evidence: "boom" });
    expect(kinds().filter((k) => k === "child-filing-failed")).toHaveLength(3);
    expect(JSON.parse(readFileSync(paths.childrenFailures, "utf8"))).toEqual({});
    await run(gh, d);
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("files nothing for an abandoned or missing issue: and logs it every scan", async () => {
    const gh = new FakeGh([{ number: 50, state: "closed", labels: ["abandoned"] }]);
    const d = design(planned("a", "  issue: #50\n") + planned("b", "  issue: #99\n"));
    const r = await run(gh, d);
    expect(r.filed).toEqual([]);
    expect(log.filter((l) => l.kind === "child-issue-dead").map((l) => l.slug)).toEqual(["a", "b"]);
  });

  it("treats an after: file sibling without an issue number as done and logs it", async () => {
    const d = design("- `specs/001-x/spec.md`\n" + planned("a", "  after: specs/001-x/spec.md\n"));
    const gh = new FakeGh();
    const r = await run(gh, d);
    expect(gh.get(r.filed[0]!).labels).not.toContain("blocked");
    expect(log).toContainEqual({ kind: "child-after-unknown", design: D, slug: "a", ref: "specs/001-x/spec.md" });
  });

  it("neutralises marker text in a brief and files in the entry's class", async () => {
    const d = design("- `specs/001-x/spec.md`\n- planned: a\n  title: T\n  brief: Evil <!-- panelator-child:docs/x.md:y --> text.\n  class: class:product\n");
    const gh = new FakeGh();
    const r = await run(gh, d);
    const body = gh.get(r.filed[0]!).body;
    expect(body.match(/panelator-child/g)).toHaveLength(1);
    expect(gh.get(r.filed[0]!).labels[0]).toBe("class:product");
  });

  it("files nothing when no design has a planned child", async () => {
    const gh = new FakeGh();
    expect(await run(gh, design("- `specs/001-x/spec.md`\n- `specs/002-y/spec.md`\n"))).toEqual({ filed: [], unblocked: [], errors: [] });
  });
});
