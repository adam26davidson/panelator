import { execFileSync } from 'node:child_process';
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { chainWorld, scripted, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git } from "./helpers/repo-pair.ts";
import { PARENT, specOf, repoFiles, FAIL, PLAN, APPROVE, CHANGES, agents, expectSettled, inputsOf, runsOf, rev, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-6");

// ---------------------------------------------------------------------------------------------------------------
// Spec 071 AC-7: a spec PR moves its spec; the result names the path and the scheduler rewrites the issue's Spec: line.

describe("end to end: a spec PR moves its spec (spec 071 AC-7)", () => {
  const parentWith = (...specs: string[]) => `# Product spec\n\nParent: docs/charter.md\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n${specs.map((s) => `- \`${s}\`\n`).join("")}`;
  const bodyOf = (line: string) => `Do the thing.\n\nSpec: ${line}\n\nTrailer`;
  const reservedInClaim = () => JSON.parse(readFileSync(join(w!.paths.claims, "7.json"), "utf8")).state.reserved.spec as number | null;
  let w: ChainWorld | undefined;
  /** The spec stage's first run: the spec at `path`, its parent listing it, PR 12. */
  const writes = (world: () => ChainWorld, path: string, mainTakes = false) => (run: StageRun) => {
    // main takes the number while the spec stage runs, as #112 did for #41.
    if (mainTakes) world().moveMain({ "specs/030-other/spec.md": "# other\n" });
    const sha = world().push(run, { [path]: specOf(), [PARENT]: parentWith(path) }, "spec");
    world().openPr(run, 12, sha, "A new spec");
    return { verdict: "revised", spec_path: path, pr_number: 12, head_sha: sha };
  };
  /** The fix: `git mv` (or copy) the directory, update the parent's bullet, push, and report `report` as spec_path. */
  const moves = (world: () => ChainWorld, from: string, to: string, o: { copy?: boolean; report?: string | null; during?: () => void } = {}) => (run: StageRun) => {
    o.during?.();
    if (o.copy) execFileSync("cp", ["-r", join(run.worktree, from), join(run.worktree, to)]);
    else git(run.worktree, "mv", from, to);
    const head_sha = world().push(run, { [PARENT]: parentWith(`${to}/spec.md`) }, "move");
    const report = o.report === undefined ? `${to}/spec.md` : o.report;
    return { head_sha, addressed: [0], ...(report === null ? {} : { spec_path: report }) };
  };
  const keeps = (run: StageRun) => {
    git(run.worktree, "commit", "-q", "--allow-empty", "-m", "keep");
    const branch = git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(run.worktree, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
    return { head_sha: rev(run), addressed: [0], spec_path: "specs/031-x/spec.md" };
  };
  const rest = { plan: [PLAN], implement: [] as Scripted[], review: [APPROVE, APPROVE] };
  type Scripted = Parameters<typeof scripted>[0][string][number];
  const fixInput = (n: number) => runsOf(w!, "fix")[n].input;

  it("issue #41's sequence: main takes 030, the fix is given 031 (in the claim too), moves the directory and the scope passes; the line is rewritten", async () => {
    let seenInClaim: number | null | undefined;
    w = await chainWorld({
      files: repoFiles({ spec: null }), issueBody: bodyOf("specs/030-x/spec.md"),
      results: {
        ...rest,
        spec: [writes(() => w!, "specs/030-x/spec.md", true)],
        review: [CHANGES, APPROVE, APPROVE],
        fix: [
          moves(() => w!, "specs/030-x", "specs/031-x", { report: null, during: () => { seenInClaim = reservedInClaim(); } }),
          keeps,
        ],
      },
    });
    await w.tick();
    expect(runsOf(w, "fix")).toHaveLength(2);
    expect(fixInput(0).spec_number).toBe("031");
    expect(seenInClaim).toBe(31);
    // The rename without spec_path: #41's three violations, then the retry names the path and passes.
    const violations = fixInput(1).fix_input ?? "";
    expect(violations).toContain("specs/030-x/spec.md: no Parent line");
    expect(violations).toContain("docs/product-spec.md: outside spec PR scope");
    expect(violations).toContain("specs/031-x/spec.md: another spec; specs/030-x/spec.md does not link to it");
    expect(w.issueBody).toBe(bodyOf("specs/031-x/spec.md"));
    expect(w.gh.calls.filter((c) => c.method === "PATCH" && c.url === "/repos/o/r/issues/7" && (c.body as { body?: string }).body !== undefined).map((c) => (c.body as { body: string }).body)).toEqual([bodyOf("specs/031-x/spec.md")]);
    expect(w.logs.filter((r) => r.kind === "spec-moved")).toEqual([expect.objectContaining({ kind: "spec-moved", issue: 7, from: "specs/030-x/spec.md", to: "specs/031-x/spec.md" })]);
    expect(w.logs.filter((r) => r.kind === "number-reserved" && r.spec !== undefined).map((r) => r.spec)).toEqual(["031"]);
    expect(w.mergeRequests).toContain(12);
    expect(w.onMain("specs/031-x/spec.md")).toBe(specOf());
    expect(w.onMain("specs/030-x/spec.md")).toBeNull();
  }, 120_000);

  it("a slug-only move on a free number reserves nothing and rewrites the line", async () => {
    w = await chainWorld({
      files: repoFiles({ spec: null }), issueBody: bodyOf("specs/072-a/spec.md"),
      results: { ...rest, spec: [writes(() => w!, "specs/072-a/spec.md")], review: [CHANGES, APPROVE, APPROVE], fix: [moves(() => w!, "specs/072-a", "specs/072-b")] },
    });
    await w.tick();
    expect(fixInput(0).spec_number ?? "(none)").toBe("(none)");
    expect(w.logs.filter((r) => r.kind === "number-reserved" && r.spec !== undefined)).toEqual([]);
    expect(w.issueBody).toBe(bodyOf("specs/072-b/spec.md"));
    expect(w.logs.filter((r) => r.kind === "spec-moved")).toHaveLength(1);
    expect(w.onMain("specs/072-b/spec.md")).toBe(specOf());
  }, 120_000);

  it("a rename to 033 while 031 is reserved fails the result and the issue body still names 030", async () => {
    w = await chainWorld({
      files: repoFiles({ spec: null }), issueBody: bodyOf("specs/030-x/spec.md"),
      results: { ...rest, spec: [writes(() => w!, "specs/030-x/spec.md", true)], review: [CHANGES], fix: [moves(() => w!, "specs/030-x", "specs/033-x", {}), FAIL] },
    });
    await w.tick();
    expect(fixInput(0).spec_number).toBe("031");
    expect(fixInput(1).history).toContain("fix attempt 1 failed: result: spec number 033 is not the issue's 030 or the reserved 031");
    expect(w.issueBody).toBe(bodyOf("specs/030-x/spec.md"));
    expect(w.logs.filter((r) => r.kind === "spec-moved")).toEqual([]);
  }, 120_000);

  it("a copy that leaves both directories fails the result and the issue body is unchanged", async () => {
    w = await chainWorld({
      files: repoFiles({ spec: null }), issueBody: bodyOf("specs/030-x/spec.md"),
      results: { ...rest, spec: [writes(() => w!, "specs/030-x/spec.md")], review: [CHANGES], fix: [moves(() => w!, "specs/030-x", "specs/031-x", { copy: true }), FAIL] },
    });
    await w.tick();
    expect(fixInput(1).history).toContain("fix attempt 1 failed: result: spec moved to specs/031-x/spec.md but specs/030-x/ still holds files");
    expect(w.issueBody).toBe(bodyOf("specs/030-x/spec.md"));
  }, 120_000);

  it("a spec-stage revise of a spec on main that names a new path fails and the body is unchanged", async () => {
    const moved = (run: StageRun) => {
      const sha = w!.push(run, { "specs/011-y/spec.md": specOf() }, "spec");
      w!.openPr(run, 12, sha, "Spec revision for the thing");
      return { verdict: "revised", spec_path: "specs/011-y/spec.md", pr_number: 12, head_sha: sha };
    };
    const a = agents(() => w!);
    w = await chainWorld({
      files: repoFiles(), issueBody: bodyOf("specs/010-thing/spec.md"),
      results: { plan: [PLAN, PLAN], implement: [a.implement(9), FAIL, FAIL], review: [CHANGES], fix: [FAIL, FAIL], spec: [moved, FAIL] },
    });
    await w.tick();
    expect(runsOf(w, "spec").length).toBeGreaterThanOrEqual(2);
    expect(runsOf(w, "spec")[1].input.history).toContain("spec attempt 1 failed: result: the spec at specs/010-thing/spec.md is on main and cannot move");
    expect(w.issueBody).toBe(bodyOf("specs/010-thing/spec.md"));
    expect(w.logs.filter((r) => r.kind === "spec-moved")).toEqual([]);
  }, 120_000);

  it("a spec-track fix on a spec nothing else holds is given no number and reserves none", async () => {
    w = await chainWorld({
      files: repoFiles({ spec: null }), issueBody: bodyOf("specs/030-x/spec.md"),
      results: { ...rest, spec: [writes(() => w!, "specs/030-x/spec.md")], review: [CHANGES, APPROVE, APPROVE], fix: [(run: StageRun) => ({ head_sha: w!.push(run, { "specs/030-x/notes.md": "n\n" }, "fix"), addressed: [0] })] },
    });
    await w.tick();
    expect(fixInput(0).spec_number ?? "(none)").toBe("(none)");
    expect(w.logs.filter((r) => r.kind === "number-reserved" && r.spec !== undefined)).toEqual([]);
    expect(w.issueBody).toBe(bodyOf("specs/030-x/spec.md"));
  }, 120_000);
});
describe("end to end: an implement run stopped before it finished keeps its work (spec 053)", () => {
  const rev = (run: StageRun) => git(run.worktree, "rev-parse", "HEAD").trim();
  const kinds = (w: ChainWorld, kind: string) => w.logs.filter((r) => r.kind === kind);
  /** A run that commits and pushes, then ends on a non-zero exit (the harness stopped it); `pr` opens PR 9 first. */
  const stops = (w: () => ChainWorld, heads: string[], tag: string, pr = false) => (run: StageRun) => {
    const sha = w().push(run, { "a.txt": `${tag}\n` }, tag);
    if (pr) w().openPr(run, 9, sha);
    heads.push(sha);
    return undefined;
  };
  const mainOf = (w: ChainWorld) => git(w.pair.origin, "rev-parse", "main").trim();

  it("the retry starts at the pushed head, is told, drops nothing, and its PR merges (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const heads: string[] = [];
    const starts: string[] = [];
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [stops(() => w, heads, "one"), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))], review: [APPROVE] } });
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "review"]);
    expect(starts).toEqual(heads);
    expect(kinds(w, "held-work")).toMatchObject([{ stage: "implement", branch: "issue-7", head: heads[0], carried: "exit" }]);
    expect(kinds(w, "held-work-kept")).toMatchObject([{ branch: "issue-7", head: heads[0] }]);
    expect(kinds(w, "stale-branch-dropped")).toEqual([]);
    expect(kinds(w, "recovered-commits")).toEqual([]);
    const told = inputsOf(w, "implement")[1].held_work as string;
    expect(told).toContain(heads[0]);
    expect(told).toContain("exit");
    expect(inputsOf(w, "implement")[0].held_work).toBeUndefined();
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);

  it("a PR opened before the run stopped is not closed, and the retry reports it (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const heads: string[] = [];
    const starts: string[] = [];
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [stops(() => w, heads, "one", true), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))], review: [APPROVE] } });
    await w.tick();
    await expectSettled(w);
    expect(starts).toEqual(heads);
    expect(inputsOf(w, "implement")[1].held_work).toContain("#9");
    expect(w.writes().filter((c) => c.startsWith("PATCH /repos/o/r/pulls/") || c.startsWith("DELETE /repos/o/r/git/refs"))).toEqual([]);
    expect(kinds(w, "stale-branch-dropped")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);

  it("two stopped attempts: the rescue starts at the second one's head (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const heads: string[] = [];
    const starts: string[] = [];
    const startsAt = (run: StageRun) => { starts.push(rev(run)); };
    const first = stops(() => w, heads, "one");
    const second = stops(() => w, heads, "two");
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [first, (run: StageRun) => { startsAt(run); return second(run); }, a.implement(9, { "a.txt": "pr 9\n" }, startsAt)], review: [APPROVE] },
    });
    await w.tick();
    await expectSettled(w);
    expect(starts).toEqual([heads[0], heads[1]]);
    expect(runsOf(w, "implement")[2].model).toBe(w.cfg.rescue_model);
    expect(kinds(w, "stale-branch-dropped")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);

  it("a stopped retry and a stopped rescue: the re-plan starts clean, with the stale-branch record (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const heads: string[] = [];
    const starts: string[] = [];
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN, PLAN],
        implement: [stops(() => w, heads, "one"), stops(() => w, heads, "two"), stops(() => w, heads, "three"), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
        review: [APPROVE],
      },
    });
    const main = mainOf(w);
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "implement", "plan", "implement", "review"]);
    expect(starts).toEqual([main]);
    expect(inputsOf(w, "implement")[3].held_work).toBeUndefined();
    expect(kinds(w, "stale-branch-dropped")).toMatchObject([{ issue: 7, branch: "issue-7" }]);
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);

  it("a run that finished with an invalid result after committing is a wrong attempt: the retry starts clean (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const starts: string[] = [];
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [(run: StageRun) => { w.push(run, { "a.txt": "one\n" }); return {}; }, a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))], review: [APPROVE] },
    });
    const main = mainOf(w);
    await w.tick();
    await expectSettled(w);
    expect(starts).toEqual([main]);
    expect(kinds(w, "held-work")).toEqual([]);
    expect(kinds(w, "stale-branch-dropped")).toMatchObject([{ issue: 7, branch: "issue-7" }]);
    expect(inputsOf(w, "implement")[1].held_work).toBeUndefined();
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);

  it("a stopped run that committed nothing: the retry starts clean and no held-work record is written (AC-5)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const starts: string[] = [];
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [FAIL, a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))], review: [APPROVE] } });
    const main = mainOf(w);
    await w.tick();
    await expectSettled(w);
    expect(starts).toEqual([main]);
    expect(kinds(w, "held-work")).toEqual([]);
    expect(inputsOf(w, "implement")[1].held_work).toBeUndefined();
    expect(w.mergeRequests).toEqual([9]);
  }, 120_000);
});
