import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatePaths } from "./paths.ts";

/**
 * Write a patch under `patches/` as `<issue>-<timestamp>[-<kind>][-<n>].patch`. The timestamp has
 * one-second resolution, so `kind` separates the patches one worktree preparation can save in the
 * same second (uncommitted work, then commits) and the exclusive create never overwrites an
 * existing file: a true collision gets a numeric suffix instead.
 */
export async function savePatch(p: StatePaths, issue: number, diffText: string, now: Date = new Date(), kind?: string): Promise<string | null> {
  if (!diffText.trim()) return null;
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const stem = join(p.patches, `${issue}-${ts}${kind ? `-${kind}` : ""}`);
  for (let n = 0; ; n++) {
    const path = n === 0 ? `${stem}.patch` : `${stem}-${n}.patch`;
    try {
      await writeFile(path, diffText, { flag: "wx" });
      return path;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
