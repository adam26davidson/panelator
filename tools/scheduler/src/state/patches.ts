import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatePaths } from "./paths.ts";

export async function savePatch(p: StatePaths, issue: number, diffText: string, now: Date = new Date()): Promise<string | null> {
  if (!diffText.trim()) return null;
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const path = join(p.patches, `${issue}-${ts}.patch`);
  await writeFile(path, diffText);
  return path;
}
