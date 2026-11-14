import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { checkedPaths, checkHostSpace, MIN_FREE_BYTES, type FreeSpace } from "../src/runner/host-space.ts";
import { statePaths } from "../src/state/paths.ts";

const paths = statePaths("/state");
const GIB = 2 ** 30;
const saved = process.env.CLAUDE_CODE_TMPDIR;
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
  else process.env.CLAUDE_CODE_TMPDIR = saved;
});
const run = (freeSpace: (p: string) => Promise<FreeSpace>, worktree: string | null = "/wt") => {
  const log: Record<string, unknown>[] = [];
  return { log, p: checkHostSpace(paths, worktree, { freeSpace, log: (r) => log.push(r) }) };
};

describe("checkHostSpace (spec 059 AC-3)", () => {
  it("passes silently when every path is above both floors", async () => {
    const { log, p } = run(async () => ({ bytes: 20 * GIB, inodes: 1e6 }));
    await expect(p).resolves.toBeUndefined();
    expect(log).toEqual([]);
  });
  it("throws ENOSPC with the exact message when bytes are under the floor", async () => {
    delete process.env.CLAUDE_CODE_TMPDIR;
    const { p } = run(async (path) => ({ bytes: path === tmpdir() ? 100 * 2 ** 20 : 20 * GIB, inodes: 5000 }));
    await expect(p).rejects.toMatchObject({
      code: "ENOSPC",
      message: `host space low: ${tmpdir()} has 100 MiB free and 5000 free inodes (floor 512 MiB, 1000 inodes)`,
    });
  });
  it("throws when inodes are under the floor, and does not judge a volume that reports none", async () => {
    await expect(run(async (path) => ({ bytes: 20 * GIB, inodes: path === "/wt" ? 10 : 1e6 })).p).rejects.toMatchObject({ code: "ENOSPC", message: expect.stringContaining("/wt has 20480 MiB free and 10 free inodes") });
    await expect(run(async () => ({ bytes: 20 * GIB, inodes: null })).p).resolves.toBeUndefined();
  });
  it("logs host-space-unknown for a path it cannot read and still judges the others", async () => {
    const read = async (path: string): Promise<FreeSpace> => {
      if (path === "/state") throw new Error("ENOENT: no such file");
      return { bytes: path === "/wt" ? MIN_FREE_BYTES - 1 : 20 * GIB, inodes: null };
    };
    const { log, p } = run(read);
    await expect(p).rejects.toMatchObject({ code: "ENOSPC" });
    expect(log).toEqual([{ kind: "host-space-unknown", path: "/state", error: "ENOENT: no such file" }]);
    const ok = run(async (path) => { if (path === "/state") throw new Error("gone"); return { bytes: 20 * GIB, inodes: null }; });
    await expect(ok.p).resolves.toBeUndefined();
    expect(ok.log).toHaveLength(1);
  });
});

describe("checkedPaths", () => {
  it("honours CLAUDE_CODE_TMPDIR, falls back to os.tmpdir() and omits a null worktree", () => {
    process.env.CLAUDE_CODE_TMPDIR = "/big/tmp";
    expect(checkedPaths(paths, "/wt")).toEqual(["/big/tmp", "/state", "/wt"]);
    delete process.env.CLAUDE_CODE_TMPDIR;
    expect(checkedPaths(paths, null)).toEqual([tmpdir(), "/state"]);
  });
});
