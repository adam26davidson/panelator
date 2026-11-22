import { exec } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The root Vitest config includes only tools/ and web/, so `pnpm test` would never reach console/. These tests run the console
// package's own scripts (spec 051 sections 3 and 6: the API handlers, the screens, the viewports) and fail with their output.
const root = join(import.meta.dirname, "..", "..", "..");

function run(script: string): Promise<{ code: number; out: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "NODE_ENV"));
  return new Promise((resolve) => {
    exec(`pnpm -F @panelator/console ${script}`, { cwd: root, env, maxBuffer: 32 * 2 ** 20, timeout: 280_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
    });
  });
}

describe("the console package (spec 051)", () => {
  for (const script of ["test", "typecheck", "lint"]) {
    it(`passes its ${script} script`, async () => {
      const r = await run(script);
      expect(r.code, r.out.slice(-6000)).toBe(0);
    }, 300_000);
  }
});
