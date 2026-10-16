import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, encoding: "utf8" });

export async function fetchOrigin(repoDir: string): Promise<void> {
  await git(repoDir, "fetch", "-q", "origin", "main");
}

/** `--ff-only` so the service never merges or rebases its own checkout (S16). */
export async function fastForwardMain(repoDir: string): Promise<{ moved: boolean; changedPaths: string[] }> {
  const before = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  await git(repoDir, "merge", "-q", "--ff-only", "origin/main");
  const after = (await git(repoDir, "rev-parse", "HEAD")).stdout.trim();
  if (before === after) return { moved: false, changedPaths: [] };
  const changedPaths = (await git(repoDir, "diff", "--name-only", before, after)).stdout.split("\n").filter(Boolean);
  return { moved: true, changedPaths };
}

/** AC-17: the scheduler's own code, and agents/ (stages, profiles, config) which it reads at start (I6). */
export function schedulerChanged(paths: string[]): boolean {
  return paths.some((p) => p.startsWith("tools/scheduler/") || p.startsWith("agents/"));
}
