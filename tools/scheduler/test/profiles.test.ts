import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { isSensitive } from "../src/gates/index.ts";
import { listProfiles, readSensitiveGlobs, resolveProfile } from "../src/profiles/resolve.ts";

describe("profiles", () => {
  it("lists the committed v0 profiles", () => {
    expect(listProfiles(agentsDir)).toEqual(["backend", "security", "spec"]);
  });
  it("resolves backend with its skills dir, instructions and tools", () => {
    const p = resolveProfile(agentsDir, "backend");
    expect(p.skillsDir.endsWith("agents/profiles/backend/skills")).toBe(true);
    expect(p.instructions.length).toBeGreaterThan(10);
    expect(p.tools).toContain("Bash");
  });
  it("resolves security with review criteria", () => {
    const p = resolveProfile(agentsDir, "security");
    expect(p.reviewCriteria).toMatch(/sensitive/i);
  });
  it("resolves spec with its review criteria (AC-21)", () => {
    const p = resolveProfile(agentsDir, "spec");
    expect(p.reviewCriteria?.length).toBeGreaterThan(0);
    expect(p.reviewCriteria).toMatch(/maintainer answer, question #/);
  });
  it("throws on an unknown profile", () => {
    expect(() => resolveProfile(agentsDir, "nope")).toThrow(/unknown profile/);
  });
  it("reads the sensitive path globs", () => {
    const g = readSensitiveGlobs(agentsDir);
    expect(g).toContain("tools/scheduler/");
    expect(g).toContain("agents/");
    expect(g).toContain(".github/");
  });
});

describe("the charter and the maintainer's recorded decisions are protected (AC-10)", () => {
  const PROTECTED = ["docs/charter.md", "docs/product-spec.md", "docs/delivery-system-design.md", "docs/design-tree.md"];
  const criteria = readFileSync(join(agentsDir, "profiles", "security", "review-criteria.md"), "utf8");
  it("lists the charter, both top designs and the design tree as sensitive", () => {
    const g = readSensitiveGlobs(agentsDir);
    for (const p of PROTECTED) expect(g).toContain(p);
    expect(isSensitive(PROTECTED, g)).toEqual(PROTECTED);
  });
  it("makes any charter change a finding whose fix is a revert", () => {
    expect(criteria).toMatch(/docs\/charter\.md/);
    expect(criteria).toMatch(/revert/);
  });
  it("protects recorded decisions except the author's calls, the tracking sections and Children, unless a verified answer is cited", () => {
    for (const p of PROTECTED.slice(1)) expect(criteria).toContain(`\`${p}\``);
    for (const re of [/author's call/, /section 11/, /section 12/, /Children/, /maintainer answer, question #/, /verified/]) expect(criteria).toMatch(re);
  });
  it("holds automation changes to the gates, bounds and label rules of specs 001 and 006, except as a merged spec states", () => {
    expect(criteria).toMatch(/do not weaken a gate, a bound, or a label rule of specs 001 and 006,\s+except as a merged spec states\./);
  });
  it("makes removing the sensitive entries or weakening these criteria a finding", () => {
    expect(criteria).toMatch(/^\d+\. .*`agents\/sensitive-paths\.txt`.*finding/m);
  });
  it("sends a finding back to the fix loop rather than to the maintainer", () => {
    const p = resolveProfile(agentsDir, "security");
    expect(p.instructions).not.toMatch(/until the maintainer looks/);
    expect(p.instructions).toMatch(/fix loop/);
  });
});
