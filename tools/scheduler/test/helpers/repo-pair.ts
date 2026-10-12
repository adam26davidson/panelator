import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** A bare origin plus a checkout that stands in for the scheduler's repo, with one commit on main. */
export function repoPair(files: Record<string, string> = { "a.txt": "a\n" }) {
  const root = mkdtempSync(join(tmpdir(), "pair-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const repo = join(root, "repo");
  // stderr dropped: git warns "cloned an empty repository" even with -q
  execFileSync("git", ["clone", "-q", origin, repo], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  for (const [p, c] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", join(repo, p, "..")]);
    writeFileSync(join(repo, p), c);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  return { root, origin, repo, worktrees: join(root, "worktrees") };
}
