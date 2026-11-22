import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { chainWorld, type ChainWorld } from "./helpers/e2e-routes.ts";
import { specOf, repoFiles, FAIL, PLAN, APPROVE, ask, SEND, agents, expectSettled, inputsOf, runsOf, patchesOf, rev, asksAfterPushing, kinds, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-4");

describe("end to end: escalation outcomes (spec 006 AC-28)", () => {
  describe("a stage that asks a question keeps its work (spec 011 AC-10)", () => {
    it("a capability question after a push: no recovered commits, no dropped branch, the resumed run starts at the held head", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      const starts: string[] = [];
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN], implement: [asksAfterPushing(() => w, ask("capability", "Can you add the flashing token?"), held), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
          review: [APPROVE], "question-check": [SEND],
        },
      });
      await w.tick();
      w.reply("Added it.");
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "implement", "review"]);
      expect(kinds(w, "recovered-commits")).toEqual([]);
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(kinds(w, "held-work")).toMatchObject([{ issue: 7, stage: "implement", branch: "issue-7", head: held.head, pushed: true, prs: [] }]);
      expect(kinds(w, "held-work-kept")).toEqual([{ kind: "held-work-kept", issue: 7, branch: "issue-7", head: held.head }, { kind: "held-work-kept", issue: 7, branch: "issue-7", head: held.head }]);
      expect(patchesOf(w, "held")).toHaveLength(1);
      expect(starts).toEqual([held.head]);
      expect(inputsOf(w, "implement")[0].held_work).toBeUndefined();
      expect(inputsOf(w, "implement")[1].held_work).toContain(held.head);
      expect(inputsOf(w, "question-check")[0].held_work).toBeUndefined();
      expect(w.writes().filter((c) => c.startsWith("PATCH /repos/o/r/pulls") || c.startsWith("DELETE /repos/o/r/git/refs"))).toEqual([]);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);

    it("with a PR opened before the question: it is not closed, and the resumed implement reports it", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN], implement: [asksAfterPushing(() => w, ask("capability", "Can you add the flashing token?"), held, true), a.implement(9, { "a.txt": "pr 9\n" })],
          review: [APPROVE], "question-check": [SEND],
        },
      });
      await w.tick();
      w.reply("Added it.");
      await w.tick();
      await expectSettled(w);

      expect(kinds(w, "held-work")).toMatchObject([{ pushed: true, prs: [9] }]);
      expect(inputsOf(w, "implement")[1].held_work).toContain("#9");
      expect(w.writes().filter((c) => c.startsWith("PATCH /repos/o/r/pulls"))).toEqual([]);
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);

    it("a technical question: the spec PR records the answer and merges, then plan and implement continue from the held head", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      const starts: string[] = [];
      const record = (run: StageRun) => {
        const mark = `(maintainer answer, question #${w.questions()[0].id})`;
        return a.spec(12, { "specs/010-thing/spec.md": specOf().replace("Do a thing.", `Do a thing, in RAM ${mark}.`) })(run);
      };
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN, PLAN],
          implement: [asksAfterPushing(() => w, ask("technical", "Cache the frames in RAM or in flash?"), held), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
          review: [APPROVE, APPROVE], "question-check": [SEND], spec: [record],
        },
      });
      await w.tick();
      w.reply("RAM.");
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "spec", "review", "plan", "implement", "review"]);
      expect(runsOf(w, "spec")[0]).toMatchObject({ branch: "spec-7" });
      expect(runsOf(w, "spec")[0].input.mode).toBe("record");
      expect(runsOf(w, "spec")[0].input.held_work).toBeUndefined();
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(kinds(w, "recovered-commits")).toEqual([]);
      expect(inputsOf(w, "plan")[1].held_work).toContain(held.head);
      expect(starts).toEqual([held.head]);
      expect(runsOf(w, "implement")[1].branch).toBe("issue-7");
      expect(w.mergeRequests).toEqual([12, 9]);
    }, 120_000);

    describe("the spec stage asks while recording an answer (spec 040 AC-8)", () => {
      for (const kind of ["capability", "other"] as const) {
        it(`a ${kind} question from the spec stage: issue-7's work is kept and continued after the spec PR merges`, async () => {
          let w!: ChainWorld;
          const a = agents(() => w);
          const held = { head: "" };
          const recording = { head: "" };
          const starts: string[] = [];
          const specHeads: string[] = [];
          const marks = () => w.questions().map((q) => `(maintainer answer, question #${q.id})`).join(", ");
          const asks = (run: StageRun) => {
            recording.head = w.push(run, { "specs/010-thing/spec.md": specOf().replace("Do a thing.", `Do a thing, half written ${marks()}.`) }, "recording");
            return { verdict: "question", question: ask(kind, "Does the board have a second flash chip?") };
          };
          const revises = (run: StageRun) => {
            specHeads.push(rev(run));
            return a.spec(12, { "specs/010-thing/spec.md": specOf().replace("Do a thing.", `Do a thing, in RAM ${marks()}.`) })(run);
          };
          w = await chainWorld({
            files: repoFiles(),
            results: {
              plan: [PLAN, PLAN],
              implement: [asksAfterPushing(() => w, ask("technical", "Cache the frames in RAM or in flash?"), held), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
              review: [APPROVE, APPROVE], "question-check": [SEND, SEND], spec: [asks, revises],
            },
          });
          await w.tick();
          w.reply("RAM.");
          await w.tick();
          if (kind === "capability") {
            w.reply("Yes, it has one.");
            await w.tick();
          }
          await expectSettled(w);

          const ran = kind === "capability"
            ? ["plan", "implement", "question-check", "spec", "question-check", "spec", "review", "plan", "implement", "review"]
            : ["plan", "implement", "question-check", "spec", "spec", "review", "plan", "implement", "review"];
          expect(w.adapter.ran).toEqual(ran);
          const resumed = inputsOf(w, "spec")[1].held_work as string;
          expect(specHeads).toEqual([recording.head]);
          expect(resumed).toContain("spec-7");
          expect(resumed).toContain(recording.head);
          expect(resumed).not.toContain("issue-7");
          expect(kinds(w, "held-work").map((r) => r.branch)).toEqual(["issue-7", "spec-7"]);
          expect(kinds(w, "stale-branch-dropped")).toEqual([]);
          expect(kinds(w, "recovered-commits")).toEqual([]);
          expect(inputsOf(w, "plan")[1].held_work).toContain("issue-7");
          expect(inputsOf(w, "plan")[1].held_work).toContain(held.head);
          expect(starts).toEqual([held.head]);
          expect(runsOf(w, "implement")[1].branch).toBe("issue-7");
          expect(w.writes()).not.toContain("DELETE /repos/o/r/git/refs/heads/issue-7");
          expect(w.mergeRequests).toEqual([12, 9]);
        }, 180_000);
      }
    });

    describe("a spec-track rescue while recording an answer keeps issue-7's work (spec 085 AC-5)", () => {
      for (const how of ["the recording spec stage fails twice", "the question check fails twice"] as const) {
        it(`${how}: issue-7's work is kept and continued after the rescued spec PR merges`, async () => {
          let w!: ChainWorld;
          const a = agents(() => w);
          const held = { head: "" };
          const starts: string[] = [];
          const marks = () => w.questions().map((q) => `(maintainer answer, question #${q.id})`).join(", ");
          const asks = (run: StageRun) => {
            w.push(run, { "specs/010-thing/spec.md": specOf().replace("Do a thing.", `Do a thing, half written ${marks()}.`) }, "recording");
            return { verdict: "question", question: ask("capability", "Does the board have a second flash chip?") };
          };
          const revises = (run: StageRun) => a.spec(12, { "specs/010-thing/spec.md": specOf().replace("Do a thing.", `Do a thing, in RAM ${marks()}.`) })(run);
          const failing = how === "the recording spec stage fails twice";
          w = await chainWorld({
            files: repoFiles(),
            results: {
              plan: [PLAN, PLAN],
              implement: [asksAfterPushing(() => w, ask("technical", "Cache the frames in RAM or in flash?"), held), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
              review: [APPROVE, APPROVE],
              "question-check": failing ? [SEND] : [SEND, FAIL, FAIL],
              spec: failing ? [FAIL, FAIL, revises] : [asks, revises],
            },
          });
          await w.tick();
          w.reply("RAM.");
          await w.tick();
          await expectSettled(w);

          expect(w.adapter.ran).toEqual(failing
            ? ["plan", "implement", "question-check", "spec", "spec", "spec", "review", "plan", "implement", "review"]
            : ["plan", "implement", "question-check", "spec", "question-check", "question-check", "spec", "review", "plan", "implement", "review"]);
          expect(runsOf(w, "spec").filter((r) => r.model === w.cfg.rescue_model)).toHaveLength(1);
          expect(kinds(w, "stale-branch-dropped").filter((r) => r.branch === "issue-7")).toEqual([]);
          expect(kinds(w, "recovered-commits").filter((r) => r.branch === "issue-7")).toEqual([]);
          for (const k of kinds(w, "held-work-kept").filter((r) => r.branch === "issue-7")) expect(k.head).toBe(held.head);
          expect(kinds(w, "held-work-kept").some((r) => r.branch === "issue-7")).toBe(true);
          expect(inputsOf(w, "plan")[1].held_work).toContain("issue-7");
          expect(inputsOf(w, "plan")[1].held_work).toContain(held.head);
          expect(starts).toEqual([held.head]);
          expect(runsOf(w, "implement")[1].branch).toBe("issue-7");
          expect(w.writes()).not.toContain("DELETE /repos/o/r/git/refs/heads/issue-7");
          expect(w.mergeRequests).toEqual([12, 9]);
        }, 180_000);
      }
    });

    it("decide_yourself after a question: the stage in decide mode continues from the held head", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      const starts: string[] = [];
      const reasoning = "The spec settles it: cache in RAM.";
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN], implement: [asksAfterPushing(() => w, ask("technical", "Cache in RAM or flash?"), held), a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run)))],
          review: [APPROVE], "question-check": [{ verdict: "decide_yourself", reasoning }],
        },
      });
      await w.tick();
      await expectSettled(w);

      expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "implement", "review"]);
      expect(inputsOf(w, "implement")[1].decide_input).toBe(reasoning);
      expect(inputsOf(w, "implement")[1].held_work).toContain(held.head);
      expect(starts).toEqual([held.head]);
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);

    it("a question whose resumed stage then stops: the retry continues from the held head (spec 011 AC-10 as amended by spec 053)", async () => {
      let w!: ChainWorld;
      const a = agents(() => w);
      const held = { head: "" };
      const starts: string[] = [];
      w = await chainWorld({
        files: repoFiles(),
        results: {
          plan: [PLAN],
          implement: [
            asksAfterPushing(() => w, ask("capability", "Can you add the flashing token?"), held),
            (run: StageRun) => { starts.push(rev(run)); return undefined; },
            a.implement(9, { "a.txt": "pr 9\n" }, (run) => starts.push(rev(run))),
          ],
          review: [APPROVE], "question-check": [SEND],
        },
      });
      await w.tick();
      w.reply("Added it.");
      await w.tick();
      await expectSettled(w);

      expect(starts).toEqual([held.head, held.head]);
      const kept = kinds(w, "held-work-kept");
      expect(kept.length).toBeGreaterThanOrEqual(2);
      for (const k of kept) expect(k).toMatchObject({ branch: "issue-7", head: held.head });
      expect(kinds(w, "stale-branch-dropped")).toEqual([]);
      expect(kinds(w, "recovered-commits")).toEqual([]);
      expect(inputsOf(w, "implement")[2].held_work).toContain(held.head);
      expect(w.mergeRequests).toEqual([9]);
    }, 120_000);
  });
});
