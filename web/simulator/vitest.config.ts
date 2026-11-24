import { defineConfig } from "vitest/config";

// The engine's tests run in Node, once: the golden frames and the unit tests of the host (spec 115 AC-11, AC-13).
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
