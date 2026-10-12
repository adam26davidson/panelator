import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadConfig } from "../src/config.ts";
import { buildSelectContext } from "../src/shortlist/fetch.ts";
import { appendMerge, recentMerges } from "../src/state/merges.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";

function git(cwd: string, ...a: string[]) {
  return execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

describe("buildSelectContext", () => {
  it("reads specs and design listings from origin/main, not the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "fetch-"));
    const origin = join(root, "o.git");
    git(root, "init", "--bare", "-q", "-b", "main", origin);
    const repo = join(root, "repo");
    git(root, "clone", "-q", origin, repo);
    mkdirSync(join(repo, "specs", "010-x", "design"), { recursive: true });
    writeFileSync(join(repo, "specs", "010-x", "spec.md"), "# committed\n");
    writeFileSync(join(repo, "specs", "010-x", "design", "a.png"), "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "spec");
    git(repo, "push", "-q", "origin", "main");
    writeFileSync(join(repo, "specs", "010-x", "spec.md"), "# dirty working tree\n");
    const ctx = buildSelectContext(repo, loadConfig(defaultConfigPath), new Set([3]), "panelator-pipeline[bot]");
    expect(ctx.readSpec("specs/010-x/spec.md")).toBe("# committed\n");
    expect(ctx.readSpec("specs/999-none/spec.md")).toBeNull();
    expect(ctx.listDesign("specs/010-x/spec.md")).toEqual(["a.png"]);
    expect(ctx.listDesign("specs/999-none/spec.md")).toEqual([]);
    expect(ctx.claimed.has(3)).toBe(true);
    expect(ctx.appBot).toBe("panelator-pipeline[bot]");
  });
});

describe("merges record", () => {
  it("counts recent merges by class", async () => {
    const p = statePaths(mkdtempSync(join(tmpdir(), "m-")));
    await ensureStateDirs(p);
    await appendMerge(p, { issue: 1, pr: 2, cls: "feature", at: "2026-10-10T00:00:00Z" });
    await appendMerge(p, { issue: 3, pr: 4, cls: "debt", at: "2026-10-11T00:00:00Z" });
    await appendMerge(p, { issue: 5, pr: 6, cls: "feature", at: "2026-01-01T00:00:00Z" });
    expect(await recentMerges(p, new Date("2026-10-12T00:00:00Z"))).toEqual({ feature: 1, debt: 1 });
  });
});
