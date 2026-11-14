import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { StatePaths } from "../state/paths.ts";

/**
 * Spec 059 AC-3: before a run is launched, the volumes it writes to must have room. The floors change when the host
 * does, so they are constants, not parameters.
 */
export const MIN_FREE_BYTES = 512 * 2 ** 20;
export const MIN_FREE_INODES = 1000;

/** `inodes` is null when the volume reports none (btrfs), which is then not judged on inodes. */
export type FreeSpace = { bytes: number; inodes: number | null };

export async function statfsFreeSpace(path: string): Promise<FreeSpace> {
  const s = await statfs(path);
  return { bytes: Number(s.bavail) * Number(s.bsize), inodes: Number(s.files) > 0 ? Number(s.ffree) : null };
}

/** The harness's temporary directory, the state root and the run's worktree (null for a run without one). */
export function checkedPaths(paths: StatePaths, worktree: string | null): string[] {
  const tmp = process.env.CLAUDE_CODE_TMPDIR;
  return [...new Set([tmp ? tmp : tmpdir(), paths.root, ...(worktree === null ? [] : [worktree])])];
}

/**
 * Throws an error with `code: "ENOSPC"` when a checked volume is below a floor. A path whose free space cannot be read
 * is logged and passed: the check never blocks a run on its own failure.
 */
export async function checkHostSpace(
  paths: StatePaths,
  worktree: string | null,
  deps: { freeSpace?: (path: string) => Promise<FreeSpace>; log: (entry: Record<string, unknown>) => void },
): Promise<void> {
  const read = deps.freeSpace ?? statfsFreeSpace;
  for (const path of checkedPaths(paths, worktree)) {
    let free: FreeSpace;
    try {
      free = await read(path);
    } catch (e) {
      deps.log({ kind: "host-space-unknown", path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (free.bytes < MIN_FREE_BYTES || (free.inodes !== null && free.inodes < MIN_FREE_INODES)) {
      throw Object.assign(
        new Error(`host space low: ${path} has ${Math.floor(free.bytes / 2 ** 20)} MiB free and ${free.inodes ?? "unknown"} free inodes (floor ${MIN_FREE_BYTES / 2 ** 20} MiB, ${MIN_FREE_INODES} inodes)`),
        { code: "ENOSPC" },
      );
    }
  }
}
