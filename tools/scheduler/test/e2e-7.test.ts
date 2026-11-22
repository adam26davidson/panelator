import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CHAIN_FAILURES } from "../src/service/loop.ts";
import type { StageRun } from "../src/adapters/types.ts";
import { initialChainState, ledgerOf, MAX_BLOCKS } from "../src/chain/machine.ts";
import type { BlockedRecord } from "../src/state/blocked.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { OUT_OF_SCOPE, UNCHANGED_WITH_FINDING, MERGE_MAIN_FIX, chainWorld, NETWORK_DOWN, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git } from "./helpers/repo-pair.ts";
import { PARENT, specOf, repoFiles, FAIL, PLAN, APPROVE, CHANGES, ask, ESCALATE, SEND, agents, expectSettled, runsOf, patchesOf, kinds, serviceRecords, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-7");

// ---------------------------------------------------------------------------------------------------------------
// Spec 092 AC-6: a stage run that cannot reach the API waits out the outage; it is not the stage's failure.

describe("end to end: a stage run that cannot reach the API waits out the outage (spec 092 AC-6)", () => {
  const clock = (w: ChainWorld) => {
    const c = { offset: 0 };
    w.deps.now = () => new Date(Date.now() + c.offset);
    return c;
  };

  it("implement unreachable twice then succeeding: no attempt is spent, the backoff doubles, the chain goes on", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [NETWORK_DOWN, NETWORK_DOWN, a.implement(9)], review: [APPROVE] } });
    const c = clock(w);
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    let claim = (await listClaims(w.paths))[0];
    expect(claim.state.history.filter((h) => /^implement attempt/.test(h))).toEqual([]);
    expect(claim.outage?.count).toBe(1);
    const first = Date.parse(claim.outage!.retry_at!) - Date.now();
    expect(first).toBeGreaterThan(50_000);
    expect(first).toBeLessThanOrEqual(60_000);
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement"]);

    c.offset += 61_000;
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement"]);
    claim = (await listClaims(w.paths))[0];
    expect(claim.outage?.count).toBe(2);
    const second = Date.parse(claim.outage!.retry_at!) - (Date.now() + c.offset);
    expect(second).toBeGreaterThan(110_000);
    expect(second).toBeLessThanOrEqual(120_000);

    c.offset += 121_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "implement", "review"]);
    expect(kinds(w, "stage-transient")).toHaveLength(2);
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "transient-outage")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage-over")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
    expect(w.mergeRequests).toEqual([9]);
  }, 180_000);

  it("a rescue run that cannot reach the API is still the rescue after the wait, with no re-plan", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [a.implement(9)], review: [CHANGES, APPROVE, APPROVE], fix: [FAIL, NETWORK_DOWN, a.fix({ "a.txt": "fixed\n" })], "question-check": [SEND] },
    });
    const c = clock(w);
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "fix", "fix"]);
    expect((await listClaims(w.paths))[0].state).toMatchObject({ stage: "fix", rescueRun: true, rescues: 1 });
    c.offset += 1000_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran.filter((r) => r === "plan")).toHaveLength(1);
    expect(runsOf(w, "fix").at(-1)!.model).toBe(w.cfg.rescue_model);
    expect(runsOf(w, "fix").at(-2)!.model).toBe(w.cfg.rescue_model);
    expect(kinds(w, "stage-transient")).toEqual([expect.objectContaining({ stage: "fix" })]);
  }, 180_000);

  it("implement that commits then loses the API keeps its commits as held work for the retry", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let held = "";
    const starts: string[] = [];
    const rev = (run: StageRun) => git(run.worktree, "rev-parse", "HEAD").trim();
    w = await chainWorld({
      files: repoFiles(),
      results: {
        plan: [PLAN],
        implement: [(run: StageRun) => { held = w.push(run, { "a.txt": "held\n" }, "held"); return NETWORK_DOWN; }, a.implement(9, undefined, (run) => starts.push(rev(run)))],
        review: [APPROVE],
      },
    });
    const c = clock(w);
    await w.tick();
    const claim = (await listClaims(w.paths))[0];
    expect(claim.state.heldWork).toEqual([{ branch: "issue-7", head: held, carried: expect.stringContaining("reach the API") }]);
    expect(kinds(w, "held-work")).toMatchObject([{ stage: "implement", branch: "issue-7", head: held }]);
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    c.offset += 61_000;
    await w.tick();
    await expectSettled(w);
    // AC-3: the retry is prepared from the hold, not from origin/main.
    expect(w.adapter.ran).toEqual(["plan", "implement", "implement", "review"]);
    expect(starts).toEqual([held]);
    expect(kinds(w, "held-work-kept")).toMatchObject([{ issue: 7, branch: "issue-7", head: held }]);
    expect(kinds(w, "held-work-restored")).toEqual([]);
    expect(kinds(w, "stale-branch-dropped")).toEqual([]);
    expect(patchesOf(w, "recovered")).toEqual([]);
    expect(kinds(w, "recovered-commits")).toEqual([]);
  }, 180_000);

  it("a review with an independent fallback that cannot reach the API starts no fallback run and retries on its own model", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [a.implement(9)], review: [NETWORK_DOWN, APPROVE] } });
    const own = w.deps.stages.review.model;
    w.deps.stages.review = { ...w.deps.stages.review, independent: true, fallback: "claude-fable-5-2", tier: "standard" };
    const c = clock(w);
    await w.tick();
    expect(w.adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(kinds(w, "stage-transient")).toHaveLength(1);
    c.offset += 61_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "review"]);
    expect(runsOf(w, "review").map((r) => r.model)).toEqual([own, own]);
  }, 180_000);

  it("a conversation turn that cannot reach the API does not spend the conversation's retry, then settles", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [a.implement(9)], review: [ESCALATE(ask("technical", "Which cache?")), NETWORK_DOWN, { conversation: "settled", decision: "Use option one for bounded memory" }, APPROVE], fix: [a.adr()], "question-check": [SEND] },
    });
    const server = await fakeTelegram();
    w.deps.telegram = telegramChannel(new TelegramClient("SECRET", 42, server.url));
    const c = clock(w);
    try {
      await w.tick();
      const date = () => Math.floor((Date.now() + c.offset) / 1000) + 1;
      const u = { update_id: 1, message: { message_id: 1000, date: date(), chat: { id: 42 }, text: "Use option one" } };
      await w.scheduler.handleTelegramUpdate(u);
      await w.scheduler.confirmTelegramUpdate(u);
      await w.tick();
      expect(w.adapter.runs.filter((r) => r.conversation)).toHaveLength(1);
      expect(kinds(w, "stage-transient")).toEqual([expect.objectContaining({ stage: "review" })]);
      const claim = (await listClaims(w.paths))[0];
      expect(claim.state.conversation).toMatchObject({ retried: false });
      expect(claim.outage?.count).toBe(1);
      c.offset += 61_000;
      await w.tick();
      await expectSettled(w);
      expect(w.adapter.runs.filter((r) => r.conversation)).toHaveLength(2);
      expect(runsOf(w, "fix").at(-1)!.input.decision).toBe("Use option one for bounded memory");
      expect(w.mergeRequests).toEqual([9]);
    } finally {
      await server.close();
    }
  }, 180_000);

  it("an outage past its 24-hour ceiling counts a stage run's rejections as chain failures, alarms once, and releases with chain_error (AC-5)", async () => {
    let w!: ChainWorld;
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: Array.from({ length: 12 }, () => NETWORK_DOWN) } });
    const c = clock(w);
    await w.tick();
    const c0 = (await listClaims(w.paths))[0];
    const outageSince = (hours: number) => new Date(Date.now() + c.offset - hours * 3600_000).toISOString();
    // Three hours in: the next rejection raises the alarm, once.
    const young = outageSince(3);
    await writeClaim(w.paths, { ...c0, outage: { since: young, count: 5, last: c0.outage!.last, retry_at: young, alarmed: false } });
    await w.tick();
    expect(serviceRecords(w).filter((r) => r.kind === "transient-outage-alarm")).toHaveLength(1);
    // A day on: past the ceiling the rejections count, and the alarm is not raised again.
    const old = outageSince(25);
    const c1 = (await listClaims(w.paths))[0];
    await writeClaim(w.paths, { ...c1, outage: { ...c1.outage!, since: old, retry_at: old } });
    for (let i = 0; i < 12 && !serviceRecords(w).some((r) => r.kind === "chain-error"); i++) {
      c.offset += 1801_000;
      await w.tick();
      const cl = (await listClaims(w.paths))[0];
      if (cl?.state.chainFailures) expect(cl.state.chainFailures.last.startsWith("outage past ceiling: ")).toBe(true);
    }
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "chain-error")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage-ceiling")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage-alarm")).toHaveLength(1);
    expect(w.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    expect(w.adapter.ran.filter((r) => r === "implement").length).toBeGreaterThan(MAX_CHAIN_FAILURES);
  }, 180_000);
});
describe("end to end: a check failing outside the PR's scope waits for main (spec 060 AC-10)", () => {
  const FAILED = { status: "completed", conclusion: "failure" };
  const GREEN = { status: "completed", conclusion: "success" };
  const blockedRecord = (w: ChainWorld): BlockedRecord | null => (existsSync(join(w.paths.blocked, "7.json")) ? JSON.parse(readFileSync(join(w.paths.blocked, "7.json"), "utf8")) : null);
  const queued = (w: ChainWorld) => (existsSync(w.paths.findingsQueue) ? readFileSync(w.paths.findingsQueue, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const specFiles = { "specs/010-thing/spec.md": specOf() };
  const rest = () => ({ plan: [PLAN], review: [APPROVE, APPROVE] });

  it("main red on the same check: no fix, one finding, one comment, a record and no claim; after main is green the chain rebases, pushes and reaches review with nothing counted", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({ files: repoFiles({ spec: null }), results: { ...rest(), spec: [a.spec(12, specFiles)], implement: [a.implement(13, { "a.txt": "pr 13\n" })] } });
    w.setChecks(() => FAILED);
    await w.tick();

    expect(w.adapter.ran).toEqual(["spec"]);
    expect(await listClaims(w.paths)).toEqual([]);
    const rec = blockedRecord(w)!;
    expect(rec).toMatchObject({ issue: 7, pr: { number: 12 }, condition: { kind: "main_green", check: "test" }, state: { stage: "blocked", fixes: 0, specRescues: 0 } });
    expect(queued(w)).toHaveLength(1);
    expect(queued(w)[0].finding).toMatchObject({ what: "required check test fails on a spec PR for a cause outside its scope", where: expect.stringContaining("origin/main"), stops_pipeline: true });
    expect(w.comments.filter((c) => c.body.includes("outside its scope"))).toHaveLength(1);
    expect(w.comments[0].body).not.toContain("@");
    expect(w.notifications.map((n) => n.gate)).toEqual(["infra"]);
    expect(w.labels.has("in-progress")).toBe(true);
    expect(w.prs.get(12)!.state).toBe("open");
    expect(w.rerequested).toEqual([]);

    // Main moves and the check is green there; the PR's old head is still red until it is rebased and pushed.
    const oldHead = rec.pr.head_sha;
    const main = w.moveMain({ "fix.txt": "main is fixed\n" });
    w.setChecks((sha) => (sha === oldHead ? FAILED : GREEN));
    await w.tick();

    expect(w.logs.filter((r) => r.kind === "error")).toEqual([]);
    expect(w.adapter.ran).toEqual(["spec", "review", "plan", "implement", "review"]);
    expect(blockedRecord(w)).toBeNull();
    expect(w.mergeRequests).toEqual([12, 13]);
    expect(w.onMain("fix.txt")).toBe("main is fixed\n");
    // The review saw a head other than the one that failed: the PR was rebased onto main and pushed.
    expect(runsOf(w, "review")[0].input.pr?.head_sha).not.toBe(oldHead);
    expect(main).toHaveLength(40);
    const ledger = JSON.parse(readFileSync(join(w.paths.escalations, "7.json"), "utf8"));
    expect(ledger).toMatchObject({ blocks: 1, specRescues: 0, rescues: 0 });
  }, 120_000);

  it("main green: one re-run, then the fix says the cause is outside the PR and the chain blocks on the named path until main changes it", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let bad = "";
    const spec = a.spec(12, specFiles);
    w = await chainWorld({
      files: repoFiles({ spec: null }),
      results: { ...rest(), spec: [(run: StageRun) => { const r = spec(run); bad = r.head_sha; return r; }], fix: [OUT_OF_SCOPE()], implement: [a.implement(13, { "a.txt": "pr 13\n" })] },
    });
    w.setChecks((sha) => (sha === bad ? FAILED : GREEN));
    await w.tick();
    // The re-requested check reports as pending first; the chain waits for the next poll and reads it again.
    expect(w.adapter.ran).toEqual(["spec"]);
    expect(w.rerunFailedJobs).toEqual([500]);
    expect(w.rerequested).toEqual([]);
    await w.tick();

    expect(w.adapter.ran).toEqual(["spec", "fix"]);
    expect(w.rerunFailedJobs).toEqual([500]);
    expect(w.rerequested).toEqual([]);
    expect(runsOf(w, "fix")[0].input.fix_input).toContain("out_of_scope");
    expect(runsOf(w, "fix")[0].input.fix_input).toContain("A required check failed:\ntest\nFAIL tools/design-stage/test/render.test.ts");
    expect(blockedRecord(w)).toMatchObject({ condition: { kind: "paths", paths: [".github/workflows/ci.yml"] }, state: { fixes: 0, specRescues: 0, rescues: 0 } });
    expect(queued(w)).toHaveLength(1);
    expect(queued(w)[0].finding).toMatchObject({ where: ".github/workflows/ci.yml", evidence: expect.stringContaining("no Chromium") });
    expect(await listClaims(w.paths)).toEqual([]);

    // A main move that touches README.md does not resume it; one that touches the named file does.
    w.moveMain({ "README.md": "x\n" });
    await w.tick();
    expect(w.adapter.ran).toEqual(["spec", "fix"]);
    expect(blockedRecord(w)).not.toBeNull();
    w.moveMain({ ".github/workflows/ci.yml": "name: ci\n" });
    await w.tick();
    expect(w.logs.filter((r) => r.kind === "error")).toEqual([]);
    expect(w.adapter.ran).toEqual(["spec", "fix", "review", "plan", "implement", "review"]);
    expect(blockedRecord(w)).toBeNull();
    expect(w.mergeRequests).toEqual([12, 13]);
    expect(w.onMain(".github/workflows/ci.yml")).toBe("name: ci\n");
    expect(JSON.parse(readFileSync(join(w.paths.escalations, "7.json"), "utf8"))).toMatchObject({ blocks: 1, specRescues: 0 });
  }, 120_000);

  it("spec 101 AC-7: issue #116's record replayed: a flaky-looking failure is re-run, two verdict-less fixes and the rescue are returned by the block, and the resume past a conflict reaches review", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let bad = "";
    const withLine = (children: string) => `# Product spec\n\nParent: docs/charter.md\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n${children}`;
    const spec = a.spec(12, { ...specFiles, [PARENT]: withLine("- `specs/011-pr-line/spec.md`\n") });
    w = await chainWorld({
      files: repoFiles({ spec: null }),
      results: {
        ...rest(), review: [APPROVE, APPROVE, APPROVE], spec: [(run: StageRun) => { const r = spec(run); bad = r.head_sha; return r; }],
        fix: [UNCHANGED_WITH_FINDING, UNCHANGED_WITH_FINDING, OUT_OF_SCOPE(["tools/scheduler/test/loop.test.ts"], "tools/scheduler/test/loop.test.ts is a flaky test no file of this PR can change"), MERGE_MAIN_FIX(PARENT)],
        implement: [a.implement(13, { "a.txt": "pr 13\n" })],
      },
    });
    w.setChecks((sha) => (sha === bad ? FAILED : GREEN));
    await w.tick();
    expect(w.adapter.ran).toEqual(["spec"]);
    expect(w.rerunFailedJobs).toEqual([500]);
    expect(w.rerequested).toEqual([]);
    for (let i = 0; i < 8 && !blockedRecord(w); i++) await w.tick();

    expect(w.adapter.ran).toEqual(["spec", "fix", "fix", "fix"]);
    expect(runsOf(w, "fix")[2].model).toBe(w.cfg.rescue_model);
    expect(runsOf(w, "fix")[0].input.fix_input).not.toContain("The previous fix run returned the head unchanged");
    expect(runsOf(w, "fix")[1].input.fix_input).toMatch(/^The previous fix run returned the head unchanged and no `out_of_scope` verdict\./);
    expect(w.rerunFailedJobs).toEqual([500]);
    const rec = blockedRecord(w)!;
    expect(rec.state).toMatchObject({ stage: "blocked", fixes: 0, specRescues: 0, blocked: { blocks: 1 } });
    expect(rec.state.history.filter((h) => h.endsWith("re-run requested once"))).toHaveLength(1);
    expect(rec.state.history.filter((h) => h === "fix returned the head unchanged without a verdict")).toHaveLength(2);
    expect(queued(w)[0].finding).toMatchObject({ where: "tools/scheduler/test/loop.test.ts" });

    // Main moves the parent's Children section and the named file: the block resumes, the rebase conflicts, the conflict fix runs.
    w.moveMain({ [PARENT]: withLine("- `specs/012-main-line/spec.md`\n"), "tools/scheduler/test/loop.test.ts": "// fixed\n" });
    await w.tick();

    expect(w.logs.filter((r) => r.kind === "error")).toEqual([]);
    expect(w.logs.some((r) => r.kind === "rebase-conflict-on-resume")).toBe(true);
    expect(w.adapter.ran).toEqual(["spec", "fix", "fix", "fix", "fix", "review", "review", "plan", "implement", "review"]);
    expect(blockedRecord(w)).toBeNull();
    expect(w.mergeRequests).toEqual([12, 13]);
    expect(JSON.parse(readFileSync(join(w.paths.escalations, "7.json"), "utf8"))).toMatchObject({ specRescues: 0, blocks: 1 });
  }, 180_000);

  it("with the block bound spent in the ledger, the verdict is counted as a fix and the fix loop runs as today", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let bad = "";
    const spec = a.spec(12, specFiles);
    w = await chainWorld({
      files: repoFiles({ spec: null }),
      results: { spec: [(run: StageRun) => { const r = spec(run); bad = r.head_sha; return r; }], fix: [OUT_OF_SCOPE(), OUT_OF_SCOPE(), OUT_OF_SCOPE()] },
    });
    await writeLedger(w.paths, 7, { ...ledgerOf(initialChainState(7)), blocks: MAX_BLOCKS });
    w.setChecks((sha) => (sha === bad ? FAILED : GREEN));
    await w.tick();
    await w.tick();
    // Each failed read of an unchanged head now goes to the fix.
    for (let i = 0; i < 8 && !w.labelLog.includes("+abandoned"); i++) await w.tick();

    expect(w.adapter.ran).toEqual(["spec", "fix", "fix", "fix"]);
    expect(blockedRecord(w)).toBeNull();
    expect(w.labelLog).toContain("+abandoned");
    expect(w.comments.at(-1)!.body).toContain("block bound reached");
  }, 120_000);

  it("an issue-track fix that returns out_of_scope is ignored: counted as a fix, verify runs", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let bad = "";
    const implement = a.implement(9);
    w = await chainWorld({
      files: repoFiles(),
      results: { plan: [PLAN], implement: [(run: StageRun) => { const r = implement(run); bad = r.head_sha; return r; }], review: [APPROVE], fix: [OUT_OF_SCOPE(), a.fix({ "a.txt": "fixed\n" })] },
    });
    w.setChecks((sha) => (sha === bad ? FAILED : GREEN));
    await w.tick();

    expect(w.adapter.ran).toEqual(["plan", "implement", "fix", "fix", "review"]);
    expect(w.rerequested).toEqual([]);
    expect(blockedRecord(w)).toBeNull();
    expect(w.mergeRequests).toEqual([9]);
    expect(JSON.parse(readFileSync(join(w.paths.escalations, "7.json"), "utf8")).history.some((h: string) => h.startsWith("out_of_scope ignored: "))).toBe(true);
  }, 120_000);
});
