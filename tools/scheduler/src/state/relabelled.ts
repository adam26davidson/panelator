import { readFile, rename, writeFile } from "node:fs/promises";
import type { StatePaths } from "./paths.ts";

/** Spec 029 AC-8: the issues whose `needs-design-stage` label was removed, so a restart does not comment twice. */
export async function readRelabelled(p: StatePaths): Promise<Set<number>> {
  try {
    const raw = JSON.parse(await readFile(p.designRelabelled, "utf8")) as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : []);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw e;
  }
}

export async function markRelabelled(p: StatePaths, issue: number): Promise<void> {
  const set = await readRelabelled(p);
  set.add(issue);
  const tmp = `${p.designRelabelled}.tmp`;
  await writeFile(tmp, JSON.stringify([...set].sort((a, b) => a - b)));
  await rename(tmp, p.designRelabelled);
}
