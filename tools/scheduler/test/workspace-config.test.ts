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

describe("CI installs Chromium with its libraries (spec 054)", () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

  const isChromiumInstall = (s: Step): boolean => {
    const tokens = (s.run ?? "").split(/\s+/);
    const at = ["playwright-core", "install", "--with-deps", "chromium"].map((t) => tokens.indexOf(t));
    return at.every((i, n) => i >= 0 && (n === 0 || i > (at[n - 1] ?? 0)));
  };

  function checkChromiumSteps(steps: Step[]): string[] {
    const problems: string[] = [];
    const installs = steps.filter(isChromiumInstall);
    if (installs.length !== 1) problems.push(`expected one Chromium install step, found ${installs.length}`);
    const at = installs[0] ? steps.indexOf(installs[0]) : -1;
    const frozen = steps.findIndex((s) => s.run === "pnpm install --frozen-lockfile");
    const test = steps.findIndex((s) => s.run === "pnpm test");
    if (frozen < 0) problems.push("no frozen install step");
    if (test < 0) problems.push("no pnpm test step");
    if (installs.length === 1 && (at < frozen || at > test)) {
      problems.push("Chromium install must come after the frozen install and before pnpm test");
    }
    for (const s of steps) {
      if (!s.uses?.startsWith("actions/cache")) continue;
      if (String(s.with?.path ?? "").split("\n").some((l) => l.includes("ms-playwright"))) {
        problems.push("the Playwright browser must not be cached");
      }
    }
    const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
    if (setupNode?.with?.cache !== "pnpm") problems.push("setup-node must keep cache: pnpm");
    return problems;
  }

  const steps = (parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { test: { steps: Step[] } };
  }).jobs.test.steps;

  it("installs Chromium with its libraries before the suite and does not cache it", () => {
    expect(checkChromiumSteps(steps)).toEqual([]);
  });

  it("fails when the step is removed, loses --with-deps, moves after the suite, or a cache is added", () => {
    const install = steps.find(isChromiumInstall) as Step;
    const without = steps.filter((s) => s !== install);
    const testAt = without.findIndex((s) => s.run === "pnpm test");
    const variants: Step[][] = [
      without,
      steps.map((s) => (s === install ? { ...s, run: s.run?.replace(" --with-deps", "") } : s)),
      [...without.slice(0, testAt + 1), install, ...without.slice(testAt + 1)],
      steps.flatMap((s) =>
        s === install
          ? [{ uses: "actions/cache@v4", with: { path: "~/.cache/ms-playwright", key: "x" } }, s]
          : [s],
      ),
    ];
    for (const v of variants) expect(checkChromiumSteps(v).length).toBeGreaterThan(0);
  });
});

describe("CI runs the design package's lint (spec 055)", () => {
  type LintStep = { run?: string };
  const LINT_RUN = "pnpm -F @panelator/design-stage lint";

  function checkLint(steps: LintStep[], scripts: Record<string, string>): string[] {
    const problems: string[] = [];
    const lintSteps = steps.filter((s) => s.run === LINT_RUN);
    if (lintSteps.length !== 1) problems.push(`expected exactly one lint step, found ${lintSteps.length}`);
    const frozen = steps.findIndex((s) => s.run === "pnpm install --frozen-lockfile");
    if (lintSteps.length === 1 && steps.indexOf(lintSteps[0]) < frozen) {
      problems.push("the lint step must come after the frozen install");
    }
    const lint = scripts.lint;
    if (lint === undefined) {
      problems.push("the package has no lint script");
    } else {
      let from = 0;
      for (const word of ["biome", "check", "knip", "--workspace"]) {
        const at = lint.split(/\s+/).indexOf(word, from);
        if (at < 0) {
          problems.push(`the lint script lacks ${word} in order`);
          break;
        }
        from = at + 1;
      }
    }
    return problems;
  }

  const steps = (parse(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8")) as {
    jobs: { test: { steps: LintStep[] } };
  }).jobs.test.steps;
  const scripts = (
    JSON.parse(readFileSync(join(root, "tools", "design-stage", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it("has the lint step after the install and the lint script in the package", () => {
    expect(checkLint(steps, scripts)).toEqual([]);
  });

  it("fails when the step or the script is removed", () => {
    const { lint: _lint, ...withoutScript } = scripts;
    expect(checkLint(steps.filter((s) => s.run !== LINT_RUN), scripts).length).toBeGreaterThan(0);
    expect(checkLint(steps, withoutScript).length).toBeGreaterThan(0);
  });
});
