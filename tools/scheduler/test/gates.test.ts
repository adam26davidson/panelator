import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityGate, fixLoopGate, isSensitive, latestLabelActor, livenessGate,
  readyGate, scopeGate, specPresentGate, specScopeGate, uiDesignGate, validatedGate,
} from "../src/gates/index.ts";
import { parseSpec } from "../src/spec/parse.ts";
import type { IssueData, LabelEvent, PlanResult } from "../src/types.ts";

const BOT = "panelator-pipeline[bot]";
const ME = "adam26davidson";
const fx = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "specs", n), "utf8");

function issue(over: Partial<IssueData> = {}): IssueData {
  return {
    number: 5, title: "t", author: BOT, body: "Spec: specs/010-thing/spec.md", labels: ["validated"],
    labelEvents: [{ label: "validated", actor: BOT, action: "labeled", at: "2026-10-01T00:00:00Z" }],
    createdAt: "2026-10-01T00:00:00Z", ...over,
  };
}
const ev = (label: string, actor: string, action: LabelEvent["action"], at: string): LabelEvent => ({ label, actor, action, at });

describe("latestLabelActor", () => {
  it("returns the actor of the most recent add, ignoring an earlier add that was removed (review focus 3)", () => {
    const events = [ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2"), ev("validated", BOT, "labeled", "3")];
    expect(latestLabelActor(events, "validated")).toBe(BOT);
  });
  it("returns null when the label was removed last", () => {
    expect(latestLabelActor([ev("validated", ME, "labeled", "1"), ev("validated", ME, "unlabeled", "2")], "validated")).toBeNull();
  });
});

describe("authorityGate (AC-6, section 4.3)", () => {
  it("passes a bot-authored issue", () => {
    expect(authorityGate(issue(), BOT, ME, "validated")).toEqual({ ok: true });
  });
  it("passes a maintainer-authored issue when the maintainer added validated", () => {
    const i = issue({ author: ME, labelEvents: [ev("validated", ME, "labeled", "1")] });
    expect(authorityGate(i, BOT, ME, "validated").ok).toBe(true);
  });
  it("ignores a community issue even with validated added by someone else", () => {
    const i = issue({ author: "stranger", labelEvents: [ev("validated", "stranger", "labeled", "1")] });
    const r = authorityGate(i, BOT, ME, "validated");
    expect(r).toEqual({ ok: false, action: "ignore", reason: expect.stringMatching(/authority/) });
  });
});

describe("validatedGate (AC-6)", () => {
  it("ignores without the label and never labels", () => {
    expect(validatedGate(issue({ labels: [] }), "validated")).toEqual({ ok: false, action: "ignore", reason: expect.any(String) });
  });
  it("passes with it", () => {
    expect(validatedGate(issue(), "validated").ok).toBe(true);
  });
});

describe("specPresentGate (AC-7, AC-23)", () => {
  const top = "# Top\n\n## Children\n\n- `specs/010-thing/spec.md`\n";
  const read = (files: Record<string, string>) => (p: string) => files[p] ?? null;
  const withTop = read({ "docs/top.md": top });
  it("labels needs-spec when the body has no link", () => {
    const r = specPresentGate(issue({ body: "hi" }), null, withTop);
    expect(r).toMatchObject({ ok: false, action: "label", label: "needs-spec" });
  });
  it("labels needs-spec naming the missing part when the file is absent on main", () => {
    const r = specPresentGate(issue(), null, withTop);
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/not found on main/) });
  });
  it("labels needs-spec naming open decisions", () => {
    const r = specPresentGate(issue(), fx("open-decisions.md"), withTop);
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Open decisions/) });
  });
  it("fails a spec without a Parent line", () => {
    const r = specPresentGate(issue(), fx("good-backend.md").replace(/^Parent:.*\n/m, ""), withTop);
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Parent/) });
  });
  it("fails a spec whose parent does not exist on main", () => {
    const r = specPresentGate(issue(), fx("good-backend.md"), read({}));
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Parent docs\/top\.md/) });
  });
  it("fails a spec whose parent's Children omit it", () => {
    const r = specPresentGate(issue(), fx("good-backend.md"), read({ "docs/top.md": "# Top\n\n## Children\n\n- `specs/011-other/spec.md`\n" }));
    expect(r).toMatchObject({ ok: false, label: "needs-spec", reason: expect.stringMatching(/Parent docs\/top\.md.*Children/) });
  });
  it("passes a complete spec whose parent lists it", () => {
    expect(specPresentGate(issue(), fx("good-backend.md"), withTop)).toEqual({ ok: true });
  });
});

describe("uiDesignGate (AC-8)", () => {
  const web = parseSpec(fx("good-webui.md"));
  it("passes a non-UI domain with no design dir", () => {
    expect(uiDesignGate(parseSpec(fx("good-backend.md")), [])).toEqual({ ok: true });
  });
  it("labels needs-design-stage on an empty design dir, naming spec E (AC-20)", () => {
    expect(uiDesignGate(web, [])).toMatchObject({ ok: false, action: "label", label: "needs-design-stage" });
    expect(uiDesignGate(web, [])).toMatchObject({ reason: expect.stringMatching(/^spec E will provide the design stage: /) });
  });
  it("requires a story or token prototype and a PNG per screen", () => {
    expect(uiDesignGate(web, ["editor.stories.tsx", "editor-empty.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/editor-populated\.png/) });
    expect(uiDesignGate(web, ["editor-empty.png", "editor-populated.png"])).toMatchObject({ ok: false, reason: expect.stringMatching(/story or token prototype/) });
    expect(uiDesignGate(web, ["tokens.html", "editor-empty.png", "editor-populated.png"])).toEqual({ ok: true });
  });
});

describe("readyGate (AC-9)", () => {
  it("ignores spec_gap without a label, with the questions in the reason (spec 006 AC-19)", () => {
    const r = readyGate({ verdict: "spec_gap", domain: "backend", tasks: [], questions: ["Which port?", "Which db?"] });
    expect(r).toEqual({ ok: false, action: "ignore", reason: "The plan stage found gaps in the spec:\n1. Which port?\n2. Which db?" });
  });
  it("passes ready", () => {
    expect(readyGate({ verdict: "ready", domain: "backend", tasks: [] })).toEqual({ ok: true });
  });
});

describe("scopeGate (AC-10) and isSensitive (AC-11)", () => {
  const plan: PlanResult = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["backend/a.rs", "backend/auth/x.rs"] }] };
  const spec = parseSpec(fx("good-backend.md"));
  const globs = ["backend/**/auth/**", "tools/scheduler/"];
  it("passes a diff inside the plan plus lockfiles and schemas", () => {
    expect(scopeGate(["backend/a.rs", "pnpm-lock.yaml", "Cargo.lock", "schemas/x.json"], plan, spec, globs)).toEqual({ ok: true });
  });
  it("lists files outside scope", () => {
    expect(scopeGate(["backend/a.rs", "web/x.ts"], plan, spec, globs)).toEqual({ ok: false, violations: ["web/x.ts: outside plan file scope"] });
  });
  it("fails a sensitive file not listed in the spec even when it is in the plan (review focus 4)", () => {
    expect(scopeGate(["backend/auth/x.rs"], plan, spec, globs)).toEqual({ ok: false, violations: ["backend/auth/x.rs: sensitive path not listed in the spec"] });
  });
  it("allows a sensitive file the spec lists", () => {
    const s = parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `backend/auth/`"));
    expect(scopeGate(["backend/auth/x.rs"], plan, s, globs)).toEqual({ ok: true });
  });
  it("treats a plan directory entry as a prefix", () => {
    const p: PlanResult = { ...plan, tasks: [{ id: "T1", description: "d", files: ["tools/scheduler/src/"] }] };
    expect(scopeGate(["tools/scheduler/src/x.ts"], p, parseSpec(fx("good-backend.md").replace("- `schemas/thing.json`", "- `tools/scheduler/`")), globs)).toEqual({ ok: true });
  });
  it("allows extra prefixes like plan scope (AC-18)", () => {
    expect(scopeGate(["docs/decisions/0007-x.md"], plan, spec, globs, ["docs/decisions/"])).toEqual({ ok: true });
    expect(scopeGate(["docs/decisions/0007-x.md"], plan, spec, globs)).toEqual({ ok: false, violations: ["docs/decisions/0007-x.md: outside plan file scope"] });
  });
  it("isSensitive returns the matching paths", () => {
    expect(isSensitive(["web/a.ts", "tools/scheduler/src/x.ts"], globs)).toEqual(["tools/scheduler/src/x.ts"]);
  });
});

describe("specScopeGate (AC-21, AC-22)", () => {
  const SPEC = "specs/010-x/spec.md";
  const TOP = "docs/product-spec.md";
  const before = "# Product\n\nDecision one.\n\n## Children\n\n- `specs/009-y/spec.md`\n\n## Notes\n\nTail.\n";
  const childrenOnly = before.replace("- `specs/009-y/spec.md`\n", "- `specs/009-y/spec.md`\n- `specs/010-x/spec.md`\n");
  const aboveChildren = childrenOnly.replace("Decision one.", "Decision two.");
  const diff = [SPEC, "docs/designs/a.md", "docs/decisions/0007-x.md", TOP];
  it("allows the spec dir, docs/designs, docs/decisions and a Children-only change to a top-design parent", () => {
    expect(specScopeGate(diff, SPEC, TOP, before, childrenOnly)).toEqual({ ok: true });
    expect(specScopeGate(["specs/010-x/design/a.png", "docs/delivery-system-design.md"], SPEC, "docs/delivery-system-design.md", before, childrenOnly)).toEqual({ ok: true });
  });
  it("fails a top-design parent changed outside its Children section", () => {
    expect(specScopeGate(diff, SPEC, TOP, before, aboveChildren)).toEqual({ ok: false, violations: [`${TOP}: changes outside its Children section`] });
  });
  it("allows a parent under docs/designs/ in full", () => {
    expect(specScopeGate(["docs/designs/a.md"], SPEC, "docs/designs/a.md", before, aboveChildren)).toEqual({ ok: true });
  });
  it("fails the charter as parent, even for a Children-only change", () => {
    const r = specScopeGate([SPEC, "docs/charter.md"], SPEC, "docs/charter.md", before, childrenOnly);
    expect(r).toMatchObject({ ok: false, violations: expect.arrayContaining(["docs/charter.md: not a design"]) });
  });
  it("fails a parent that is not a design even when the diff touches only the spec (C5)", () => {
    expect(specScopeGate([SPEC], SPEC, "docs/charter.md", before, before)).toMatchObject({ ok: false, violations: ["docs/charter.md: not a design"] });
    expect(specScopeGate([SPEC], SPEC, "docs/top.md", before, before)).toMatchObject({ ok: false, violations: ["docs/top.md: not a design"] });
    expect(specScopeGate([SPEC], SPEC, null, before, before)).toMatchObject({ ok: false });
  });
  it("normalises the parent path, so a path escaping docs/designs/ is not a design (review minor B)", () => {
    expect(specScopeGate([SPEC], SPEC, "docs/designs/../charter.md", before, before)).toEqual({ ok: false, violations: ["docs/charter.md: not a design"] });
  });
  it("holds the charter and top designs even when the spec path's directory would contain them (review minor A)", () => {
    expect(specScopeGate(["docs/charter.md", TOP], "docs/spec.md", TOP, before, aboveChildren).ok).toBe(false);
    expect(specScopeGate(["docs/charter.md", TOP], "docs/spec.md", TOP, before, aboveChildren)).toMatchObject({ violations: [expect.stringMatching(/^docs\/charter\.md: /), `${TOP}: changes outside its Children section`] });
  });
  it("fails the charter and files outside the allowed set", () => {
    expect(specScopeGate(["docs/charter.md"], SPEC, TOP, before, before)).toMatchObject({ ok: false, violations: [expect.stringMatching(/^docs\/charter\.md: /)] });
    expect(specScopeGate(["tools/scheduler/src/x.ts"], SPEC, TOP, before, before)).toMatchObject({ ok: false, violations: [expect.stringMatching(/^tools\/scheduler\/src\/x\.ts: /)] });
  });
  it("allows a top design in full only while recording a product answer, never the charter", () => {
    expect(specScopeGate([SPEC, TOP], SPEC, TOP, before, aboveChildren).ok).toBe(false);
    expect(specScopeGate([SPEC, TOP], SPEC, TOP, before, aboveChildren, true)).toEqual({ ok: true });
    expect(specScopeGate([SPEC, "docs/delivery-system-design.md"], SPEC, TOP, before, before, true)).toEqual({ ok: true });
    expect(specScopeGate(["docs/charter.md"], SPEC, TOP, before, before, true).ok).toBe(false);
  });
});

describe("fixLoopGate (AC-13)", () => {
  it("passes 0 and 1, ignores at 2 without a label (spec 006 AC-1)", () => {
    expect(fixLoopGate(0).ok).toBe(true);
    expect(fixLoopGate(1).ok).toBe(true);
    expect(fixLoopGate(2)).toEqual({ ok: false, action: "ignore", reason: "fix loop limit reached (2 fixes)" });
  });
});

describe("livenessGate (AC-15)", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  it("passes while a run is in flight regardless of age", () => {
    expect(livenessGate("2026-10-12T00:00:00Z", true, now, 2).ok).toBe(true);
  });
  it("passes with recent activity", () => {
    expect(livenessGate("2026-10-12T11:00:00Z", false, now, 2).ok).toBe(true);
  });
  it("expires after the window with no run", () => {
    expect(livenessGate("2026-10-12T09:59:00Z", false, now, 2)).toMatchObject({ ok: false, action: "ignore", reason: expect.stringMatching(/liveness/) });
  });
});
