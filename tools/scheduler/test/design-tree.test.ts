import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { checkDesignTree, designTreeReport, loadDesignTree } from "../src/gates/design-tree.ts";
import { childMarker } from "../src/children/markers.ts";
import type { IssueData } from "../src/types.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const tree = (o: Record<string, string>) => new Map(Object.entries(o));
const ok = {
  "docs/charter.md": "# Charter\n",
  "docs/delivery-system-design.md": "Parent: docs/charter.md\n## Children\n- `docs/designs/console.md`\n",
  "docs/product-spec.md": "Parent: docs/charter.md\n## Children\n",
  "docs/designs/console.md":
    "Parent: docs/delivery-system-design.md\n## Children\n- `specs/010-a/spec.md`\n- `specs/011-b/spec.md`\n",
  "specs/010-a/spec.md": "Parent: docs/designs/console.md\n",
  "specs/011-b/spec.md": "Parent: docs/designs/console.md\n",
};

describe("checkDesignTree", () => {
  it("accepts a valid tree", () => expect(checkDesignTree(tree(ok))).toEqual([]));

  it("flags a dangling parent", () => {
    const errs = checkDesignTree(tree({ ...ok, "specs/011-b/spec.md": "Parent: docs/designs/nope.md\n" }));
    expect(errs.join()).toMatch(/specs\/011-b\/spec.md.*docs\/designs\/nope.md/);
  });

  it("flags a file with no Parent", () => {
    const errs = checkDesignTree(tree({ ...ok, "specs/011-b/spec.md": "no parent\n" }));
    expect(errs.join()).toMatch(/specs\/011-b\/spec.md: no Parent/);
  });

  it("flags a child its parent does not list", () => {
    const errs = checkDesignTree(tree({ ...ok, "specs/012-c/spec.md": "Parent: docs/designs/console.md\n" }));
    expect(errs.join()).toMatch(/specs\/012-c\/spec.md.*not listed/);
  });

  it("flags a listed child that names another parent", () => {
    const errs = checkDesignTree(tree({ ...ok, "specs/011-b/spec.md": "Parent: docs/product-spec.md\n" }));
    expect(errs.join()).toMatch(/docs\/designs\/console.md.*specs\/011-b\/spec.md.*names/);
  });

  it("flags a listed child that does not exist", () => {
    const errs = checkDesignTree(
      tree({ ...ok, "docs/designs/console.md": ok["docs/designs/console.md"] + "- `specs/013-d/spec.md`\n" }),
    );
    expect(errs.join()).toMatch(/specs\/013-d\/spec.md.*does not exist/);
  });

  it("flags a sub-design with one child", () => {
    const errs = checkDesignTree(
      tree({ ...ok, "docs/designs/console.md": "Parent: docs/delivery-system-design.md\n## Children\n- `specs/010-a/spec.md`\n" }),
    );
    expect(errs.join()).toMatch(/docs\/designs\/console.md.*at least two/);
  });

  it("flags a cycle", () => {
    const errs = checkDesignTree(
      tree({
        ...ok,
        "docs/designs/a.md": "Parent: docs/designs/b.md\n## Children\n- `docs/designs/b.md`\n- `specs/010-a/spec.md`\n",
        "docs/designs/b.md": "Parent: docs/designs/a.md\n## Children\n- `docs/designs/a.md`\n- `specs/011-b/spec.md`\n",
      }),
    );
    expect(errs.join()).toMatch(/cycle/);
  });

  it("flags a Children section on the root", () => {
    const errs = checkDesignTree(tree({ ...ok, "docs/charter.md": "# Charter\n## Children\n- `docs/product-spec.md`\n" }));
    expect(errs.join()).toMatch(/docs\/charter.md.*Children/);
  });

  it("exempts top designs from the two-children rule", () => {
    const errs = checkDesignTree(tree(ok));
    expect(errs.filter((e) => e.includes("at least two"))).toEqual([]);
    expect(ok["docs/product-spec.md"]).toMatch(/## Children\n$/);
  });

  it("the repository's own tree is valid (AC-24, AC-25)", () => {
    expect(checkDesignTree(loadDesignTree(repoRoot), { classes: configuredClasses() })).toEqual([]);
  });
});

function configuredClasses(): string[] {
  const yaml = readFileSync(join(repoRoot, "agents", "scheduler.yaml"), "utf8");
  return [...yaml.matchAll(/^\s+(?:feature|debt)_classes:\s*\[(.*)\]/gm)].flatMap((m) => m[1]!.split(",").map((c) => c.trim()));
}

const planned = (slug: string, extra = "") => `- planned: ${slug}\n  title: T ${slug}\n  brief: Brief ${slug}.\n${extra}`;
const withDesign = (children: string) => {
  const { "specs/011-b/spec.md": _unlisted, ...rest } = ok;
  return tree({ ...rest, "docs/designs/console.md": `Parent: docs/delivery-system-design.md\n## Children\n${children}` });
};

describe("checkDesignTree: planned children (spec 031 AC-2)", () => {
  const classes = ["class:product", "class:tooling"];
  const check = (children: string) => checkDesignTree(withDesign(children), { classes });

  it("counts planned children toward the two-children rule", () => {
    const children = "- `specs/010-a/spec.md`\n" + planned("later");
    expect(check(children)).toEqual([]);
    expect(check(planned("only")).join()).toMatch(/docs\/designs\/console.md.*at least two/);
  });

  it("rejects a planned child missing title or brief", () => {
    const errs = check("- `specs/010-a/spec.md`\n- planned: x\n  brief: b\n- planned: y\n  title: t\n");
    expect(errs.join("\n")).toMatch(/console.md: planned child x: missing title:/);
    expect(errs.join("\n")).toMatch(/console.md: planned child y: missing brief:/);
  });

  it("rejects a slug that does not match the pattern", () => {
    expect(check("- `specs/010-a/spec.md`\n" + planned("Bad_Slug")).join()).toMatch(/Bad_Slug.*slug/);
  });

  it("rejects duplicate slugs and a slug equal to a file sibling's", () => {
    expect(check("- `specs/010-a/spec.md`\n" + planned("x") + planned("x")).join()).toMatch(/planned child x: another child has the same slug/);
    expect(check("- `specs/010-a/spec.md`\n" + planned("a")).join()).toMatch(/planned child a: a spec with this slug exists/);
  });

  it("rejects an after: that names no sibling, itself, or a cycle", () => {
    const base = "- `specs/010-a/spec.md`\n";
    expect(check(base + planned("x", "  after: ghost\n")).join()).toMatch(/planned child x: after: ghost names no sibling/);
    expect(check(base + planned("x", "  after: x\n")).join()).toMatch(/planned child x: after: names the entry itself/);
    expect(check(base + planned("x", "  after: y\n") + planned("y", "  after: x\n")).join()).toMatch(/after: forms a cycle/);
    expect(check(base + planned("x", "  after: specs/010-a/spec.md, y\n") + planned("y")).filter((e) => /after/.test(e))).toEqual([]);
  });

  it("rejects an unknown class and an issue: that is not #<n>", () => {
    const base = "- `specs/010-a/spec.md`\n";
    expect(check(base + planned("x", "  class: class:nope\n")).join()).toMatch(/planned child x: class class:nope/);
    expect(check(base + planned("x", "  issue: 12\n")).join()).toMatch(/planned child x: issue: 12 is not #<n>/);
  });
});

describe("designTreeReport (spec 031 AC-10)", () => {
  const bot = "app[bot]";
  const issue = (n: number, o: Partial<IssueData>): IssueData => ({
    number: n, title: "", author: bot, body: "", labels: [], labelEvents: [], createdAt: "", state: "open", ...o,
  });

  it("resolves a planned child by the bot-authored marker, not by another author's", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "report-"));
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "delivery-system-design.md"), "Parent: docs/charter.md\n## Children\n" + planned("a") + planned("b"));
    const issues = [
      issue(5, { body: childMarker("docs/delivery-system-design.md", "a"), state: "closed" }),
      issue(6, { body: childMarker("docs/delivery-system-design.md", "b"), author: "stranger", state: "closed" }),
    ];
    const entries = designTreeReport(root, { issues, botLogin: bot }).get("docs/delivery-system-design.md")!;
    expect(entries[0]).toMatchObject({ slug: "a", recordedIssue: 5, done: true, effectiveClass: "class:tooling" });
    expect(entries[1]!.recordedIssue).toBeUndefined();
    expect(entries[1]!.done).toBe(false);
  });
});
