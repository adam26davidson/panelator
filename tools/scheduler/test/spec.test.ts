import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { specPathFromIssueBody } from "../src/spec/link.ts";
import { parseChildren, parseSpec, stripChildren } from "../src/spec/parse.ts";

const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "specs", n), "utf8");

describe("specPathFromIssueBody", () => {
  it("finds the Spec: line", () => {
    expect(specPathFromIssueBody("Intro\n\nSpec: specs/010-thing/spec.md\n")).toBe("specs/010-thing/spec.md");
  });
  it("returns null without one", () => {
    expect(specPathFromIssueBody("no link here")).toBeNull();
  });
  it("rejects paths outside specs/ (review focus 2)", () => {
    expect(specPathFromIssueBody("Spec: ../../etc/passwd")).toBeNull();
    expect(specPathFromIssueBody("Spec: specs/../docs/x.md")).toBeNull();
    expect(specPathFromIssueBody("Spec: specs/010-thing/other.md")).toBeNull();
  });
});

describe("parseSpec", () => {
  it("accepts a complete backend spec", () => {
    const s = parseSpec(fx("good-backend.md"));
    expect(s.domain).toBe("backend");
    expect(s.class).toBe("product");
    expect(s.openDecisionsEmpty).toBe(true);
    expect(s.listedPaths).toEqual(["backend/crates/thing/src/lib.rs", "schemas/thing.json"]);
    expect(s.missing).toEqual([]);
  });
  it("requires a UI design section for web-ui and reads the screens", () => {
    const s = parseSpec(fx("good-webui.md"));
    expect(s.missing).toEqual([]);
    expect(s.uiScreens).toEqual(["editor-empty", "editor-populated"]);
    const noUi = parseSpec(fx("good-webui.md").replace(/## 6\. UI design[\s\S]*?(?=## 7\.)/, ""));
    expect(noUi.missing).toContain("UI design section");
  });
  it("lists a missing section", () => {
    expect(parseSpec(fx("missing-verification.md")).missing).toContain("Verification section");
  });
  it("detects non-empty open decisions", () => {
    const s = parseSpec(fx("open-decisions.md"));
    expect(s.openDecisionsEmpty).toBe(false);
    expect(s.missing).toContain("Open decisions must be empty");
  });
  it("matches headings without numbers (review focus 1)", () => {
    expect(parseSpec(fx("unnumbered.md")).missing).toEqual([]);
  });
  it("parses the real spec 001", () => {
    const s = parseSpec(readFileSync(join(import.meta.dirname, "..", "..", "..", "specs", "001-scheduler-core", "spec.md"), "utf8"));
    expect(s.domain).toBe("automation");
    expect(s.class).toBe("tooling");
    expect(s.missing).toEqual([]);
    expect(s.listedPaths).toContain("tools/scheduler/");
  });
});

describe("Parent and Children links", () => {
  it("parses the Parent line", () => {
    expect(parseSpec("Status: x\nParent: docs/a.md\nClass: tooling. Domain: backend.\n").parent).toBe("docs/a.md");
  });
  it("leaves parent null and does not report it missing", () => {
    const s = parseSpec("Status: x\n");
    expect(s.parent).toBeNull();
    expect(s.missing).not.toContain("Parent line");
  });
  it("parseChildren reads backticked and bare bullets", () => {
    const t = "Intro\n## Children\n- `specs/010-a/spec.md`\n- specs/011-b/spec.md\nprose\n## Other\n- `x/y.md`\n";
    expect(parseChildren(t)).toEqual(["specs/010-a/spec.md", "specs/011-b/spec.md"]);
  });
  it("parseChildren accepts a numbered heading and returns [] when empty", () => {
    expect(parseChildren("## 12. Children\n")).toEqual([]);
  });
  it("parseChildren returns null without the heading", () => {
    expect(parseChildren("## Goal\n- `a/b.md`\n")).toBeNull();
  });
  it("stripChildren removes the Children section only", () => {
    const t = "## Goal\ng\n## Children\n- `a/b.md`\n## Verification\nv\n";
    expect(stripChildren(t)).toBe("## Goal\ng\n## Verification\nv\n");
  });
});
