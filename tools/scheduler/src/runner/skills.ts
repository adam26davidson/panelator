import { execFile } from "node:child_process";
import { appendFile, lstat, mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { Harness, Profile } from "../types.ts";

const exec = promisify(execFile);

export function skillsLinkPath(worktree: string, harness: Harness): string {
  return join(worktree, harness === "pi" ? ".agents" : ".claude", "skills");
}

/** AC-26: expose the profile's skills to the harness without ever committing them. */
export async function linkProfileSkills(worktree: string, harness: Harness, profile: Profile): Promise<string> {
  const link = skillsLinkPath(worktree, harness);
  await mkdir(dirname(link), { recursive: true });
  const existing = await lstat(link).catch(() => null);
  // Replace only our own symlink; a real directory there may be tracked content and must never be deleted.
  if (existing && !existing.isSymbolicLink()) throw new Error(`refusing to replace ${link}: it exists and is not a symbolic link`);
  if (existing) await unlink(link);
  await symlink(profile.skillsDir, link, "dir");
  // git ignores a linked worktree's own info/exclude; --git-path resolves the file git actually reads.
  const gitPath = (await exec("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktree, encoding: "utf8" })).stdout.trim();
  const excludePath = isAbsolute(gitPath) ? gitPath : join(worktree, gitPath);
  await mkdir(dirname(excludePath), { recursive: true });
  const rel = link.slice(worktree.length + 1);
  const current = await readFile(excludePath, "utf8").catch(() => "");
  if (!current.split("\n").includes(rel)) await appendFile(excludePath, `${rel}\n`);
  return link;
}
