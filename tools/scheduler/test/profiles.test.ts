import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
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
