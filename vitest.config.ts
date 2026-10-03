import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["tools/**/*.test.ts", "web/**/*.test.ts"],
  },
});
