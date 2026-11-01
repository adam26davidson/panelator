import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workspace = parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "pnpm-workspace.yaml"), "utf8"),
) as Record<string, unknown>;

describe("pnpm-workspace.yaml build-script approval", () => {
  it("approves the builds of esbuild and the Chromium download, and nothing else", () => {
    const allow = workspace.allowBuilds as Record<string, unknown>;
    expect(allow).toBeTypeOf("object");
    expect(Object.keys(allow)).toEqual(["esbuild", "@playwright/browser-chromium"]);
    expect(allow.esbuild).toBe(true);
    expect(allow["@playwright/browser-chromium"]).toBe(true);
  });

  it("pins the shared toolchain in a catalog with one vitest range", () => {
    const catalog = workspace.catalog as Record<string, string>;
    expect(catalog).toBeTypeOf("object");
    expect(catalog.vitest).toBe("^3.2.4");
    expect(catalog["playwright-core"]).toBe(catalog["@playwright/browser-chromium"]);
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
