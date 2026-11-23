import { exec } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The root Vitest config runs only this file of web/ (spec 112 AC-14). Each test runs one script of the package from the
// repository root and fails with the end of its output. A new kind of check is a new script with its own entry here.
const root = join(import.meta.dirname, "..");

function run(script: string): Promise<{ code: number; out: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV"),
  );
  return new Promise((resolve) => {
    exec(
      `pnpm -F @panelator/web ${script}`,
      { cwd: root, env, maxBuffer: 32 * 2 ** 20, timeout: 580_000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("the web package (spec 112)", () => {
  for (const script of ["typecheck", "lint", "fsd", "knip", "test", "build", "build-storybook", "e2e"]) {
    it(script, async () => {
      const r = await run(script);
      expect(r.code, r.out.slice(-6000)).toBe(0);
    }, 600_000);
  }

  it("dependency rule: declares its dependencies from the catalog", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const block = workspace.split(/^catalog:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
    const catalog = new Map<string, string>();
    for (const line of block.split("\n")) {
      const m = /^ {2}"?([^":\s]+(?:\/[^":\s]+)?)"?:\s*(\S+)/.exec(line);
      if (m?.[1] && m[2]) catalog.set(m[1], m[2]);
    }
    const pkg = JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const entries = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, range] of entries) {
      if (name === "@types/node") continue;
      expect(range, name).toBe("catalog:");
      expect(catalog.has(name), `${name} is in the catalog`).toBe(true);
    }
    const playwright = ["playwright-core", "@playwright/browser-chromium", "@playwright/test"].map((n) =>
      catalog.get(n),
    );
    expect(playwright[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(playwright).size).toBe(1);
  });
});
