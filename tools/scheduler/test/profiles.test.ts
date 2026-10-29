import { existsSync, readFileSync, statSync } from "node:fs";
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
  it("gives every profile a committed skills directory, so the skills link never dangles (final review T-minor 6)", () => {
    for (const name of listProfiles(agentsDir)) {
      const dir = resolveProfile(agentsDir, name).skillsDir;
      expect(existsSync(dir) && statSync(dir).isDirectory(), name).toBe(true);
      // git keeps no empty directory: the .gitkeep is what makes it committed.
      expect(existsSync(join(dir, ".gitkeep")), name).toBe(true);
    }
  });
  it("no profile tells a stage to run the suite without the shell condition (spec 017 AC-3)", () => {
    for (const name of listProfiles(agentsDir)) {
      const text = resolveProfile(agentsDir, name).instructions.replace(/\s+/g, " ");
      for (const sentence of text.split(/\.(?: |$)/)) {
        if (sentence.includes("pnpm test")) expect(sentence, name).toContain("shell");
      }
    }
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
  it("never lets a merged spec's exception weaken what enforces criteria 6 to 9 without a verified answer (final review C1a)", () => {
    const c5 = criteria.slice(criteria.indexOf("\n5. "), criteria.indexOf("\n6. "));
    expect(c5).toMatch(/That exception never covers what enforces criteria 6 to 9/);
    expect(c5.replace(/\s+/g, " ")).toContain("whatever decides that a sensitive diff gets the security review, that both reviews must approve before a merge, and that a sensitive path must be listed in the spec");
    for (const name of [
      "isSensitive", "pickProfile", "securityPass", "CHARTER_REVERT_LINE", "tools/scheduler/src/gates/spec-scope.ts", "tools/scheduler/src/gates/sensitive.ts",
      "tools/scheduler/src/gates/scope.ts", "tools/scheduler/src/chain/machine.ts", "agents/profiles/security/instructions.md", "agents/sensitive-paths.txt",
    ]) {
      expect(c5).toContain(`\`${name}\``);
    }
    expect(c5).toMatch(/verified\s+maintainer answer/);
  });
  it("makes removing the sensitive entries or weakening these criteria a finding", () => {
    expect(criteria).toMatch(/^\d+\. .*`agents\/sensitive-paths\.txt`.*finding/m);
  });
  it("protects specs 001 and 006 and the enforcing code under criterion 9 (final review C1b)", () => {
    const c9 = criteria.slice(criteria.indexOf("\n9. "));
    for (const p of ["specs/001-scheduler-core/spec.md", "specs/006-no-human-stops/spec.md"]) expect(c9).toContain(`\`${p}\``);
    expect(c9.replace(/\s+/g, " ")).toContain("whatever decides that a sensitive diff gets the security review, that both reviews must approve, and that a sensitive path must be listed in the spec");
    const g = readSensitiveGlobs(agentsDir);
    expect(isSensitive(["specs/001-scheduler-core/spec.md", "specs/006-no-human-stops/spec.md", "specs/002-x/spec.md"], g)).toEqual(["specs/001-scheduler-core/spec.md", "specs/006-no-human-stops/spec.md"]);
  });
  it("makes the repository's test wiring sensitive, so the recorded chain tests cannot be dropped unreviewed (final review C11)", () => {
    const g = readSensitiveGlobs(agentsDir);
    const wiring = ["AGENTS.md", "package.json", "pnpm-workspace.yaml", "vitest.config.ts", "tools/scheduler/vitest.config.mts"];
    expect(isSensitive(wiring, g)).toEqual(wiring);
    expect(isSensitive(["web/package.json", "docs/AGENTS.md.bak"], g)).toEqual([]);
  });
  it("has the spec review refuse a spec that plans to change the charter, a protected decision or their enforcement (final review C1c)", () => {
    const spec = resolveProfile(agentsDir, "spec").reviewCriteria!;
    expect(spec).toMatch(/plans no change to `docs\/charter\.md`, to a protected maintainer decision without a\s+verified maintainer answer, or to how either is enforced/);
    expect(spec.replace(/\s+/g, " ")).toContain("whatever decides that a sensitive diff gets the security review, that both reviews must approve, and that a sensitive path must be listed in the spec");
  });
  it("sends a finding back to the fix loop rather than to the maintainer", () => {
    const p = resolveProfile(agentsDir, "security");
    expect(p.instructions).not.toMatch(/until the maintainer looks/);
    expect(p.instructions).toMatch(/fix loop/);
  });
});
