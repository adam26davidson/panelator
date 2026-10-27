import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDesignTree, loadDesignTree } from "../src/gates/design-tree.ts";

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
    expect(checkDesignTree(loadDesignTree(repoRoot))).toEqual([]);
  });
});
