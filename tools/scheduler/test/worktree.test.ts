import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkProfileSkills } from "../src/runner/skills.ts";
import { diffFilesAgainstBase, ensureWorktree, rebaseOntoMain, removeWorktree, uncommittedPatch } from "../src/runner/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** origin (bare) + a checkout that stands in for the scheduler's repo. */
function repoPair() {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  const repo = join(root, "repo");
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  return { root, origin, repo, worktrees: join(root, "worktrees") };
}

describe("worktrees (AC-16)", () => {
  it("creates a worktree on branch issue-N and reuses it", async () => {
    const { repo, worktrees } = repoPair();
    const w1 = await ensureWorktree(repo, worktrees, 7);
    expect(w1.created).toBe(true);
    expect(w1.branch).toBe("issue-7");
    expect(git(w1.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("issue-7");
    const w2 = await ensureWorktree(repo, worktrees, 7);
    expect(w2.created).toBe(false);
    expect(w2.path).toBe(w1.path);
  });
  it("rebases onto a moved main and reports conflicts", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    writeFileSync(join(w.path, "b.txt"), "b\n");
    git(w.path, "add", "b.txt");
    git(w.path, "commit", "-q", "-m", "b");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "c");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    expect(await rebaseOntoMain(w.path)).toEqual({ ok: true, moved: true });
    expect(existsSync(join(w.path, "c.txt"))).toBe(true);
    writeFileSync(join(repo, "b.txt"), "other\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "conflict");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    const r = await rebaseOntoMain(w.path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflict).toMatch(/CONFLICT/);
    expect(git(w.path, "status", "--porcelain").trim()).toBe("");
  });
  it("lists committed and uncommitted files against base and builds a patch of uncommitted work", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 8);
    writeFileSync(join(w.path, "d.txt"), "d\n");
    git(w.path, "add", "d.txt");
    git(w.path, "commit", "-q", "-m", "d");
    writeFileSync(join(w.path, "e.txt"), "e\n");
    expect((await diffFilesAgainstBase(w.path)).sort()).toEqual(["d.txt", "e.txt"]);
    const patch = await uncommittedPatch(w.path);
    expect(patch).toContain("e.txt");
    expect(git(w.path, "status", "--porcelain").trim()).toBe("?? e.txt");
  });
  it("removes a worktree", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 9);
    await removeWorktree(repo, w.path);
    expect(existsSync(w.path)).toBe(false);
  });
});

describe("linkProfileSkills (AC-26)", () => {
  it("links the skills dir per harness and excludes it from git", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 10);
    const profile = { name: "backend", dir: "/p", skillsDir: join(repo, "agents-skills"), instructions: "", tools: [] };
    const link = await linkProfileSkills(w.path, "claude", profile);
    expect(link).toBe(join(w.path, ".claude", "skills"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(await linkProfileSkills(w.path, "pi", profile)).toBe(join(w.path, ".agents", "skills"));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".claude/skills");
    expect(exclude).toContain(".agents/skills");
    expect(git(w.path, "status", "--porcelain").trim()).toBe("");
  });
});
