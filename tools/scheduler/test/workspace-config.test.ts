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

const root = join(import.meta.dirname, "..", "..", "..");

describe("pinned pnpm and install-before-run (spec 035)", () => {
  it("pins packageManager to one exact pnpm 10.x version", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string };
    expect(pkg.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);
  });

  it("lets pnpm/action-setup read the version from packageManager", () => {
    const ci = parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")) as {
      jobs: { test: { steps: { uses?: string; with?: Record<string, unknown> }[] } };
    };
    const steps = ci.jobs.test.steps.filter((s) => s.uses?.startsWith("pnpm/action-setup"));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.with?.version).toBeUndefined();
  });

  it("installs a missing or stale node_modules before a script runs", () => {
    expect(workspace.verifyDepsBeforeRun).toBe("install");
  });
});
