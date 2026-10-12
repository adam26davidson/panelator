import { describe, expect, it } from "vitest";
import { matchesAny } from "../src/glob.ts";

describe("matchesAny", () => {
  it("matches a directory prefix written with a trailing slash", () => {
    expect(matchesAny("tools/scheduler/src/a.ts", ["tools/scheduler/"])).toBe(true);
    expect(matchesAny("tools/schedulerx/a.ts", ["tools/scheduler/"])).toBe(false);
  });
  it("matches ** across directories and * within one", () => {
    expect(matchesAny("backend/auth/x.rs", ["backend/**/auth/**"])).toBe(true);
    expect(matchesAny("backend/auth.rs", ["backend/*.rs"])).toBe(true);
    expect(matchesAny("backend/a/auth.rs", ["backend/*.rs"])).toBe(false);
  });
  it("matches an exact file", () => {
    expect(matchesAny(".github/workflows/ci.yml", [".github/"])).toBe(true);
    expect(matchesAny("pnpm-lock.yaml", ["pnpm-lock.yaml"])).toBe(true);
  });
});
