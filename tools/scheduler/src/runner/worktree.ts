import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export async function ensureWorktree(repo: string, worktreesDir: string, issue: number, base = "origin/main"): Promise<{ path: string; branch: string; created: boolean }> {
  const branch = `issue-${issue}`;
  const path = join(worktreesDir, branch);
  if (existsSync(join(path, ".git"))) return { path, branch, created: false };
  await mkdir(worktreesDir, { recursive: true });
  await git(repo, "worktree", "add", "-B", branch, path, base);
  return { path, branch, created: true };
}

export async function rebaseOntoMain(worktree: string, base = "origin/main"): Promise<{ ok: true; moved: boolean } | { ok: false; conflict: string }> {
  const before = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  try {
    await git(worktree, "rebase", base);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    await git(worktree, "rebase", "--abort").catch(() => {});
    return { ok: false, conflict: `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() };
  }
  const after = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  return { ok: true, moved: before !== after };
}

export async function diffFilesAgainstBase(worktree: string, base = "origin/main"): Promise<string[]> {
  const committed = (await git(worktree, "diff", "--name-only", `${base}...HEAD`)).stdout.split("\n");
  const status = (await git(worktree, "status", "--porcelain", "--untracked-files=all")).stdout.split("\n");
  const dirty = status.filter(Boolean).map((l) => l.slice(3).trim().replace(/^.* -> /, ""));
  return [...new Set([...committed, ...dirty].filter(Boolean))].sort();
}

export async function uncommittedPatch(worktree: string): Promise<string> {
  const untracked = (await git(worktree, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean);
  if (untracked.length) await git(worktree, "add", "--intent-to-add", "--", ...untracked);
  try {
    return (await git(worktree, "diff", "HEAD")).stdout;
  } finally {
    if (untracked.length) await git(worktree, "reset", "-q", "--", ...untracked);
  }
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", path).catch(async () => {
    await rm(path, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
  });
}
