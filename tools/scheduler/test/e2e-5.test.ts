import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { listClaims } from "../src/state/claims.ts";
import { chainWorld, RATE_LIMITED, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git } from "./helpers/repo-pair.ts";
import { specOf, repoFiles, FAIL, PLAN, APPROVE, agents, expectSettled, runsOf, patchesOf, network, serviceRecords, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-5");

// ---------------------------------------------------------------------------------------------------------------
// Spec 065 AC-7: the scheduler reserves spec and ADR numbers; a wrong or held number fails the result.

describe("end to end: spec and ADR numbers are reserved by the scheduler (spec 065 AC-7)", () => {
  const prev = { "specs/064-prev/spec.md": "# prev\n" };
  /** A hand-made open PR adding `files`, as no chain of the scheduler's made it. */
  const handPr = (w: ChainWorld, n: number, files: string[]) => {
    w.prs.set(n, { number: n, head: `hand-${n}`, sha: "0".repeat(40), body: "", state: "open", merged: false });
    w.addedByPr.set(n, files);
  };
  const specAt = (w: () => ChainWorld, path: string, extra: Record<string, string> = {}) => (run: StageRun) => {
    const sha = w().push(run, { [path]: specOf(), ...extra }, "spec");
    w().openPr(run, 12, sha, "A new spec");
    return { verdict: "revised", spec_path: path, pr_number: 12, head_sha: sha };
  };

  it("main ends at 064: the spec run is given 065, its result passes the check, the Spec: line is appended and the reservation freed", async () => {
    let w!: ChainWorld;
    w = await chainWorld({ files: { ...repoFiles({ spec: null }), ...prev }, issueBody: "Do the thing.", results: { spec: [specAt(() => w, "specs/065-x/spec.md")] } });
    await w.tick();
    const [run] = runsOf(w, "spec");
    expect(run.input).toMatchObject({ spec_number: "065", adr_number: "0001" });
    expect(w.logs.filter((r) => r.kind === "number-reserved")).toEqual([{ kind: "number-reserved", issue: 7, spec: "065", adr: "0001" }]);
    expect(w.issueBody).toBe("Do the thing.\n\nSpec: specs/065-x/spec.md");
  }, 120_000);

  it("two spec-less issues claimed in one tick with two slots are given 065 and 066, each reserved in its claim, and both free their reservation", async () => {
    let w!: ChainWorld;
    const claimed: Record<number, unknown> = {};
    const plan: Record<string, { issue: number; pr: number; path: string }> = { "spec-7": { issue: 7, pr: 12, path: "specs/065-x/spec.md" }, "spec-8": { issue: 8, pr: 13, path: "specs/066-y/spec.md" } };
    // Whichever run starts first answers for its own branch; each sees both claim files as they stand during the run.
    const answer = (run: StageRun) => {
      const branch = git(run.worktree, "rev-parse", "--abbrev-ref", "HEAD").trim();
      const { issue, pr, path } = plan[branch];
      for (const n of [7, 8]) { try { claimed[issue * 10 + n] = JSON.parse(readFileSync(join(w.paths.claims, `${n}.json`), "utf8")).state.reserved; } catch { /* claim not yet written */ } }
      const sha = w.push(run, { [path]: specOf() }, "spec");
      w.openPr(run, pr, sha, "A new spec");
      return { verdict: "revised", spec_path: path, pr_number: pr, head_sha: sha };
    };
    w = await chainWorld({
      files: { ...repoFiles({ spec: null }), ...prev }, issueBody: "Do the thing.", second: { body: "Do the other thing." }, slots: 2,
      results: { spec: [answer, answer] },
    });
    await w.tick();
    const byBranch = (b: string) => runsOf(w, "spec").find((r) => r.branch === b)!;
    expect(runsOf(w, "spec")).toHaveLength(2);
    expect(byBranch("spec-7").input.spec_number).toBe("065");
    expect(byBranch("spec-8").input.spec_number).toBe("066");
    expect(w.logs.filter((r) => r.kind === "number-reserved").map((r) => [r.issue, r.spec])).toEqual([[7, "065"], [8, "066"]]);
    // During each run its own claim file carried its reservation.
    for (const issue of [7, 8]) {
      const seen = claimed[issue * 10 + issue] as { spec: number };
      expect(seen.spec).toBe(issue === 7 ? 65 : 66);
    }
    expect(w.issueBody).toBe("Do the thing.\n\nSpec: specs/065-x/spec.md");
    expect(w.secondBody).toBe("Do the other thing.\n\nSpec: specs/066-y/spec.md");
    // The Spec: lines hold the numbers now; a claim still on disk no longer reserves them (a finished chain's claim is gone).
    for (const n of [7, 8]) {
      const file = join(w.paths.claims, `${n}.json`);
      if (existsSync(file)) expect(JSON.parse(readFileSync(file, "utf8")).state.reserved.spec).toBeNull();
    }
  }, 120_000);

  it("an open PR not of the scheduler's making holds 065: the spec run is given 066", async () => {
    let w!: ChainWorld;
    w = await chainWorld({ files: { ...repoFiles({ spec: null }), ...prev }, issueBody: "Do the thing.", results: { spec: [specAt(() => w, "specs/066-x/spec.md")] } });
    handPr(w, 30, ["specs/065-hand/spec.md"]);
    await w.tick();
    expect(runsOf(w, "spec")[0].input.spec_number).toBe("066");
    expect(w.issueBody).toBe("Do the thing.\n\nSpec: specs/066-x/spec.md");
  }, 120_000);

  it("a spec_path with another number fails before the Spec: line, and the second attempt is given the reserved number again", async () => {
    let w!: ChainWorld;
    w = await chainWorld({ files: { ...repoFiles({ spec: null }), ...prev }, issueBody: "Do the thing.", results: { spec: [specAt(() => w, "specs/065-x/spec.md"), FAIL] } });
    handPr(w, 30, ["specs/065-hand/spec.md"]);
    await w.tick();
    const [first, second] = runsOf(w, "spec");
    expect(first.input.spec_number).toBe("066");
    expect(second.input.spec_number).toBe("066");
    expect(second.input.history).toContain("spec attempt 1 failed: result: spec number 065 is not the reserved 066");
    expect(w.issueBody).toBe("Do the thing.");
  }, 120_000);

  it("a spec run adding an ADR number another open PR holds fails, naming the PR", async () => {
    let w!: ChainWorld;
    w = await chainWorld({ files: { ...repoFiles({ spec: null }), ...prev }, issueBody: "Do the thing.", results: { spec: [specAt(() => w, "specs/065-x/spec.md", { "docs/decisions/0001-mine.md": "adr\n" }), FAIL] } });
    handPr(w, 31, ["docs/decisions/0001-other.md"]);
    await w.tick();
    const [first, second] = runsOf(w, "spec");
    expect(first.input.adr_number).toBe("0002");
    expect(second.input.history).toContain("spec attempt 1 failed: result: ADR 0001 is held by PR #31");
    expect(w.issueBody).toBe("Do the thing.");
  }, 120_000);

  it("an implement run adding the reserved ADR is handled as today and its reservation is freed", async () => {
    let w!: ChainWorld;
    let reservedDuringReview: unknown = "unset";
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN],
        implement: [a.implement(9, { "a.txt": "pr 9\n", "docs/decisions/0001-mine.md": "# adr\n" })],
        review: [(run: StageRun) => { void run; reservedDuringReview = JSON.parse(readFileSync(join(w.paths.claims, "7.json"), "utf8")).state.reserved; return APPROVE; }],
      },
    });
    await w.tick();
    await expectSettled(w);
    expect(runsOf(w, "implement")[0].input.adr_number).toBe("0001");
    expect(reservedDuringReview).toEqual({ spec: null, adr: null });
    expect(w.mergeRequests).toEqual([9]);
    expect(w.onMain("docs/decisions/0001-mine.md")).toBe("# adr\n");
  }, 120_000);
});
describe("end to end: the chain keeps its work (spec 015 AC-12)", () => {
  it("review postponed three times on a PR whose base moved, then run: no dropped patch (issue #35)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const moveMain = () => {
      writeFileSync(join(w.pair.repo, "main.txt"), "main moved\n");
      git(w.pair.repo, "add", "main.txt");
      git(w.pair.repo, "commit", "-q", "-m", "main moved");
      git(w.pair.repo, "push", "-q", "origin", "main");
    };
    // Main moves on after the PR is opened: every review is prepared with a rebase that moves HEAD.
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); moveMain(); return r; }], review: [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, APPROVE] } });
    const n = network(w);
    await w.tick();
    // Each wait ends when the quota book says the limit resets (spec 013): move the clock past it and tick again.
    for (let i = 0; i < 10 && (await listClaims(w.paths)).length; i++) {
      const until = (await listClaims(w.paths))[0].state.postponedUntil;
      n.offset = Math.max(n.offset, (until ? Date.parse(until) - Date.now() : 0) + 1000);
      await w.tick();
    }
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "review", "review", "review"]);
    expect(w.mergeRequests).toEqual([9]);
    expect(patchesOf(w, "dropped")).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "worktree-synced" && r.dropped)).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "rebase-undone")).toHaveLength(3);
  }, 180_000);

  it("a chain whose GitHub calls fail with EAI_AGAIN for four steps: no chain error, no release, the PR kept, merged (issue #29)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let n!: ReturnType<typeof network>;
    // The network goes down just after implement opened PR 9: the step's PR binding check is the first call to fail.
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); n.down = true; return r; }], review: [APPROVE] } });
    n = network(w);
    await w.tick();
    // Each retry after its backoff (60, 120, 240, 480 s), short of the two-hour alarm.
    for (let i = 0; i < 4; i++) {
      n.offset += 1000_000;
      await w.tick();
    }
    const during = (await listClaims(w.paths))[0];
    expect(during.outage).toMatchObject({ count: 5, alarmed: false });
    expect(during.state.chainFailures).toBeNull();
    n.down = false;
    n.offset += 1000_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(w.mergeRequests).toEqual([9]);
    expect(w.prs.get(9)?.merged).toBe(true);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "stale-branch-dropped" || r.kind === "recovered-commits")).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "stage-result-kept")).toHaveLength(5);
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "transient-outage")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage-over")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
  }, 180_000);

  it("the same chain with a genuine error three times: chain_error and a release, as today", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let n!: ReturnType<typeof network>;
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); n.down = true; n.genuine = true; return r; }] } });
    n = network(w);
    await w.tick();
    for (let i = 0; i < 2; i++) await w.tick();
    expect((await listClaims(w.paths))[0].state.chainFailures?.count).toBe(3);
    // The second and third steps re-checked the recorded implement run (AC-10); implement ran once.
    expect(w.logs.filter((r) => r.kind === "stage-result-kept")).toHaveLength(2);
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    n.down = false;
    const t = await w.tick();
    expect(t.released).toEqual([7]);
    expect(serviceRecords(w).filter((r) => r.kind === "chain-error")).toHaveLength(1);
    expect(serviceRecords(w).find((r) => r.kind === "transient-outage")).toBeUndefined();
    // The release comment carries the genuine error; the issue is claimed again later in the same tick, as today.
    const released = w.comments.filter((c) => c.body.startsWith("Claim released: the scheduler failed on this issue repeatedly."));
    expect(released).toHaveLength(1);
    expect(released[0].body).toContain("Validation Failed");
  }, 180_000);
});
