import { exec } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// The two rules the skeleton must keep on (spec 112 AC-3): steiger, with the package's own config, rejects each fixture.
const pkg = join(import.meta.dirname, "..", "..");

// Vitest's own variables and NODE_ENV would change what the child process does (as in checks.test.ts).
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV")),
  NO_COLOR: "1",
  FORCE_COLOR: "0",
};

async function steiger(fixture: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await promisify(exec)(
      `pnpm exec steiger --config steiger.config.ts test/fixtures/fsd/${fixture}`,
      { cwd: pkg, env },
    );
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: err.code ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
  }
}

describe("the FSD rules", () => {
  it("reject an import from a higher layer", async () => {
    const r = await steiger("upward-import");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("fsd/forbidden-imports");
  }, 60_000);

  it("reject an import that goes past a slice's public API", async () => {
    const r = await steiger("public-api-sidestep");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("fsd/no-public-api-sidestep");
  }, 60_000);
});
