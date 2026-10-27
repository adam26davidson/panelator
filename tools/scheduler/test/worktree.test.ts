import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkProfileSkills } from "../src/runner/skills.ts";
import { checkoutBranch, commitsPatch, deleteLocalBranch, diffFilesAgainstBase, discardUncommitted, ensureWorktree, rebaseOntoMain, removeWorktree, resetToBase, syncToRemote, uncommittedPatch } from "../src/runner/worktree.ts";
import { git, repoPair } from "./helpers/repo-pair.ts";

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
    // The identity is what makes this pass on a CI runner with no git config; the committer must be the bot.
    const bot = { name: "panelator-pipeline[bot]", email: "panelator-pipeline[bot]@users.noreply.github.com" };
    expect(await rebaseOntoMain(w.path, "origin/main", bot)).toEqual({ ok: true, moved: true });
    expect(existsSync(join(w.path, "c.txt"))).toBe(true);
    expect(git(w.path, "log", "-1", "--format=%an|%cn <%ce>").trim()).toBe("t|panelator-pipeline[bot] <panelator-pipeline[bot]@users.noreply.github.com>");
    writeFileSync(join(repo, "b.txt"), "other\n");
    git(repo, "add", "b.txt");
    git(repo, "commit", "-q", "-m", "conflict");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    const r = await rebaseOntoMain(w.path, "origin/main", bot);
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
  it("builds a patch that git apply accepts with a binary file among the changes", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 12);
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    writeFileSync(join(w.path, "blob.bin"), bytes);
    writeFileSync(join(w.path, "notes.txt"), "n\n");
    const patch = await uncommittedPatch(w.path);
    const fresh = await ensureWorktree(repo, worktrees, 13);
    const patchFile = join(worktrees, "release.patch");
    writeFileSync(patchFile, patch);
    git(fresh.path, "apply", patchFile);
    expect(readFileSync(join(fresh.path, "blob.bin")).equals(bytes)).toBe(true);
    expect(readFileSync(join(fresh.path, "notes.txt"), "utf8")).toBe("n\n");
  });
  it("removes a worktree", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 9);
    await removeWorktree(repo, w.path);
    expect(existsSync(w.path)).toBe(false);
  });
  it("refuses to delete the main worktree or a directory that is not a worktree", async () => {
    const { root, repo } = repoPair();
    await expect(removeWorktree(repo, repo)).rejects.toThrow();
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    const plain = join(root, "not-a-worktree");
    mkdirSync(plain);
    writeFileSync(join(plain, "keep.txt"), "k\n");
    await expect(removeWorktree(repo, plain)).rejects.toThrow();
    expect(existsSync(join(plain, "keep.txt"))).toBe(true);
  });
  it("lists and patches paths with spaces, quotes and non-ASCII characters unquoted", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 11);
    writeFileSync(join(w.path, 'q"uote.txt'), "q\n");
    git(w.path, "add", 'q"uote.txt');
    git(w.path, "commit", "-q", "-m", "q");
    writeFileSync(join(w.path, "sp ace.txt"), "s\n");
    writeFileSync(join(w.path, "café.txt"), "c\n");
    expect(await diffFilesAgainstBase(w.path)).toEqual(['café.txt', 'q"uote.txt', "sp ace.txt"].sort());
    const before = git(w.path, "status", "--porcelain", "-z");
    const patch = await uncommittedPatch(w.path);
    expect(patch).toContain("café.txt");
    expect(patch).toContain("sp ace.txt");
    expect(git(w.path, "status", "--porcelain", "-z")).toBe(before);
  });
  it("rethrows a non-conflict rebase failure and leaves the tree untouched", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 12);
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "c");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    writeFileSync(join(w.path, "a.txt"), "changed\n");
    await expect(rebaseOntoMain(w.path)).rejects.toThrow(/unstaged changes/);
    expect(git(w.path, "status", "--porcelain").trim()).toBe("M a.txt");
    expect(readFileSync(join(w.path, "a.txt"), "utf8")).toBe("changed\n");
  });
  it("discards modified and untracked files and leaves HEAD unchanged", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 15);
    const head = git(w.path, "rev-parse", "HEAD").trim();
    writeFileSync(join(w.path, "a.txt"), "changed\n");
    mkdirSync(join(w.path, "newdir"));
    writeFileSync(join(w.path, "newdir", "u.txt"), "u\n");
    writeFileSync(join(w.path, "top.txt"), "t\n");
    writeFileSync(join(w.path, "staged.txt"), "s\n");
    git(w.path, "add", "a.txt", "staged.txt");
    await discardUncommitted(w.path);
    expect(git(w.path, "status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(w.path, "staged.txt"))).toBe(false);
    expect(git(w.path, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    expect(readFileSync(join(w.path, "a.txt"), "utf8")).toBe("a\n");
    expect(existsSync(join(w.path, "newdir"))).toBe(false);
    expect(existsSync(join(w.path, "top.txt"))).toBe(false);
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(head);
  });
});

describe("syncToRemote (R1)", () => {
  it("fast-forwards to a remote that moved ahead, keeps local commits that build on it, and prefers the remote when diverged", async () => {
    const { repo, worktrees, root, origin } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    // No remote branch yet: untouched.
    expect(await syncToRemote(w.path, "origin/issue-7")).toEqual({ moved: false, dropped: null });
    git(w.path, "push", "-q", "-u", "origin", "issue-7");
    const other = join(root, "other");
    git(root, "clone", "-q", "-b", "issue-7", origin, other);
    writeFileSync(join(other, "r.txt"), "remote\n");
    git(other, "add", "r.txt");
    git(other, "commit", "-q", "-m", "remote");
    git(other, "push", "-q", "origin", "issue-7");
    const remote = git(other, "rev-parse", "HEAD").trim();
    git(w.path, "fetch", "-q", "origin");
    // Remote ahead: fast-forward, nothing dropped.
    expect(await syncToRemote(w.path, "origin/issue-7")).toEqual({ moved: true, dropped: null });
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(remote);
    // Local ahead (unpushed work on top of the remote): kept.
    writeFileSync(join(w.path, "l.txt"), "local\n");
    git(w.path, "add", "l.txt");
    git(w.path, "commit", "-q", "-m", "local");
    const local = git(w.path, "rev-parse", "HEAD").trim();
    expect(await syncToRemote(w.path, "origin/issue-7")).toEqual({ moved: false, dropped: null });
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(local);
    // Diverged: the remote wins and the old local head is reported.
    writeFileSync(join(other, "r.txt"), "remote 2\n");
    git(other, "commit", "-q", "-am", "remote 2");
    git(other, "push", "-q", "origin", "issue-7");
    const remote2 = git(other, "rev-parse", "HEAD").trim();
    git(w.path, "fetch", "-q", "origin");
    expect(await syncToRemote(w.path, "origin/issue-7")).toEqual({ moved: true, dropped: local });
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(remote2);
    expect(existsSync(join(w.path, "l.txt"))).toBe(false);
  });
});

describe("resetToBase (C1)", () => {
  it("moves the worktree branch to origin/main, dropping a stray commit", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    writeFileSync(join(w.path, "stray.txt"), "stray\n");
    git(w.path, "add", "stray.txt");
    git(w.path, "commit", "-q", "-m", "stray");
    writeFileSync(join(repo, "c.txt"), "c\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-q", "-m", "c");
    git(repo, "push", "-q", "origin", "main");
    git(w.path, "fetch", "-q", "origin");
    await resetToBase(w.path);
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(git(w.path, "rev-parse", "origin/main").trim());
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("issue-7");
    expect(existsSync(join(w.path, "stray.txt"))).toBe(false);
    expect(existsSync(join(w.path, "c.txt"))).toBe(true);
  });
});

describe("commitsPatch (spec 005)", () => {
  it("returns a patch of the commits past the base that git am applies onto it, and an empty string when there are none", async () => {
    const { repo, worktrees, root } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    expect(await commitsPatch(w.path, "origin/main")).toBe("");
    writeFileSync(join(w.path, "k.txt"), "kept\n");
    git(w.path, "add", "k.txt");
    git(w.path, "commit", "-q", "-m", "keep me");
    const patch = await commitsPatch(w.path, "origin/main");
    expect(patch.startsWith("From ")).toBe(true);
    expect(patch).toContain("keep me");
    expect(patch).toContain("k.txt");
    const file = join(root, "k.patch");
    writeFileSync(file, patch);
    git(repo, "am", file);
    expect(readFileSync(join(repo, "k.txt"), "utf8")).toBe("kept\n");
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("keep me");
  });
  it("takes only the commits reachable from an explicit head and not from the base", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    writeFileSync(join(w.path, "one.txt"), "1\n");
    git(w.path, "add", "one.txt");
    git(w.path, "commit", "-q", "-m", "first");
    const first = git(w.path, "rev-parse", "HEAD").trim();
    writeFileSync(join(w.path, "two.txt"), "2\n");
    git(w.path, "add", "two.txt");
    git(w.path, "commit", "-q", "-m", "second");
    const patch = await commitsPatch(w.path, "origin/main", first);
    expect(patch).toContain("one.txt");
    expect(patch).not.toContain("two.txt");
    expect(await commitsPatch(w.path, first, first)).toBe("");
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
  it("replaces its own symlink but refuses to delete a real directory at the link path", async () => {
    const { repo, worktrees } = repoPair();
    const profile = { name: "backend", dir: "/p", skillsDir: join(repo, "agents-skills"), instructions: "", tools: [] };
    const w = await ensureWorktree(repo, worktrees, 13);
    await linkProfileSkills(w.path, "claude", profile);
    const link = await linkProfileSkills(w.path, "claude", profile);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const w2 = await ensureWorktree(repo, worktrees, 14);
    const real = join(w2.path, ".claude", "skills");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "tracked\n");
    await expect(linkProfileSkills(w2.path, "claude", profile)).rejects.toThrow(real);
    expect(readFileSync(join(real, "SKILL.md"), "utf8")).toBe("tracked\n");
  });
});

describe("branch helpers (spec 006)", () => {
  it("checkoutBranch resets issue-N to the base and deleteLocalBranch force-deletes an unmerged branch", async () => {
    const { repo, worktrees } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    git(w.path, "checkout", "-q", "-b", "spec-7");
    writeFileSync(join(w.path, "s.txt"), "s\n");
    git(w.path, "add", "s.txt");
    git(w.path, "commit", "-q", "-m", "spec");
    await checkoutBranch(w.path, "issue-7", "origin/main");
    expect(git(w.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("issue-7");
    expect(git(w.path, "rev-parse", "HEAD").trim()).toBe(git(w.path, "rev-parse", "origin/main").trim());
    await deleteLocalBranch(w.path, "spec-7");
    expect(git(w.path, "branch", "--list", "spec-7").trim()).toBe("");
    await deleteLocalBranch(w.path, "spec-7");
  });
  it("a branch from checkoutBranch tracks nothing, and the spec prompt's `git push -u origin HEAD` publishes it under its own name", async () => {
    const { repo, worktrees, origin } = repoPair();
    const w = await ensureWorktree(repo, worktrees, 7);
    await checkoutBranch(w.path, "spec-7", "origin/main");
    expect(() => git(w.path, "rev-parse", "--abbrev-ref", "spec-7@{upstream}")).toThrow();
    writeFileSync(join(w.path, "s.txt"), "s\n");
    git(w.path, "add", "s.txt");
    git(w.path, "commit", "-q", "-m", "spec");
    git(w.path, "push", "-q", "-u", "origin", "HEAD");
    expect(git(origin, "rev-parse", "refs/heads/spec-7").trim()).toBe(git(w.path, "rev-parse", "HEAD").trim());
    expect(git(origin, "rev-parse", "refs/heads/main").trim()).toBe(git(repo, "rev-parse", "main").trim());
    expect(git(w.path, "rev-parse", "--abbrev-ref", "spec-7@{upstream}").trim()).toBe("origin/spec-7");
  });
});
