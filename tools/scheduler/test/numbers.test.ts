import { describe, expect, it } from "vitest";
import { collisions, fmtAdr, fmtSpec, holders, nextFree, numberedPaths, reserveSerially, type Holder } from "../src/chain/numbers.ts";
import { initialChainState } from "../src/chain/machine.ts";
import type { Claim } from "../src/state/claims.ts";

const h = (kind: "spec" | "adr", number: number, holder = "x"): Holder => ({ kind, number, holder });
const claim = (issue: number, reserved: { spec: number | null; adr: number | null }): Claim => ({
  issue, state: { ...initialChainState(issue), reserved }, worktree: "w", started_at: "t", last_activity_at: "t", run_id: null,
});

describe("numberedPaths", () => {
  it("reads spec directories by their spec.md or README.md and ADR files by number", () => {
    expect(numberedPaths(["specs/030-a/spec.md", "specs/031-b/README.md", "specs/031-b/notes.md", "docs/decisions/0006-x.md", "docs/decisions/README.md", "specs/README.md", "docs/decisions/12-short.md"])).toEqual([
      { kind: "spec", number: 30, path: "specs/030-a" },
      { kind: "spec", number: 31, path: "specs/031-b" },
      { kind: "adr", number: 6, path: "docs/decisions/0006-x.md" },
    ]);
  });
});

describe("nextFree", () => {
  it("is one more than the largest number, not the smallest gap", () => {
    expect(nextFree([h("spec", 1), h("spec", 5), h("adr", 9)], "spec")).toBe(6);
    expect(nextFree([h("spec", 1), h("adr", 9)], "adr")).toBe(10);
  });
  it("starts at 1 with no holders", () => {
    expect(nextFree([], "spec")).toBe(1);
    expect(nextFree([], "adr")).toBe(1);
  });
  it("pads", () => {
    expect([fmtSpec(65), fmtAdr(11)]).toEqual(["065", "0011"]);
  });
});

describe("collisions", () => {
  it("names the holder of each added number, and only for the same kind", () => {
    const held = [h("spec", 30, "specs/030-a"), h("adr", 6, "PR #4"), h("adr", 30, "issue #2's reservation")];
    expect(collisions(["specs/030-b/spec.md", "docs/decisions/0006-y.md", "specs/031-c/spec.md", "docs/decisions/0030-z.md"], held)).toEqual([
      { kind: "spec", number: 30, holder: "specs/030-a" },
      { kind: "adr", number: 6, holder: "PR #4" },
      { kind: "adr", number: 30, holder: "issue #2's reservation" },
    ]);
  });
});

describe("holders", () => {
  const deps = (prs: { number: number; added: string[] }[], claims: Claim[]) => ({
    repoDir: "r", paths: {} as never, gh: { openPullRequestsAddedFiles: async () => prs }, listClaims: async () => claims,
    mainFiles: async () => ["specs/064-a/spec.md", "docs/decisions/0010-a.md", "docs/charter.md"],
  });
  it("gathers main, open PRs and the other claims' reservations", async () => {
    const got = await holders(deps([{ number: 5, added: ["specs/065-h/spec.md", "a.txt"] }, { number: 6, added: [] }], [claim(1, { spec: 66, adr: null }), claim(2, { spec: 67, adr: 11 })]), 2);
    expect(got).toEqual([
      h("spec", 64, "specs/064-a"), h("adr", 10, "docs/decisions/0010-a.md"), h("spec", 65, "PR #5"), h("spec", 66, "issue #1's reservation"),
    ]);
  });
  it("skips the run's own pull requests", async () => {
    expect(await holders(deps([{ number: 5, added: ["specs/065-h/spec.md"] }], []), 2, [5])).toEqual([h("spec", 64, "specs/064-a"), h("adr", 10, "docs/decisions/0010-a.md")]);
  });
});

describe("reserveSerially", () => {
  it("runs one at a time and survives a failure", async () => {
    const order: string[] = [];
    const a = reserveSerially(async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 10)); order.push("a2"); throw new Error("x"); });
    const b = reserveSerially(async () => { order.push("b"); return 1; });
    await expect(a).rejects.toThrow("x");
    expect(await b).toBe(1);
    expect(order).toEqual(["a1", "a2", "b"]);
  });
});
