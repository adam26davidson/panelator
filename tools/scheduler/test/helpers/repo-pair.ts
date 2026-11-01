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

/** `files` plus a `docs/top.md` whose `## Children` lists `specPath`, the parent the spec fixtures name (AC-23). */
export function withTopDesign(files: Record<string, string>, specPath: string): Record<string, string> {
  return { ...files, "docs/top.md": `# Top design\n\n## Children\n\n- \`${specPath}\`\n` };
}

/**
 * `files` plus a complete `design/` beside the spec at `specPath` (spec 029 AC-7): a story and, for each screen, the three
 * renders. The gate checks names, so the PNG bytes are placeholders.
 */
export function withDesign(files: Record<string, string>, specPath: string, screens: string[]): Record<string, string> {
  const dir = specPath.replace(/spec\.md$/, "design/");
  const out: Record<string, string> = { ...files, [`${dir}editor.stories.tsx`]: "export default {};\n" };
  for (const s of screens) for (const suffix of ["", ".mobile", ".tablet"]) out[`${dir}${s}${suffix}.png`] = "png\n";
  return out;
}
