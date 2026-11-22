import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { CHARTER_REVERT_LINE } from "../src/chain/driver.ts";
import { ledgerOf } from "../src/chain/machine.ts";
import { listClaims } from "../src/state/claims.ts";
import { listPaused } from "../src/state/paused.ts";
import type { Question } from "../src/types.ts";
import { readAgentState } from '../src/standing/state.ts';
import { chainWorld, HOST_REFUSED, type ChainWorld } from "./helpers/e2e-routes.ts";
import { checkedPaths } from "../src/runner/host-space.ts";
import { git } from "./helpers/repo-pair.ts";
import { fileDesignChildren } from "../src/children/scan.ts";
import { loadDesignTree } from "../src/gates/design-tree.ts";
import { BOT, PARENT, CHARTER, specOf, repoFiles, FAIL, PLAN, APPROVE, CHANGES, ask, SEND, agents, expectSettled, inputsOf, runsOf, pausedRecord, rev, asksAfterPushing, kinds, serviceRecords, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-3");

describe("end to end: escalation outcomes (spec 006 AC-28)", () => {
  describe("an incomplete request is sent back for completion (spec 067 AC-5)", () => {
    const request = { type: "credential" as const, name: "FLASH_TOKEN", provider: "vendor", access: ["flash:write"], setup: ["1. Open the vendor console", "2. Create a token"] };
    const noSetup = { ...request, setup: [] as string[] };
    const withRequest = (r: Question["request"]): Question => ({ ...ask("capability", "The flashing tool needs a token this worktree lacks. Can you create one?"), request: r });
    const reason = "a credential request must give setup";
    const logOf = (w: ChainWorld) => readFileSync(w.paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; verdict?: string; reasoning?: string; issue: number }).filter((e) => e.issue === 7);

    it("the code finds the missing field: the stage runs again holding its work, and the completed request is sent", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      const starts: string[] = [];
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN],
          implement: [
            asksAfterPushing(() => w, withRequest(noSetup), held),
            (run: StageRun) => { starts.push(rev(run)); return { escalation: withRequest(request) }; },
            a.implement(9),
          ],
          review: [APPROVE], "question-check": [SEND],
        },
      });
      await w.tick();
      expect(pausedRecord(w)).toMatchObject({ phase: "paused", asking_stage: "implement", question: withRequest(request) });
      expect(ledgerOf(pausedRecord(w).state)).toMatchObject({ incompleteRequests: 1, decideReturns: 0 });
      w.reply("Created it.");
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "question-check", "implement", "review"]);
      expect(inputsOf(w, "implement")[1].history).toContain(`incomplete request: ${reason}`);
      expect(inputsOf(w, "implement")[1].held_work).toContain(held.head);
      expect(inputsOf(w, "implement")[1].decide_input).toBeUndefined();
      expect(starts).toEqual([held.head]);
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(logOf(w).map((e) => e.event)).toEqual(["asked", "checked", "sent", "answered"]);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);

    it("the check finds the missing request: it returns incomplete and the stage asks again with one", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN],
          implement: [asksAfterPushing(() => w, ask("capability", "The flashing tool needs a token. Can you create one?"), held), { escalation: withRequest(request) }, a.implement(9)],
          review: [APPROVE],
          "question-check": [{ verdict: "incomplete", reasoning: "a credential request must give name, provider, access, setup", findings: [] }, SEND],
        },
      });
      await w.tick();
      w.reply("Created it.");
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "implement", "question-check", "implement", "review"]);
      expect(inputsOf(w, "implement")[1].history).toContain("incomplete request: a credential request must give name, provider, access, setup");
      expect(inputsOf(w, "implement")[1].decide_input).toBeUndefined();
      expect(logOf(w).map((e) => (e.event === "checked" ? `checked ${e.verdict}` : e.event))).toEqual(["asked", "checked incomplete", "asked", "checked send", "sent", "answered"]);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);

    it("a second incomplete request is a failed implement attempt, retried under spec 006's rule", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      w = await chainWorld({
        files: repoFiles(),
        results: { plan: [PLAN], implement: [{ escalation: withRequest(noSetup) }, { escalation: withRequest(noSetup) }, a.implement(9)], review: [APPROVE] },
      });
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "implement", "review"]);
      // The rerun of the first incomplete request restarts the stage's attempt count, so the failed attempt is 1 here.
      expect(inputsOf(w, "implement")[2].history).toContain(`implement attempt 1 failed: result: invalid: ${reason}`);
      expect(w.adapter.ran).not.toContain("question-check");
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);
  });

  it("abandonment (spec 006 AC-28)", async () => {
    const w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN, PLAN], implement: [FAIL, FAIL, FAIL, FAIL, FAIL], spec: [FAIL, FAIL, FAIL] },
    });
    await w.tick();
    await expectSettled(w);

    // Rescue, re-plan, spec revision, the spec-track rescue: every bound used up (AC-1 to AC-5).
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "implement", "plan", "implement", "implement", "spec", "spec", "spec"]);
    expect(runsOf(w, "spec")[0].input.mode).toBe("revise");
    expect(runsOf(w, "spec").at(-1)!.model).toBe(w.cfg.rescue_model);
    // AC-5: the label before the claim goes; one informational comment with no mention; the issue stays open.
    expect(w.labelLog).toEqual(["+in-progress", "+abandoned", "-in-progress"]);
    expect(w.comments).toHaveLength(1);
    expect(w.comments[0].body).toMatch(/^### Issue abandoned by the scheduler\n/);
    expect(w.comments[0].body).not.toContain("@");
    expect(w.comments[0].body).toContain("Run records, in the scheduler state directory:");
    expect(w.issueOpen).toBe(true);
    expect(w.writes().filter((c) => c.startsWith("PATCH /repos/o/r/issues/7"))).toEqual([]);
    const findings = readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ issue: 7, run_id: "escalation", finding: { what: "issue abandoned after the escalation path" } });
    expect(w.notifications.map((n) => n.gate)).toEqual(["abandoned"]);
    expect(w.mergeRequests).toEqual([]);
    expect(existsSync(join(w.paths.worktrees, "issue-7"))).toBe(false);
    // spec 094 AC-1: the constructor's default emitEvent delivers the abandonment to the filer (the queued finding's finding_queued entry is not tested here).
    const filer = (await readAgentState(w.paths, "findings-filer"))!;
    expect(filer.pending_events.filter((e) => e.event === "issue_abandoned")).toEqual([{ event: "issue_abandoned", payload: { issue: 7 }, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }]);
    expect((await readAgentState(w.paths, "infra-health"))!.pending_events).toEqual([]);
  }, 120_000);

  it("security finding fixed then merged (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const plan = { ...PLAN, tasks: [{ id: "T1", description: "d", files: ["a.txt", "agents/x.md"] }] };
    const finding = { criterion: "rule:no-secrets", file: "agents/x.md", line: 1, scenario: "the prompt prints the token" };
    w = await chainWorld({
      files: repoFiles({ spec: specOf(["agents/x.md"]) }),
      results: {
        plan: [plan],
        implement: [a.implement(9, { "a.txt": "pr 9\n", "agents/x.md": "print the token\n" })],
        // C5: each round runs the normal review, then the security review. AC-9: an approval that carries a
        // security finding still goes to the fix loop.
        review: [APPROVE, { verdict: "approve", findings_on_pr: [finding], declined_to_judge: [] }, APPROVE, APPROVE],
        fix: [a.fix({ "agents/x.md": "never print the token\n" })],
      },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "review", "fix", "review", "review"]);
    expect(runsOf(w, "review").map((r) => r.profile)).toEqual(["backend", "security", "backend", "security"]);
    expect(inputsOf(w, "fix")[0].fix_input).toContain("agents/x.md:1 the prompt prints the token");
    expect(w.mergeRequests).toEqual([9]);
    expect(w.onMain("agents/x.md")).toBe("never print the token\n");
    // No security-review or needs-human label, on the issue or on the PR.
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 120_000);

  it("spec PR touching the charter (AC-22) (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const keepsCharter = (n: number) => a.fix({ "docs/charter.md": `${CHARTER}\nAmended by fix ${n}.\n`, "specs/010-thing/notes.md": `fix ${n}\n` });
    // AC-19: no spec on main, so the chain starts at the spec stage in write mode.
    w = await chainWorld({
      files: repoFiles({ spec: null }),
      results: {
        spec: [a.spec(12, { "specs/010-thing/spec.md": specOf(), "docs/charter.md": `${CHARTER}\nAmended.\n` })],
        fix: [keepsCharter(1), keepsCharter(2)],
      },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["spec", "fix", "fix"]);
    expect(runsOf(w, "spec")[0].input.mode).toBe("write");
    // One fix with the violation as input, the charter revert line first; then the spec-track rescue fix.
    const [fix1, rescue] = runsOf(w, "fix");
    expect(fix1.input.fix_input?.split("\n")[0]).toBe(CHARTER_REVERT_LINE);
    expect(fix1.input.fix_input).toContain("docs/charter.md: the charter is never changed by a spec PR");
    expect([fix1.branch, fix1.profile]).toEqual(["spec-7", "spec"]);
    expect(rescue.model).toBe(w.cfg.rescue_model);
    // Abandoned: PR 12 closed and spec-7 deleted, never a merge request, the charter on main unchanged.
    expect(w.labelLog).toEqual(["+in-progress", "+abandoned", "-in-progress"]);
    expect(w.writes()).toContain("PATCH /repos/o/r/pulls/12");
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(w.writes().filter((c) => /^PUT \/repos\/o\/r\/pulls\/\d+\/merge$/.test(c))).toEqual([]);
    expect(w.mergeRequests).toEqual([]);
    expect(w.onMain("docs/charter.md")).toBe(CHARTER);
    expect(w.comments.map((c) => c.body.split("\n")[0])).toEqual(["### Issue abandoned by the scheduler"]);
  }, 120_000);
});
// Spec 059 AC-6: a full volume postpones runs; it is not the work's failure.

describe("end to end: a full volume postpones runs (spec 059 AC-6)", () => {
  const ROOMY = async (_path: string) => ({ bytes: 20 * 2 ** 30, inodes: 1_000_000 });
  // Only the chain's worktree volume is full: a full temp or state volume would also raise the scheduler's own sweep alarm (spec 064 AC-2).
  const LOW = async (path: string) => (path.includes("/worktrees/") ? { bytes: 100 * 2 ** 20, inodes: 1_000_000 } : ROOMY(path));
  /** A clock the test moves past each retry_at. */
  const clock = (w: ChainWorld) => {
    const c = { offset: 0 };
    w.deps.now = () => new Date(Date.now() + c.offset);
    return c;
  };

  it("a spec-track chain waits three ticks on a full temp volume, then runs with its bounds untouched", async () => {
    let w!: ChainWorld;
    let reader = LOW;
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles({ spec: null }), freeSpace: (path) => reader(path),
      results: { spec: [a.spec(12, { "specs/010-thing/spec.md": specOf() })], review: [APPROVE] },
    });
    const c = clock(w);
    for (let i = 0; i < 3; i++) {
      await w.tick();
      c.offset += 1000_000;
    }
    const during = (await listClaims(w.paths))[0];
    expect(during.outage).toMatchObject({ count: 3, alarmed: true });
    expect(during.outage?.retry_at).toBeTruthy();
    expect(w.adapter.ran).toEqual([]);
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "transient-outage")).toEqual([expect.objectContaining({ issue: 7, cause: "ENOSPC" })]);
    expect(records.filter((r) => r.kind === "transient-outage-alarm")).toHaveLength(1);
    expect(w.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    expect(w.notifications.find((n) => n.gate === "infra")?.text).toContain(checkedPaths(w.paths, during.worktree)[2]);
    // spec 094 AC-3: the alarm reaches infra health through the constructor's default emitEvent.
    expect((await readAgentState(w.paths, "infra-health"))!.pending_events.filter((e) => e.event === "infra_alarm")).toEqual([expect.objectContaining({ event: "infra_alarm", payload: expect.objectContaining({ kind: "disk_full", issue: 7, cause: "ENOSPC" }) })]);
    expect(kinds(w, "stage")).toEqual([]);
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
    const before = ledgerOf(during.state);
    expect(before).toMatchObject({ specRescues: 0, history: [] });

    reader = ROOMY;
    await w.tick();
    expect(w.adapter.ran.slice(0, 2)).toEqual(["spec", "review"]);
    expect(kinds(w, "stage")[0]).toMatchObject({ stage: "spec", outcome: "ok" });
    expect(kinds(w, "stage-host-refused")).toEqual([]);
    expect(serviceRecords(w).filter((r) => r.kind === "transient-outage-over")).toHaveLength(1);
  }, 180_000);

  it("a rescue fix whose every shell command was refused is not the rescue: it runs again after the wait", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [a.implement(9)], review: [CHANGES, APPROVE, APPROVE], fix: [FAIL, HOST_REFUSED, a.fix({ "a.txt": "fixed\n" })], "question-check": [SEND] },
    });
    const c = clock(w);
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "fix", "fix"]);
    const claim = (await listClaims(w.paths))[0];
    expect(claim.state).toMatchObject({ stage: "fix", rescueRun: true, rescues: 1 });
    expect(claim.state.history.filter((h) => /^fix attempt \d+ failed/.test(h))).toHaveLength(1);
    expect(w.adapter.ran).not.toContain("question-check");
    expect(await listPaused(w.paths)).toEqual([]);
    expect(kinds(w, "stage-host-refused")).toEqual([expect.objectContaining({ issue: 7, stage: "fix", cause: "ENOSPC" })]);
    expect(serviceRecords(w).filter((r) => r.kind === "transient-outage")).toEqual([expect.objectContaining({ cause: "ENOSPC" })]);

    c.offset += 1000_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "fix", "fix", "fix", "review"]);
    expect(runsOf(w, "fix").at(-1)!.model).toBe(w.cfg.rescue_model);
    expect(w.mergeRequests).toEqual([9]);
  }, 180_000);
});
// ---------------------------------------------------------------------------------------------------------------
// Spec 031: a merged design files issues for its children.

describe("end to end: a design's planned children (spec 031)", () => {
  const KIDS = "docs/designs/kids.md";
  const plannedA = "- planned: a\n  title: Build part a\n  brief: Part a of the design, and nothing of part b.\n";
  const plannedB = "- planned: b\n  title: Build part b\n  brief: Part b of the design.\n  after: a\n";
  const kids = (children: string) => `# Kids\n\nParent: ${PARENT}\n\n## Children\n\n${children}`;
  const productSpec = (children: string) => `# Product spec\n\nParent: docs/charter.md\n\n## Children\n\n${children}`;

  it("files two children when main has the design; the unblocked one runs the spec stage and the implementation, with no second issue (AC-3, AC-4, AC-8)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const childSpec = specOf().replace(`Parent: ${PARENT}`, `Parent: ${KIDS}`);
    w = await chainWorld({
      // Main ends at spec 010, so the scheduler reserves 011 for the child's spec (spec 065).
      files: { "a.txt": "a\n", "docs/charter.md": CHARTER, [PARENT]: productSpec(`- \`${KIDS}\`\n`), [KIDS]: kids(plannedA + plannedB), "specs/010-earlier/README.md": "An earlier spec.\n" },
      issueFromScan: true,
      results: {
        spec: [(run: StageRun) => {
          const sha = w.push(run, { "specs/011-a/spec.md": childSpec, [KIDS]: kids("- `specs/011-a/spec.md` (issue #7)\n" + plannedB) }, "spec");
          w.openPr(run, 12, sha, "Refs #7");
          return { verdict: "revised", spec_path: "specs/011-a/spec.md", pr_number: 12, head_sha: sha };
        }],
        plan: [PLAN],
        implement: [a.implement(13)],
        review: [APPROVE, APPROVE],
      },
    });
    await w.tick();
    await expectSettled(w);

    // AC-4, AC-5: two App-authored validated issues, the second blocked by after:.
    expect(w.filed.map((f) => [f.number, f.title, f.author])).toEqual([[7, "Build part a", BOT.login], [8, "Build part b", BOT.login]]);
    expect(w.filed[0].labels).toEqual(["class:product", "validated"]);
    expect(w.filed[1].labels).toEqual(["class:product", "validated", "blocked"]);
    expect(w.filed[0].body).toContain(`<!-- panelator-child:${KIDS}:a -->`);
    expect(w.filed[1].body).toContain("After: #7");
    expect(w.prComments.map((c) => c.body)).toEqual([expect.stringContaining("Blocked until #7 are done")]);
    // AC-8: no Spec: line, so the spec stage runs in write mode and appends it; then the one chain carries the implementation.
    expect(w.adapter.ran).toEqual(["spec", "review", "plan", "implement", "review"]);
    expect(runsOf(w, "spec")[0].input.mode).toBe("write");
    expect(w.issueBody).toContain("Spec: specs/011-a/spec.md");
    expect(w.mergeRequests).toEqual([12, 13]);
    expect(w.issueOpen).toBe(false);
    expect(w.filed).toHaveLength(2); // no issue was filed for the implementation
    expect(w.writes().filter((c) => c === "POST /repos/o/r/issues")).toHaveLength(2);
  }, 120_000);

  it("a spec stage that authors a sub-design with a README.md pointer: merged, the issue closed done, then the scan files the children (AC-3, AC-9)", async () => {
    let w!: ChainWorld;
    w = await chainWorld({
      files: { "a.txt": "a\n", "docs/charter.md": CHARTER, [PARENT]: productSpec("") },
      issueBody: "Spec: specs/011-split/spec.md",
      results: {
        spec: [(run: StageRun) => {
          const sha = w.push(run, {
            [KIDS]: kids(plannedA + plannedB),
            "specs/011-split/README.md": "# 011. Split\n\nThis spec was split and has no `spec.md`; see docs/designs/kids.md.\n",
            [PARENT]: productSpec(`- \`${KIDS}\`\n`),
          }, "spec");
          w.openPr(run, 12, sha, "Refs #7");
          return { verdict: "revised", spec_path: "specs/011-split/spec.md", pr_number: 12, head_sha: sha };
        }],
        // the PR edits a top design, a sensitive path: the spec review, then the security review
        review: [APPROVE, APPROVE],
      },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["spec", "review", "review"]);
    expect(w.mergeRequests).toEqual([12]);
    expect(w.issueOpen).toBe(false);
    expect(w.comments.map((c) => c.body).join("\n")).toMatch(/docs\/designs\/kids.md.*filed as issues by the scheduler/s);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.writes().indexOf("POST /repos/o/r/issues/7/comments")).toBeLessThan(w.writes().indexOf("PATCH /repos/o/r/issues/7"));
    expect(readFileSync(join(w.paths.root, "merges.jsonl"), "utf8")).toMatch(/"issue":7.*"cls":"debt","work":"system"/);
    expect(w.filed).toEqual([]);

    // The scan that runs when main moves (the loop's call, over the fast-forwarded checkout) files both children.
    git(w.pair.repo, "fetch", "-q", "origin");
    git(w.pair.repo, "merge", "-q", "--ff-only", "origin/main");
    const result = await fileDesignChildren({
      gh: w.deps.gh, paths: w.paths, botLogin: BOT.login, now: () => new Date(), log: (r) => w.logs.push(r), designs: loadDesignTree(w.pair.repo),
    });
    expect(result.filed).toEqual([8, 9]);
    expect(w.filed.map((f) => f.labels)).toEqual([["class:product", "validated"], ["class:product", "validated", "blocked"]]);
    // And a second scan files nothing.
    const again = await fileDesignChildren({
      gh: w.deps.gh, paths: w.paths, botLogin: BOT.login, now: () => new Date(), log: (r) => w.logs.push(r), designs: loadDesignTree(w.pair.repo),
    });
    expect(again.filed).toEqual([]);
  }, 120_000);
});
