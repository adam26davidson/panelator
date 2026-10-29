import { execFile } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return exec("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Split NUL-terminated git output (`-z`) into records. */
function nulRecords(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

async function gitPath(cwd: string, name: string): Promise<string> {
  const p = (await git(cwd, "rev-parse", "--git-path", name)).stdout.trim();
  return isAbsolute(p) ? p : join(cwd, p);
}

export async function ensureWorktree(repo: string, worktreesDir: string, issue: number, base = "origin/main"): Promise<{ path: string; branch: string; created: boolean }> {
  const branch = `issue-${issue}`;
  const path = join(worktreesDir, branch);
  if (existsSync(join(path, ".git"))) return { path, branch, created: false };
  await mkdir(worktreesDir, { recursive: true });
  await git(repo, "worktree", "add", "-B", branch, path, base);
  return { path, branch, created: true };
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Rebase the worktree onto `base`. Rewritten commits keep their author; the committer is `identity`
 * when given, so the service never depends on the ambient git config (a CI runner has none).
 */
export async function rebaseOntoMain(worktree: string, base = "origin/main", identity?: GitIdentity): Promise<{ ok: true; moved: boolean } | { ok: false; conflict: string }> {
  const before = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  const ident = identity ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`] : [];
  try {
    await git(worktree, ...ident, "rebase", base);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    const midRebase = existsSync(await gitPath(worktree, "rebase-merge")) || existsSync(await gitPath(worktree, "rebase-apply"));
    // AC-16 covers a conflicting rebase only; anything else (dirty tree, bad upstream) is a real error.
    if (!output.includes("CONFLICT") && !midRebase) throw e;
    await git(worktree, "rebase", "--abort"); // a failed abort throws: never return mid-rebase
    return { ok: false, conflict: output };
  }
  const after = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  return { ok: true, moved: before !== after };
}

export async function diffFilesAgainstBase(worktree: string, base = "origin/main"): Promise<string[]> {
  const committed = nulRecords((await git(worktree, "diff", "--name-only", "-z", `${base}...HEAD`)).stdout);
  const status = nulRecords((await git(worktree, "status", "--porcelain", "-z", "--untracked-files=all")).stdout);
  const dirty: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const rec = status[i];
    dirty.push(rec.slice(3));
    // A rename or copy record is followed by a second record holding the old path.
    if (rec[0] === "R" || rec[0] === "C") i++;
  }
  return [...new Set([...committed, ...dirty])].sort();
}

/** Spec 005: the commits reachable from `head` and not from `base`, as a `git am`-able mailbox; empty when there are none. */
export async function commitsPatch(worktree: string, base: string, head = "HEAD"): Promise<string> {
  return (await git(worktree, "format-patch", "--stdout", `${base}..${head}`)).stdout;
}

export async function uncommittedPatch(worktree: string): Promise<string> {
  const untracked = nulRecords((await git(worktree, "ls-files", "-z", "--others", "--exclude-standard")).stdout);
  if (untracked.length) await git(worktree, "add", "--intent-to-add", "--", ...untracked);
  try {
    return (await git(worktree, "-c", "core.quotePath=false", "diff", "--binary", "HEAD")).stdout;
  } finally {
    if (untracked.length) await git(worktree, "reset", "-q", "--", ...untracked);
  }
}

/** Drops every uncommitted change (staged, unstaged and untracked); HEAD is untouched. Save a patch first. */
export async function discardUncommitted(worktree: string): Promise<void> {
  // reset --hard, not checkout -- .: checkout restores from the index and would leave staged changes behind
  await git(worktree, "reset", "-q", "--hard");
  await git(worktree, "clean", "-fd");
}

/**
 * Puts the worktree on `branch`, created or reset to `base`; used to start a spec branch or re-enter an issue branch.
 * `--no-track`: a branch cut from origin/main must not have main as its upstream, or a plain push would aim at main.
 */
export async function checkoutBranch(worktree: string, branch: string, base: string): Promise<void> {
  await git(worktree, "checkout", "-q", "--no-track", "-B", branch, base);
}

/** D4: forced, because `spec-N` holds commits that were never merged (closed PRs, abandonment). A missing branch is ignored. */
export async function deleteLocalBranch(worktree: string, branch: string): Promise<void> {
  try {
    await git(worktree, "branch", "-D", branch);
  } catch (e) {
    const err = e as { stderr?: string };
    if (!/not found/.test(err.stderr ?? "")) throw e;
  }
}

/** C1: points the issue branch at base before a stage with no PR (plan, first implement). Save a patch first. */
export async function resetToBase(worktree: string, base = "origin/main"): Promise<void> {
  await git(worktree, "reset", "-q", "--hard", base);
}

async function canonical(p: string): Promise<string> {
  return realpath(p).catch(() => resolve(p));
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

/**
 * R1: put the worktree on the branch's remote head when GitHub is ahead of it, so every diff the
 * scheduler judges (sensitivity, scope) is of the commit the PR actually holds. Local commits that
 * are not on the remote yet are kept when they build on it (the stage pushes them); when the two
 * have diverged the remote wins and the old local head is reported (it stays in the reflog).
 * A branch with no remote counterpart yet is left alone.
 */
export async function syncToRemote(worktree: string, remoteBranch: string): Promise<{ moved: boolean; dropped: string | null }> {
  const head = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  let remote: string;
  try {
    remote = (await git(worktree, "rev-parse", "--verify", "--quiet", `${remoteBranch}^{commit}`)).stdout.trim();
  } catch {
    return { moved: false, dropped: null };
  }
  if (remote === head || (await isAncestor(worktree, remote, head))) return { moved: false, dropped: null };
  const fastForward = await isAncestor(worktree, head, remote);
  await git(worktree, "reset", "-q", "--hard", remote);
  return { moved: true, dropped: fastForward ? null : head };
}

/**
 * Spec 015 AC-3: whether `dropped` carries nothing of its own beyond `remote`: every commit reachable from it and from
 * neither `remote` nor `base` is, change for change (`git patch-id`), one of the remote's commits not on `base`. True for
 * the remote head rebased onto base, which the driver's rebase makes before review and fix; a merge commit is never one.
 */
export async function onlyRebased(worktree: string, dropped: string, remote: string, base = "origin/main"): Promise<boolean> {
  const own = (await git(worktree, "rev-list", "--right-only", "--cherry-pick", `${remote}...${dropped}`, `^${base}`)).stdout.trim();
  return own === "";
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  try {
    await git(repo, "worktree", "remove", "--force", path);
  } catch (e) {
    // Only ever delete a registered linked worktree: never the main worktree (first entry) or an arbitrary directory.
    const entries = nulRecords((await git(repo, "worktree", "list", "--porcelain", "-z")).stdout)
      .filter((r) => r.startsWith("worktree "))
      .map((r) => r.slice("worktree ".length));
    const target = await canonical(path);
    const linked = await Promise.all(entries.slice(1).map(canonical));
    if (!linked.includes(target)) throw e;
    await rm(path, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
  }
}
