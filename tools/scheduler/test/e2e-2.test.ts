import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StageRun } from "../src/adapters/types.ts";
import { ledgerOf } from "../src/chain/machine.ts";
import { listClaims } from "../src/state/claims.ts";
import { readAgentState, writeAgentState } from '../src/standing/state.ts';
import { chainWorld, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git } from "./helpers/repo-pair.ts";
import { specOf, repoFiles, FAIL, PLAN, APPROVE, CHANGES, ask, ESCALATE, SEND, agents, expectSettled, inputsOf, runsOf, patchesOf, pausedRecord, QUESTION_MARKER, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-2");

describe("end to end: escalation outcomes (spec 006 AC-28)", () => {
  it("rescue then merge (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), results: { plan: [FAIL, FAIL, PLAN], implement: [a.implement(9)], review: [APPROVE] } });
    expect((await w.tick()).claimed).toEqual([7]);
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "plan", "plan", "implement", "review"]);
    // AC-1: the third plan is the rescue, on the rescue model.
    const planModel = runsOf(w, "plan")[0].model;
    expect(planModel).not.toBe(w.cfg.rescue_model);
    expect(runsOf(w, "plan").map((r) => r.model)).toEqual([planModel, planModel, w.cfg.rescue_model]);
    expect(inputsOf(w, "plan")[2].history).toContain("plan attempt 2 failed");
    expect(w.mergeRequests).toEqual([9]);
    expect(w.issueOpen).toBe(false);
    expect(w.onMain("a.txt")).toBe("pr 9\n");
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 120_000);

  it("re-plan then merge (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    // The second bound needs a PR to close (AC-2): a fix fails (AC-1's "a fix run has failed"), then its rescue fails.
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN, PLAN], implement: [a.implement(9), a.implement(10)], review: [CHANGES, APPROVE, APPROVE], fix: [FAIL, FAIL] },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "fix", "fix", "plan", "implement", "review"]);
    expect(runsOf(w, "fix").map((r) => r.model).at(-1)).toBe(w.cfg.rescue_model);
    // AC-2: PR 9 closed with a comment saying why, its branch deleted on GitHub and saved as a patch.
    const writes = w.writes();
    expect(writes).toContain("PATCH /repos/o/r/pulls/9");
    expect(writes).toContain("DELETE /repos/o/r/git/refs/heads/issue-7");
    expect(writes.indexOf("PATCH /repos/o/r/pulls/9")).toBeLessThan(writes.indexOf("DELETE /repos/o/r/git/refs/heads/issue-7"));
    expect(w.gh.calls.find((c) => c.method === "PATCH" && c.url === "/repos/o/r/pulls/9")?.body).toMatchObject({ state: "closed" });
    expect(w.prComments).toEqual([{ pr: 9, body: expect.stringMatching(/^Closed by the scheduler to re-plan: /) }]);
    const closed = patchesOf(w, "closed-pr");
    expect(closed).toHaveLength(1);
    expect(readFileSync(join(w.paths.patches, closed[0]), "utf8")).toContain("+pr 9");
    // The new implement started on a fresh issue-7 from origin/main and opened PR 10, which merged.
    expect(runsOf(w, "implement").map((r) => r.branch)).toEqual(["issue-7", "issue-7"]);
    expect(w.mergeRequests).toEqual([10]);
    expect(w.onMain("a.txt")).toBe("pr 10\n");
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 120_000);

  it("spec revision then merge (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const revised = specOf().replace("Do a thing.", "Do a thing, in one pass.");
    // Review focus 7: the first implement after the spec PR merges is on issue-7, with spec-7 gone locally.
    const afterSpecMerge = (run: StageRun) => {
      expect(git(run.worktree, "branch", "--list", "spec-7").trim()).toBe("");
    };
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN, PLAN, PLAN],
        implement: [a.implement(9), FAIL, FAIL, a.implement(13, { "a.txt": "pr 13\n" }, afterSpecMerge)],
        review: [CHANGES, APPROVE, APPROVE],
        fix: [FAIL, FAIL],
        spec: [a.spec(12, { "specs/010-thing/spec.md": revised })],
      },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "fix", "fix", "plan", "implement", "implement", "spec", "review", "plan", "implement", "review"]);
    // AC-3: the spec stage in revise mode, on spec-7, with the history as input.
    const [specRun] = runsOf(w, "spec");
    expect(specRun.branch).toBe("spec-7");
    expect(specRun.input.mode).toBe("revise");
    expect(specRun.input.history).toContain("implement attempt 2 failed");
    // AC-4: spec PR 12 verified, reviewed with the spec profile, merged, spec-7 deleted.
    expect(runsOf(w, "review").map((r) => [r.branch, r.profile])).toEqual([["issue-7", "backend"], ["spec-7", "spec"], ["issue-7", "backend"]]);
    expect(runsOf(w, "review")[1].input.pr?.number).toBe(12);
    expect(w.mergeRequests).toEqual([12, 13]);
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/spec-7");
    expect(w.writes().indexOf("PUT /repos/o/r/pulls/12/merge")).toBeLessThan(w.writes().indexOf("DELETE /repos/o/r/git/refs/heads/spec-7"));
    expect(w.onMain("specs/010-thing/spec.md")).toBe(revised);
    // Then plan and implement on issue-7, merged.
    expect(runsOf(w, "plan").at(-1)!.input.spec).toBe(revised);
    expect(runsOf(w, "implement").at(-1)!.branch).toBe("issue-7");
    expect(w.prs.get(13)!.head).toBe("issue-7");
    expect(w.onMain("a.txt")).toBe("pr 13\n");
    expect(w.issueOpen).toBe(false);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 120_000);

  it("question paused, answered, recorded, merged (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const q = ask("technical", "Cache the frames in RAM or in flash?");
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [a.implement(9)], review: [ESCALATE(q), APPROVE], "question-check": [SEND], fix: [a.adr()] },
    });
    // spec 094 AC-4: a paused test-only subscriber keeps the events no built-in agent subscribes to.
    w.deps.registry!.watcher = { ...w.deps.registry!["action-audit"], name: "watcher", trigger: { events: ["merge", "maintainer_reply"] } };
    await writeAgentState(w.paths, "watcher", { last_run: null, next_run: null, pending_events: [], paused: true, paused_by: "maintainer", failures: 0 });
    await w.tick();
    // AC-13: paused, with the question on the issue.
    const rec = pausedRecord(w);
    expect(rec).toMatchObject({ phase: "paused", asking_stage: "review", question: q });
    expect(await listClaims(w.paths)).toEqual([]);
    const [question] = w.questions();
    expect(w.comments).toEqual([question]);
    expect(question.body.split("\n").slice(0, 2)).toEqual(["### Question for the maintainer", "@adam26davidson"]);
    expect(question.body).toContain(q.question);
    expect(QUESTION_MARKER.exec(question.body)?.[1]).toBe(rec.nonce);
    expect(rec.question_comment_id).toBe(question.id);

    w.reply("Option 1: RAM.");
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "question-check", "fix", "review"]);
    // AC-18: the fix records the answer as an ADR; its input carries the answer.
    expect(inputsOf(w, "fix")[0].fix_input).toContain("Answer: Option 1: RAM.");
    expect(inputsOf(w, "fix")[0].fix_input).toContain(`(maintainer answer, question #${question.id})`);
    expect(inputsOf(w, "review")[1].answered_questions).toContain(`#${question.id}: verified`);
    expect(w.mergeRequests).toEqual([9]);
    expect(w.onMain("docs/decisions/0001-x.md")).toContain(`(maintainer answer, question #${question.id})`);
    expect(w.labelLog).toEqual(["+in-progress", "+needs-decision", "-in-progress", "+in-progress", "-needs-decision", "-in-progress"]);
    expect(w.comments.map((c) => c.author)).toEqual(["panelator-pipeline[bot]", "adam26davidson"]);
    expect(readFileSync(w.paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).event)).toEqual(["asked", "checked", "sent", "answered"]);
    expect((await readAgentState(w.paths, "watcher"))!.pending_events).toEqual([
      { event: "maintainer_reply", payload: { issue: 7, question_id: question.id }, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
      { event: "merge", payload: { issue: 7, pr: 9, sha: expect.stringMatching(/^[0-9a-f]{40}$/) }, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
  }, 120_000);

  it("a reply that asks back, a follow-up, recorded, merged (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const q = ask("technical", "Cache the frames in RAM or in flash?");
    // C2: a follow-up says so and quotes the part of the reply it answers.
    const followUp = { ...ask("technical", "Option 2 costs 40 KB of RAM against 16 KB for option 1. Which one?"), follow_up: true, reply_quote: "what does option 2 cost in RAM?" };
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [a.implement(9)], review: [ESCALATE(q), APPROVE], "question-check": [SEND], fix: [{ escalation: followUp }, a.adr()] },
    });
    await w.tick();
    const first = pausedRecord(w);
    w.reply("what does option 2 cost in RAM?");
    await w.tick();
    // AC-15: the resumed fix asked back; the issue paused again without a second question check.
    const second = pausedRecord(w);
    expect(second).toMatchObject({ phase: "paused", asking_stage: "fix", question: followUp });
    // No bound counted: the ledger only holds the first answer, not yet recorded (T4).
    expect({ ...ledgerOf(second.state), pendingAnswer: null }).toEqual(ledgerOf(first.state));
    expect(second.state.fixes).toBe(first.state.fixes);
    expect(second.state.decideReturns).toBe(0);
    expect(second.state.history.filter((h) => h.includes("failed"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(w.paths.escalations, "7.json"), "utf8")).pendingAnswer).toMatchObject({ kind: "technical", ids: [first.question_comment_id] });

    w.reply("option 1");
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "question-check", "fix", "fix", "review"]);
    expect(w.adapter.ran.filter((s) => s === "question-check")).toHaveLength(1);
    const questions = w.questions();
    expect(questions).toHaveLength(2);
    expect(questions[1].body).toContain(followUp.question);
    expect(w.labelLog.filter((l) => l === "+needs-decision")).toHaveLength(2);
    const fixes = inputsOf(w, "fix");
    expect(fixes[0].answer).toBe(`Question #${questions[0].id}: what does option 2 cost in RAM?`);
    // T3: the second reply adds to the first; either id's mark records the decision.
    expect(fixes[1].answer).toBe(`Question #${questions[0].id}: what does option 2 cost in RAM?\n\nQuestion #${questions[1].id}: option 1`);
    expect(fixes[1].fix_input).toContain(`(maintainer answer, question #${questions[1].id})`);
    expect(w.onMain("docs/decisions/0001-x.md")).toContain(`(maintainer answer, question #${questions[1].id})`);
    expect(w.mergeRequests).toEqual([9]);
    expect(w.labelLog).toEqual([
      "+in-progress", "+needs-decision", "-in-progress",
      "+in-progress", "-needs-decision", "+needs-decision", "-in-progress",
      "+in-progress", "-needs-decision", "-in-progress",
    ]);
    // T-minor 5: the follow-up is logged as asked too, without a check.
    expect(readFileSync(w.paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).event)).toEqual(["asked", "checked", "sent", "answered", "asked", "sent", "answered"]);
  }, 120_000);

  it("decide_yourself then merge (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const reasoning = "The spec's section 4 already settles it: cache in RAM.";
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN], implement: [a.implement(9)], review: [ESCALATE(ask("technical", "Cache the frames in RAM or in flash?")), APPROVE],
        "question-check": [{ verdict: "decide_yourself", reasoning }],
      },
    });
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "question-check", "review"]);
    // AC-14: the review runs again with the check's reasoning as its decide input.
    expect(inputsOf(w, "review")[0].decide_input).toBeUndefined();
    expect(inputsOf(w, "review")[1].decide_input).toBe(reasoning);
    expect(w.mergeRequests).toEqual([9]);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 120_000);

  it("capability question from implement (spec 006 AC-28)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const q = ask("capability", "The board's flashing tool needs a token this worktree does not have. Can you add it?");
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [{ escalation: q }, a.implement(9)], review: [APPROVE], "question-check": [SEND] },
    });
    await w.tick();
    expect(pausedRecord(w)).toMatchObject({ phase: "paused", asking_stage: "implement", question: q });
    w.reply("Added it as FLASH_TOKEN.");
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "implement", "review"]);
    // AC-18: a capability answer goes back to the asking stage, and nothing is recorded.
    const [question] = w.questions();
    const resumed = inputsOf(w, "implement")[1];
    expect(resumed.answer).toBe(`Question #${question.id}: Added it as FLASH_TOKEN.`);
    expect(resumed.question).toContain(q.question);
    expect(runsOf(w, "fix")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
    expect(git(w.pair.origin, "ls-tree", "-r", "--name-only", "main").split("\n").filter((f) => f.startsWith("docs/decisions/"))).toEqual([]);
    expect(w.labelLog).toEqual(["+in-progress", "+needs-decision", "-in-progress", "+in-progress", "-needs-decision", "-in-progress"]);
  }, 120_000);

  it("an unfulfilled capability answer is followed up and costs the issue nothing (spec 062 AC-3)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const q1 = ask("capability", "Command execution is refused in this worktree. Can you restore it?");
    const q2 = ask("capability", "Command execution is still refused after the answer.");
    const followUp = { kind: "capability", question: "Your answer did not restore command execution; the blocker still stands. Who does the work?", options: [{ label: "You do it, then reply `done`", cost: "the maintainer carries it out" }], recommendation: "You do it" };
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN], implement: [{ escalation: q1 }, { escalation: q2 }, a.implement(9)], review: [APPROVE],
        "question-check": [SEND, { verdict: "send", reasoning: "the blocker still stands", question: followUp }],
      },
    });
    await w.tick();
    expect(pausedRecord(w)).toMatchObject({ phase: "paused", asking_stage: "implement", question: q1 });
    w.reply("reclaim space, then resume");
    await w.tick();
    const second = pausedRecord(w);
    expect(second.question).toEqual(followUp);
    expect(ledgerOf(second.state).decideReturns).toBe(0);
    expect(second.state.history.join("\n")).not.toContain("decide_yourself");
    w.reply("done");
    await w.tick();
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["plan", "implement", "question-check", "implement", "question-check", "implement", "review"]);
    const [first, next] = w.questions();
    expect(inputsOf(w, "implement")[2].answer).toBe(`Question #${first.id}: reclaim space, then resume\n\nQuestion #${next.id}: done`);
    expect(readFileSync(w.paths.questionsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l).event)).toEqual(["asked", "checked", "sent", "answered", "asked", "checked", "sent", "answered"]);
    expect(git(w.pair.origin, "ls-tree", "-r", "--name-only", "main").split("\n").filter((f) => f.startsWith("docs/decisions/"))).toEqual([]);
    expect(runsOf(w, "fix")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
    const [firstCheck, secondCheck] = inputsOf(w, "question-check");
    expect(firstCheck.reported_actions).toBe("(none)");
    expect(secondCheck.answered_questions).toBe("(none)");
    expect(secondCheck.reported_actions).toContain(`#${first.id} (capability, answered `);
    expect(secondCheck.reported_actions).toContain("reclaim space, then resume");
  }, 120_000);
});
