import { describe, expect, it } from "vitest";
import { ESC, realShapeLog, TS } from "./fixtures/real-shape-log.ts";
import { cleanJobLog } from "../src/github/job-log.ts";

describe("cleanJobLog", () => {
  const out = cleanJobLog(realShapeLog(), 200).split("\n");
  it("strips ANSI sequences and timestamps and drops blank lines", () => {
    expect(out.every((l) => !l.includes(`${ESC}[`))).toBe(true);
    expect(out.every((l) => !/^\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true);
    expect(out.every((l) => l.trim().length > 0)).toBe(true);
    expect(out).toContain(" ✓ Scheduler.tick: passing test number 0  3ms");
  });
  it("ends at the last ##[error] line with no cleanup after it", () => {
    expect(out.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(out.join("\n")).not.toContain("Post job cleanup");
  });
  it("keeps at most the requested number of lines, counted after cleaning", () => {
    expect(out.length).toBeLessThanOrEqual(200);
    expect(cleanJobLog(realShapeLog(300), 200).split("\n")).toHaveLength(200);
    expect(cleanJobLog(realShapeLog(), 5).split("\n")).toHaveLength(5);
  });
  it("cuts nothing from the end of a log with no ##[error] line", () => {
    const text = Array.from({ length: 10 }, (_, i) => `${TS}line ${i}`).join("\n");
    expect(cleanJobLog(text, 3)).toBe("line 7\nline 8\nline 9");
  });
});
