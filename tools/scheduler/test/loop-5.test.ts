import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaims, readClaim, writeClaim } from "../src/state/claims.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { listPaused, writePaused } from "../src/state/paused.ts";
import type { Claim } from "../src/state/claims.ts";
import { git } from "./helpers/repo-pair.ts";
import { issue, routes, setup, ME, BOT_LOGIN, comment, pausedState, record, waiting, firstStep, settle, labelCalls, type Harness, FUTURE, PAST, writeWaiting, rmClaim, holdingDrive, grantLog, readyClaim, withStanding, answeredRoutes } from "./helpers/loop-harness.ts";

describe("Scheduler.tick: a postponed chain holds its slot (spec 009)", () => {
  it("claims nothing while a waiting claim holds the only slot, and starts the chain once postponedUntil passes (AC-1)", async () => {
    const h = await setup(routes([issue(1)]));
    await writeWaiting(h, 7, FUTURE);
    const t = await h.s.tick();
    expect(t.claimed).toEqual([]);
    expect(t.held).toBe(1);
    expect(labelCalls(h.gh, 1)).toEqual([]);
    expect(h.gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/comments")).toEqual([]);
    expect((await listClaims(h.paths)).map((c) => c.issue)).toEqual([7]);
    expect(existsSync(join(h.pair.worktrees, "issue-1"))).toBe(false);
    // Past the liveness window as well as the reset: the claim was last active at 12:00 (spec 023).
    h.setNow(new Date("2026-10-12T14:30:00Z"));
    const t2 = await h.s.tick();
    await settle();
    expect(h.started).toEqual([7]);
    expect(t2.claimed).toEqual([]);
    expect(t2.released).toEqual([]);
  }, 30_000);

  it("counts the waiting claim, not the running chain (AC-2)", async () => {
    const { st, drive } = holdingDrive();
    const shortlist: unknown[] = [];
    const h = await setup(routes(shortlist), 2, drive);
    await writeClaim(h.paths, { issue: 3, state: { ...initialChainState(3), stage: "verify" }, worktree: join(h.pair.worktrees, "issue-3"), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null });
    await h.s.tick();
    await writeWaiting(h, 7, FUTURE);
    shortlist.push(issue(1), issue(2));
    const t = await h.s.tick();
    expect(t.held).toBe(2);
    expect(t.claimed).toEqual([]);
    st.release();
  }, 30_000);

  it("claims exactly one issue with slots: 2 and one waiting claim (AC-2)", async () => {
    const h = await setup(routes([issue(2), issue(1)]), 2);
    await writeWaiting(h, 7, FUTURE);
    const t = await h.s.tick();
    expect(t.held).toBe(1);
    expect(t.claimed).toEqual([1]);
  }, 30_000);

  it("claims past a paused issue, and past the claim a crash left beside its record (AC-3)", async () => {
    const h = await setup(routes([waiting(), issue(1)]));
    await writePaused(h.paths, record());
    const t = await h.s.tick();
    expect(t.held).toBe(0);
    expect(t.claimed).toEqual([1]);
    expect(labelCalls(h.gh, 7)).toEqual([]);

    const h2 = await setup(routes([waiting(), issue(1)]));
    await writePaused(h2.paths, record());
    await writeClaim(h2.paths, { issue: 7, state: pausedState(), worktree: join(h2.pair.worktrees, "issue-7"), started_at: h2.deps.now().toISOString(), last_activity_at: h2.deps.now().toISOString(), run_id: null });
    expect((await h2.s.tick()).claimed).toEqual([1]);
  }, 30_000);

  it("resumes an answered paused issue before a shortlisted issue (AC-4, as amended by spec 016 AC-2)", async () => {
    const rs = routes([waiting(), issue(8, ["validated", "class:product", "priority"])], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });
    const h = await setup(rs, 1, firstStep);
    await writeWaiting(h, 3, FUTURE);
    await writePaused(h.paths, record());
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(labelCalls(h.gh, 8)).toEqual([]);
  }, 30_000);

  it("starts one over-held chain per running slot and claims nothing until held is below slots (AC-5)", async () => {
    const { st, drive } = holdingDrive();
    const h = await setup(routes([issue(1)]), 1, drive);
    for (const n of [5, 6, 7]) await writeWaiting(h, n, PAST);
    const order = (await listClaims(h.paths)).map((c) => c.issue);
    const t = await h.s.tick();
    expect(t.held).toBe(3);
    expect(t.claimed).toEqual([]);
    expect(st.started).toEqual([order[0]]);
    expect((await listClaims(h.paths)).map((c) => c.issue)).toEqual(order);
    await rmClaim(h, order[0]);
    st.release();
    await settle();
    const t2 = await h.s.tick();
    expect(t2.held).toBe(2);
    expect(t2.claimed).toEqual([]);
    expect(st.started).toEqual([order[0], order[1]]);
    expect((await listClaims(h.paths)).map((c) => c.issue)).toEqual(order.slice(1));
    st.release();
  }, 30_000);

  it("claims the next issue on the tick after the waiting claim goes (AC-6)", async () => {
    const h = await setup(routes([issue(1)]));
    await writeWaiting(h, 7, FUTURE);
    expect((await h.s.tick()).claimed).toEqual([]);
    await rmClaim(h, 7);
    expect((await h.s.tick()).claimed).toEqual([1]);
  }, 30_000);
});
describe("Scheduler.tick: a waiting claim is not stalled (spec 023)", () => {
  const waitingClaim = (h: Harness, n: number, postponedUntil: string, last_activity_at: string, state: Partial<Claim["state"]> = {}) =>
    writeClaim(h.paths, {
      issue: n, state: { ...initialChainState(n), stage: "waiting", resumeStage: "plan", postponedUntil, ...state },
      worktree: join(h.pair.worktrees, `issue-${n}`), started_at: "2026-10-09T00:00:00Z", last_activity_at, run_id: null,
    });
  const releaseCalls = (h: Harness, n: number) => h.gh.calls.filter((c) => (c.method === "POST" && c.url === `/repos/o/r/issues/${n}/comments`) || (c.method === "DELETE" && c.url === `/repos/o/r/issues/${n}/labels/in-progress`));
  const prCalls = (h: Harness) => h.gh.calls.filter((c) => c.method !== "GET" && (c.url.includes("/pulls/") || c.url.includes("/git/refs/")));

  it("starts a claim on the first tick after its reset, activity 2h12m old, closing nothing (AC-1, the #15 incident)", async () => {
    const h = await setup(routes([]));
    await waitingClaim(h, 15, "2026-10-12T12:00:00Z", "2026-10-12T09:48:00Z", { track: "spec", resumeStage: "spec", pr: { number: 73, head_sha: "abc" } });
    h.setNow(new Date("2026-10-12T12:00:11Z"));
    const t = await h.s.tick();
    await settle();
    expect(t.errors).toEqual([]);
    expect(t.released).toEqual([]);
    expect(h.started).toEqual([15]);
    expect(releaseCalls(h, 15)).toEqual([]);
    expect(prCalls(h)).toEqual([]);
    expect((await listClaims(h.paths)).map((c) => c.issue)).toEqual([15]);
  }, 30_000);

  it("starts a claim on the first tick 43 hours after its reset (AC-2, a machine asleep through the reset)", async () => {
    const h = await setup(routes([]));
    await waitingClaim(h, 15, "2026-10-10T17:00:00Z", "2026-10-10T14:57:00Z");
    h.setNow(new Date("2026-10-12T12:00:00Z"));
    const t = await h.s.tick();
    await settle();
    expect(t.released).toEqual([]);
    expect(h.started).toEqual([15]);
    expect(releaseCalls(h, 15)).toEqual([]);
  }, 30_000);

  it("keeps a claim queued behind a full slot past the window, and starts it when the slot frees (AC-3, the #17 incident)", async () => {
    const { st, drive } = holdingDrive();
    const h = await setup(routes([issue(1)]), 1, drive);
    await writeClaim(h.paths, { issue: 3, state: { ...initialChainState(3), stage: "verify" }, worktree: join(h.pair.worktrees, "issue-3"), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null });
    await h.s.tick();
    expect(st.started).toEqual([3]);
    await waitingClaim(h, 7, "2026-10-12T12:05:00Z", "2026-10-12T12:00:00Z");
    for (const at of ["2026-10-12T14:30:00Z", "2026-10-12T20:00:00Z"]) {
      h.setNow(new Date(at));
      const t = await h.s.tick();
      expect(t.released).toEqual([]);
      expect(t.claimed).toEqual([]);
      expect(t.held).toBe(2);
      expect(st.started).toEqual([3]);
    }
    expect(releaseCalls(h, 7)).toEqual([]);
    await rmClaim(h, 3);
    st.release();
    await settle();
    const t = await h.s.tick();
    expect(t.released).toEqual([]);
    expect(t.claimed).toEqual([]);
    expect(st.started).toEqual([3, 7]);
    st.release();
  }, 30_000);

  it.each([["ahead", FUTURE], ["passed", PAST]])("still drops a waiting claim whose in-progress label was removed, reset %s (AC-4)", async (_when, until) => {
    const h = await setup(routes([], { 7: ["validated"] }));
    await waitingClaim(h, 7, until, "2026-10-12T11:59:00Z");
    const t = await h.s.tick();
    await settle();
    expect(t.released).toEqual([7]);
    expect(h.started).toEqual([]);
    expect(await listClaims(h.paths)).toEqual([]);
  }, 30_000);

  it.each(["implement", "verify"] as const)("still expires a claim in %s with stale activity (AC-5)", async (stage) => {
    const h = await setup(routes([]));
    const wt = join(h.pair.worktrees, "issue-7");
    git(h.pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(h.paths, { issue: 7, state: { ...initialChainState(7), stage }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:48:00Z", run_id: null });
    const t = await h.s.tick();
    expect(t.released).toEqual([7]);
    expect(h.started).toEqual([]);
  }, 30_000);

  it("leaves waiting when stepped, with fresh activity, so normal liveness then applies (AC-6)", async () => {
    const h = await setup(routes([]), 1, firstStep);
    const wt = join(h.pair.worktrees, "issue-7");
    git(h.pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(h.paths, { issue: 7, state: { ...initialChainState(7), stage: "waiting", resumeStage: "plan", postponedUntil: "2026-10-12T12:00:00Z" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:48:00Z", run_id: null });
    h.setNow(new Date("2026-10-12T12:00:11Z"));
    expect((await h.s.tick()).released).toEqual([]);
    await settle();
    const stepped = await readClaim(h.paths, 7);
    expect(stepped?.state.stage).toBe("plan");
    expect(stepped?.last_activity_at).toBe("2026-10-12T12:00:11.000Z");
    h.setNow(new Date("2026-10-12T14:00:12Z"));
    expect((await h.s.tick()).released).toEqual([7]);
  }, 30_000);
});
describe("Scheduler.tick: fair slot scheduling (spec 016)", () => {
  it("resumes an answered question before a claim on disk, then starts the claim once it ends (AC-1)", async () => {
    const log = grantLog();
    const h = await setup(answeredRoutes(), 1, log.drive);
    await readyClaim(h, 3);
    await writePaused(h.paths, record());
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(log.grants).toEqual(["chain:7"]);
    expect(h.s.active).toBe(1);
    await rmClaim(h, 7);
    await log.release("chain:7");
    await h.s.tick();
    await settle();
    expect(log.grants).toEqual(["chain:7", "chain:3"]);
    await log.release("chain:3");
  }, 30_000);

  it("resumes an answered question while a postponed claim holds the slot, and claims nothing new (AC-2)", async () => {
    const log = grantLog();
    const h = await setup(answeredRoutes([issue(8, ["validated", "class:product", "priority"])]), 1, log.drive);
    await writeWaiting(h, 3, FUTURE);
    await writePaused(h.paths, record());
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(t.held).toBe(2);
    expect(labelCalls(h.gh, 8)).toEqual([]);
    h.setNow(new Date("2026-10-12T14:00:00Z"));
    expect((await h.s.tick()).claimed).toEqual([]);
    await settle();
    expect(log.grants).toEqual(["chain:7"]);
    await rmClaim(h, 7);
    await log.release("chain:7");
    await h.s.tick();
    await settle();
    expect(log.grants).toEqual(["chain:7", "chain:3"]);
    expect(labelCalls(h.gh, 8)).toEqual([]);
    await log.release("chain:3");
  }, 30_000);

  it("waits for a running slot, then resumes the answer before a claim, a standing agent or the shortlist (AC-3)", async () => {
    const log = grantLog();
    const h = await setup(answeredRoutes([issue(8, ["validated", "class:product", "priority"])]), 1, log.drive);
    await withStanding(h, log, false);
    await readyClaim(h, 3);
    await h.s.tick();
    await settle();
    expect(log.grants).toEqual(["chain:3"]);
    await writePaused(h.paths, record());
    await withStanding(h, log, true);
    expect((await h.s.tick()).claimed).toEqual([]);
    expect(await listPaused(h.paths)).toEqual([expect.objectContaining({ issue: 7 })]);
    await rmClaim(h, 3);
    await readyClaim(h, 4);
    await log.release("chain:3");
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(t.standing).toEqual([]);
    expect(log.grants).toEqual(["chain:3", "chain:7"]);
    expect(labelCalls(h.gh, 8)).toEqual([]);
    await log.release("chain:7");
  }, 30_000);

  it("runs a due standing agent although claims on disk fill the held count, then the first claim (AC-4, AC-8)", async () => {
    const log = grantLog();
    const h = await setup(routes([]), 1, log.drive);
    await withStanding(h, log);
    for (const n of [5, 6, 7]) await readyClaim(h, n);
    const t = await h.s.tick();
    await settle();
    expect(t.held).toBe(3);
    expect(t.standing).toEqual(["action-audit"]);
    expect(log.grants).toEqual(["standing"]);
    expect(h.s.active).toBe(1);
    await log.release("standing");
    const t2 = await h.s.tick();
    await settle();
    expect(t2.standing).toEqual([]);
    expect(log.grants).toEqual(["standing", "chain:5"]);
    expect(h.s.active).toBe(1);
    await log.release("chain:5");
  }, 30_000);

  it("alternates an always-due standing agent with ready chains (AC-5, AC-8)", async () => {
    const log = grantLog();
    const h = await setup(routes([]), 1, log.drive);
    await withStanding(h, log);
    await readyClaim(h, 5);
    await readyClaim(h, 6);
    for (let i = 0; i < 4; i++) {
      await h.s.tick();
      await settle();
      expect(h.s.active).toBe(1);
      await log.release(log.grants[log.grants.length - 1]);
    }
    expect(log.grants).toEqual(["standing", "chain:5", "standing", "chain:5"]);
  }, 30_000);

  it("gives the slot to the other kind when the one whose turn it is has nothing ready, and grants nothing when neither has (AC-6)", async () => {
    const log = grantLog();
    const h = await setup(routes([]), 1, log.drive);
    await withStanding(h, log);
    await writeWaiting(h, 3, FUTURE);
    await h.s.tick();
    await settle();
    await log.release("standing");
    // The turn favours a chain now, but the only claim waits into the future.
    await h.s.tick();
    await settle();
    expect(log.grants).toEqual(["standing", "standing"]);
    await log.release("standing");

    const log2 = grantLog();
    const h2 = await setup(routes([]), 1, log2.drive);
    await withStanding(h2, log2, false);
    await readyClaim(h2, 4);
    await h2.s.tick();
    await settle();
    expect(log2.grants).toEqual(["chain:4"]);
    await rmClaim(h2, 4);
    await log2.release("chain:4");
    const t = await h2.s.tick();
    await settle();
    expect(log2.grants).toEqual(["chain:4"]);
    expect(t.standing).toEqual([]);
    expect(h2.s.active).toBe(0);
  }, 30_000);

  it("keeps a postponed claim's slot against new claims while a standing agent runs, and shares slots: 2 (AC-7, AC-8)", async () => {
    const log = grantLog();
    const h = await setup(routes([issue(1)]), 1, log.drive);
    await withStanding(h, log);
    await writeWaiting(h, 3, FUTURE);
    const t = await h.s.tick();
    await settle();
    expect(t.standing).toEqual(["action-audit"]);
    expect(t.claimed).toEqual([]);
    expect(t.held).toBe(1);
    await log.release("standing");

    const log2 = grantLog();
    const h2 = await setup(routes([issue(2), issue(1)]), 2, log2.drive);
    await withStanding(h2, log2);
    const t2 = await h2.s.tick();
    await settle();
    expect(t2.standing).toEqual(["action-audit"]);
    expect(t2.claimed).toEqual([1]);
    expect(h2.s.active).toBe(2);
    await log2.release("standing");
    await log2.release("chain:1");
  }, 30_000);
});
