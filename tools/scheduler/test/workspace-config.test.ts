import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspace = parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "pnpm-workspace.yaml"), "utf8"),
) as Record<string, unknown>;

describe("pnpm-workspace.yaml build-script approval", () => {
  it("approves esbuild's build and nothing else", () => {
    const allow = workspace.allowBuilds as Record<string, unknown>;
    expect(allow).toBeTypeOf("object");
    expect(Object.keys(allow)).toEqual(["esbuild"]);
    expect(allow.esbuild).toBe(true);
  });

  it("sets no other build-script option", () => {
    for (const key of [
      "onlyBuiltDependencies", "neverBuiltDependencies", "ignoredBuiltDependencies",
      "strictDepBuilds", "dangerouslyAllowAllBuilds",
    ]) {
      expect(workspace, key).not.toHaveProperty(key);
    }
  });
});
