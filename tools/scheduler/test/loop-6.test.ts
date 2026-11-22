import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import { BLOCK_RECHECK_S, Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { listClaims, readClaim, writeClaim } from "../src/state/claims.ts";
import { statePaths } from "../src/state/paths.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { applyActions } from "../src/chain/driver.ts";
import { listBlocked, writeBlocked, type BlockedRecord } from "../src/state/blocked.ts";
import { listPaused, writePaused } from "../src/state/paused.ts";
import type { Route } from "./helpers/mock-github.ts";
import { git } from "./helpers/repo-pair.ts";
import { awsWorld } from "./helpers/aws.ts";
import { issue, routes, setup, claimedPayloads, pausedState, record, waiting, firstStep, waitFor, settle, logLines, labelCalls, serviceRecords, type Harness, rmClaim, holdingDrive, grantLog, readyClaim, withStanding, answeredRoutes, recordingInhibitor } from "./helpers/loop-harness.ts";

describe("Scheduler.tick: fair slot scheduling, failure and crash windows (spec 016)", () => {
  it("claims no second issue in the same grant when the first claim's label fails after its claim file (AC-7, AC-8)", async () => {
    const log = grantLog();
    const failLabel: Route = { method: "POST", path: /^\/repos\/o\/r\/issues\/1\/labels$/, reply: () => ({ status: 422, body: { message: "Validation Failed" } }) };
    const h = await setup([failLabel, ...routes([issue(1), issue(2)])], 1, log.drive);
    h.allowErrors(/^claim 1: /);
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([]);
    expect(t.errors).toEqual([expect.stringContaining("claim 1:")]);
    expect((await listClaims(h.paths)).map((c) => c.issue)).toEqual([1]);
    expect(log.grants).toEqual([]);
    expect(labelCalls(h.gh, 2)).toEqual([]);
  }, 30_000);

  it("starts a claim carrying an answered event, left by a crash after a resume, before a standing agent and other claims (AC-1)", async () => {
    const log = grantLog();
    const h = await setup(routes([]), 1, log.drive);
    await withStanding(h, log);
    await readyClaim(h, 4);
    await writeClaim(h.paths, {
      issue: 9, state: pausedState(), worktree: join(h.pair.worktrees, "issue-9"), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null,
      pendingEvent: { type: "answered", answer: "Use the file store.", questionId: 500 },
    });
    const t = await h.s.tick();
    await settle();
    expect(t.standing).toEqual([]);
    expect(log.grants).toEqual(["chain:9"]);
    await rmClaim(h, 9);
    await log.release("chain:9");
    // The answered start did not take a turn: the standing agent still goes first.
    await h.s.tick();
    await settle();
    expect(log.grants).toEqual(["chain:9", "standing"]);
    await log.release("standing");
  }, 30_000);
});
describe("Scheduler.run", () => {
  it("ticks immediately, again after a detected sleep, and writes the stopped trailer on stop (AC-4, AC-31)", async () => {
    const { s, deps, paths, setNow, setMono } = await setup(routes([]));
    let ticks = 0;
    const origTick = s.tick.bind(s);
    s.tick = async () => { ticks++; return origTick(); };
    const sleeps: number[] = [];
    let refreshes = 0;
    deps.refreshToken = async () => { refreshes++; };
    deps.sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) { setNow(new Date("2026-10-12T13:00:00Z")); setMono(1000); } // wall jumped an hour, monotonic 1 s: slept
      if (sleeps.length === 2) s.stop("SIGTERM");
    };
    await s.run();
    expect(ticks).toBe(2);
    expect(refreshes).toBe(1);
    const log = readFileSync(paths.serviceLog, "utf8");
    expect(log).toContain('"kind":"resumed"');
    expect(log.trim().split("\n").pop()).toContain('"kind":"stopped"');
  }, 30_000);
});
describe('Scheduler.tick: main check watcher (spec 036)',()=>{
 const checkRoute:Route={method:'GET',path:/^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/,reply:()=>({body:{total_count:1,check_runs:[{id:9,name:'test',status:'completed',conclusion:'failure'}]}})};
 async function harness(){
  const h=await setup([...routes([]),checkRoute]);
  const {loadRegistry}=await import('../src/standing/registry.ts');
  const {EVENT_NAMES}=await import('../src/standing/events.ts');
  const {registryActionsCheck}=await import('../src/actions/index.ts');
  const {loadParameterDefinitions}=await import('../src/parameters/definitions.ts');
  const {ParameterStore}=await import('../src/parameters/store.ts');
  const {initializeAgents,readAgentState}=await import('../src/standing/state.ts');
  const loaded=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,registryActionsCheck(join(agentsDir,'actions.yaml')));
  // The checked-in infra health agent subscribes to `ci_failure_main` (spec 064); these tests need a registry without a subscriber.
  const all:typeof loaded={...loaded,'infra-health':{...loaded['infra-health'],trigger:{...loaded['infra-health'].trigger,events:['infra_alarm']}}};
  const a=all['action-audit'];
  const subscribed={...all,'action-audit':{...a,trigger:{...a.trigger,events:[...(a.trigger.events??[]),'ci_failure_main']}}};
  h.deps.cfg.required_checks=['test'];
  const use=async(registry:typeof all)=>{h.deps.registry=registry;h.deps.parameters=new ParameterStore(h.paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),h.deps.cfg,registry));await initializeAgents(h.paths,registry,h.deps.parameters,h.deps.now());};
  const checkCalls=()=>h.gh.calls.filter(c=>c.url.includes('/check-runs'));
  const sha=()=>git(h.pair.repo,'rev-parse','origin/main').trim();
  return {...h,all,subscribed,use,checkCalls,sha,readAgentState};
 }
 it('makes no check-run call when no agent subscribes (AC-1)',async()=>{
  const h=await harness();await h.use(h.all);const t=await h.s.tick();
  expect(h.checkCalls()).toHaveLength(0);expect(existsSync(h.paths.mainChecks)).toBe(false);expect(t.errors.filter(e=>e.startsWith('main checks:'))).toEqual([]);
 },30000);
 it('a subscriber turns the watcher on (AC-2)',async()=>{
  const h=await harness();await h.use(h.subscribed);await h.s.tick();
  const calls=h.checkCalls();expect(calls).toHaveLength(1);expect(calls[0].url).toContain(h.sha());
  const st=(await h.readAgentState(h.paths,'action-audit'))!;
  expect(st.pending_events.map(e=>({event:e.event,payload:e.payload}))).toEqual([{event:'ci_failure_main',payload:{check:'test',run_id:9,sha:h.sha()}}]);
 },30000);
 it('subscribing later resumes from the stored state (AC-3)',async()=>{
  const h=await harness();const stored=JSON.stringify({$sha:h.sha(),test:'failed'});writeFileSync(h.paths.mainChecks,stored);
  await h.use(h.all);await h.s.tick();
  expect(readFileSync(h.paths.mainChecks,'utf8')).toBe(stored);expect(h.checkCalls()).toHaveLength(0);
  await h.use(h.subscribed);await h.s.tick();
  expect(h.checkCalls()).toHaveLength(1);expect((await h.readAgentState(h.paths,'action-audit'))!.pending_events).toEqual([]);
 },30000);
 it('an undefined or empty registry makes no check-run call (AC-4)',async()=>{
  const h=await harness();h.deps.registry=undefined;await h.s.tick();expect(h.checkCalls()).toHaveLength(0);
  h.deps.registry={};await h.s.tick();expect(h.checkCalls()).toHaveLength(0);
 },30000);
});
describe("Telegram attaches when connected (spec 043)", () => {
  const poller = async (s: Scheduler, server: Awaited<ReturnType<typeof fakeTelegram>>, logs: Record<string, unknown>[], hook: () => void = () => {}) => {
    const { TelegramPoller } = await import("../src/telegram/poller.ts");
    const client = new TelegramClient("secret", 42, server.url);
    return new TelegramPoller(client, join(tmpdir(), `tg-offset-${Math.random()}.json`), 1, async () => {}, (r) => logs.push(r), async () => { await new Promise((r) => setTimeout(r, 5)); }, undefined, () => { s.setTelegram(telegramChannel(client)); hook(); });
  };
  const until = async (f: () => boolean) => { await waitFor({ condition: f }); };
  const question = { kind: "product" as const, question: "Which layout?", options: [{ label: "second", cost: "none" }], recommendation: "second" };
  const claimFor = async (h: Awaited<ReturnType<typeof setup>>, n: number) => {
    const claim = { issue: n, state: { ...initialChainState(n), stage: "plan" as const }, worktree: join(h.pair.worktrees, `issue-${n}`), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null };
    await writeClaim(h.paths, claim);
    return claim;
  };
  const pause = (h: Awaited<ReturnType<typeof setup>>, claim: Awaited<ReturnType<typeof claimFor>>) =>
    applyActions(h.deps, claim, [{ type: "pause", question, asking: "plan" }]);
  it("spec 090 AC-3/AC-4: a pause before the connection is an issue question with telegram null; after it, a Telegram one", async () => {
    const h = await setup(routes([waiting(), issue(8)]), 1, firstStep);
    const { s, deps, paths, gh } = h;
    const driverLog: Record<string, unknown>[] = [];
    deps.log = (r) => { driverLog.push(r as Record<string, unknown>); };
    const server = await fakeTelegram(); const logs: Record<string, unknown>[] = []; let hooked = 0;
    server.fail("getMe", 500, 1000);
    const p1 = await poller(s, server, logs, () => hooked++);
    p1.start();
    try {
      await until(() => logs.some((l) => l.status === "connecting"));
      expect(deps.telegram).toBeFalsy();
      await pause(h, await claimFor(h, 7));
      expect(hooked).toBe(0);
      const first = (await listPaused(paths)).find((x) => x.issue === 7);
      expect(first?.telegram).toBeNull();
      const posts = gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments").map((c) => (c.body as { body: string }).body);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain(`@${deps.cfg.maintainer}`);
      expect(posts[0]).toContain("Reply in a comment on this issue; the scheduler resumes on your reply.");
      const sent7 = logLines(paths).filter((e) => e.issue === 7 && e.event === "sent");
      expect(sent7).toHaveLength(1);
      expect(sent7[0].channel).toBe("issue");
      expect(sent7[0]).not.toHaveProperty("telegram_message_id");
      expect(driverLog.some((l) => l.kind === "telegram-send-failed")).toBe(false);
      expect(server.requests.some((q) => q.method === "sendMessage")).toBe(false);
      await p1.stop();
      server.fail("getMe", 200, 0);
      const p2 = await poller(s, server, logs, () => hooked++);
      p2.start();
      await until(() => hooked === 1);
      await p2.stop();
      await pause(h, await claimFor(h, 8));
      expect(server.sent).toHaveLength(1);
      const second = (await listPaused(paths)).find((x) => x.issue === 8);
      expect(second?.telegram?.sent).toBe(true);
      expect(second?.telegram?.message_id).toBeTruthy();
      const sent8 = logLines(paths).filter((e) => e.issue === 8 && e.event === "sent");
      expect(sent8).toHaveLength(1);
      expect(sent8[0].channel).toBe("telegram");
      expect((await listPaused(paths)).find((x) => x.issue === 7)?.telegram).toBeNull();
    } finally { await p1.stop(); await server.close(); }
  }, 30000);
  it("AC-4: a tick completes while getMe is failing", async () => {
    const { s } = await setup(routes([]));
    const server = await fakeTelegram(); const logs: Record<string, unknown>[] = []; let hooked = 0;
    // Keep the outage active until cleanup, regardless of retry count or tick duration.
    server.fail("getMe", 500, Infinity);
    const p = await poller(s, server, logs, () => hooked++);
    p.start();
    try {
      await until(() => logs.some((l) => l.status === "connecting"));
      await Promise.race([s.tick(), new Promise((_, rej) => setTimeout(() => rej(new Error("tick hung")), 10000))]);
      expect(logs.some((l) => l.status === "connected")).toBe(false);
      expect(hooked).toBe(0);
    } finally { await p.stop(); await server.close(); }
  }, 30000);
});
describe("Scheduler.tick: a chain blocked on main (spec 060)", () => {
  const blockedState = (over: Record<string, unknown> = {}) => ({
    ...initialChainState(7), stage: "blocked" as const, track: "spec" as const, pr: { number: 8, head_sha: "f".repeat(40) }, blocked: { on: null, since: null, check: "test", main_sha: null, blocks: 1 }, ...over,
  });
  const mainHead = (h: Harness) => git(h.pair.repo, "rev-parse", "origin/main").trim();
  const block = async (h: Harness, condition: BlockedRecord["condition"], over: Partial<BlockedRecord> = {}) =>
    writeBlocked(h.paths, { issue: 7, state: blockedState(), worktree: join(h.pair.worktrees, "issue-7"), since: "2026-10-12T11:00:00Z", condition, pr: { number: 8, head_sha: "f".repeat(40) }, last_check: null, ...over });
  /** A commit on origin's main touching `files`, through a scratch clone. */
  const moveMain = (h: Harness, files: Record<string, string>) => {
    const dir = join(h.pair.root, `mover-${Math.random().toString(36).slice(2)}`);
    git(h.pair.root, "clone", "-q", h.pair.origin, dir);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "move main");
    git(dir, "push", "-q", "origin", "main");
  };
  const checkRoute = (state: { calls: string[]; conclusion: string | null; status: string }): Route => ({
    method: "GET", path: /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/check-runs$/,
    reply: (m) => {
      state.calls.push(m[1]);
      return { body: { total_count: 1, check_runs: [{ id: 5, name: "test", status: state.status, conclusion: state.conclusion }] } };
    },
  });

  it("a blocked issue holds no slot, is not on the shortlist, and a paths condition resumes only on a named file (AC-4, AC-7)", async () => {
    const log = grantLog();
    const h = await setup(routes([waiting(["validated", "class:product", "in-progress"]), issue(8, ["validated", "class:product", "priority"])]), 1, log.drive);
    const base = mainHead(h);
    await block(h, { kind: "paths", paths: [".github/workflows/ci.yml", "docs/"], main_sha: base });
    // The slot is free for other work, but issue 7 is not offered as a new claim.
    const first = await h.s.tick();
    await settle();
    expect(first.held).toBe(0);
    expect(first.claimed).toEqual([8]);
    await log.release("chain:8");
    await rmClaim(h, 8);
    moveMain(h, { "README.md": "x\n" });
    expect((await h.s.tick()).claimed).not.toContain(7);
    await settle();
    expect(await listBlocked(h.paths)).toHaveLength(1);
    await log.release("chain:8");
    await rmClaim(h, 8).catch(() => {});
    moveMain(h, { ".github/workflows/ci.yml": "x\n" });
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toContain(7);
    expect(log.grants).toContain("chain:7");
    expect(await listBlocked(h.paths)).toEqual([]);
    const claim = (await readClaim(h.paths, 7))!;
    expect(claim.pendingEvent).toEqual({ type: "unblocked", main_sha: mainHead(h) });
    expect(claimedPayloads(h.paths, 7)).toStrictEqual([{}]); // spec 095 AC-1
    expect(serviceRecords(h.paths).find((r) => r.kind === "unblocked")).toMatchObject({ issue: 7, condition: { kind: "paths" } });
    await log.release("chain:7");
  }, 30_000);

  it("a directory path covers files under it; a plain path does not (AC-7)", async () => {
    const h = await setup(routes([waiting(["validated", "class:product", "in-progress"])]), 1, holdingDrive().drive);
    await block(h, { kind: "paths", paths: ["docs/designs"], main_sha: mainHead(h) });
    moveMain(h, { "docs/designs/x.md": "x\n" });
    await h.s.tick();
    expect(await listBlocked(h.paths)).toHaveLength(1);
  }, 30_000);

  it("a main_green condition reads main's check at most once per BLOCK_RECHECK_S and resumes when it is green (AC-7)", async () => {
    const world = { calls: [] as string[], conclusion: "failure" as string | null, status: "completed" };
    const h = await setup([...routes([waiting(["validated", "class:product", "in-progress"])]), checkRoute(world)], 1, holdingDrive().drive);
    h.deps.cfg.required_checks = ["test"];
    await block(h, { kind: "main_green", check: "test", main_sha: mainHead(h) });
    await h.s.tick();
    expect(world.calls).toHaveLength(1);
    expect((await listBlocked(h.paths))[0].last_check).toBe("2026-10-12T12:00:00.000Z");
    // Nothing moved and the interval has not passed: no second read.
    h.setNow(new Date(Date.parse("2026-10-12T12:00:00Z") + (BLOCK_RECHECK_S - 1) * 1000));
    await h.s.tick();
    expect(world.calls).toHaveLength(1);
    // The interval passed and the check is still red: one more read, still blocked.
    h.setNow(new Date(Date.parse("2026-10-12T12:00:00Z") + BLOCK_RECHECK_S * 1000));
    await h.s.tick();
    expect(world.calls).toHaveLength(2);
    expect(await listBlocked(h.paths)).toHaveLength(1);
    // Main moves and is green there: resumed at once.
    moveMain(h, { "fix.txt": "x\n" });
    world.conclusion = "success";
    const t = await h.s.tick();
    expect(t.claimed).toEqual([7]);
    expect(await listBlocked(h.paths)).toEqual([]);
  }, 30_000);

  it("a pending check on main does not resume (AC-7)", async () => {
    const world = { calls: [] as string[], conclusion: null as string | null, status: "in_progress" };
    const h = await setup([...routes([waiting(["validated", "class:product", "in-progress"])]), checkRoute(world)], 1, holdingDrive().drive);
    h.deps.cfg.required_checks = ["test"];
    await block(h, { kind: "main_green", check: "test", main_sha: "0".repeat(40) });
    await h.s.tick();
    expect(await listBlocked(h.paths)).toHaveLength(1);
  }, 30_000);

  it("takes a free slot only: a full slot leaves the record, and answered resumes come first (AC-4, AC-7)", async () => {
    const log = grantLog();
    const h = await setup(answeredRoutes([issue(3, ["validated", "class:product", "in-progress"])]), 1, log.drive);
    await block(h, { kind: "paths", paths: ["a.txt"], main_sha: "0".repeat(40) }, { issue: 3, state: blockedState({ issue: 3 }) });
    await writePaused(h.paths, record());
    const t = await h.s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(log.grants).toEqual(["chain:7"]);
    expect(await listBlocked(h.paths)).toHaveLength(1);
    await rmClaim(h, 7);
    await log.release("chain:7");
    const t2 = await h.s.tick();
    await settle();
    expect(t2.claimed).toEqual([3]);
    expect(log.grants).toEqual(["chain:7", "chain:3"]);
    await log.release("chain:3");
  }, 30_000);

  it("removes a claim a crash left next to a blocked record (AC-4)", async () => {
    const h = await setup(routes([waiting(["validated", "class:product", "in-progress"])]), 1, holdingDrive().drive);
    await block(h, { kind: "paths", paths: ["a.txt"], main_sha: mainHead(h) });
    await readyClaim(h, 7);
    await h.s.tick();
    expect(await readClaim(h.paths, 7)).toBeNull();
    expect(await listBlocked(h.paths)).toHaveLength(1);
  }, 30_000);

  it("drops the record of a closed issue", async () => {
    const h = await setup(routes([issue(9)]), 1, holdingDrive().drive);
    await block(h, { kind: "paths", paths: ["a.txt"], main_sha: mainHead(h) });
    await h.s.tick();
    expect(await listBlocked(h.paths)).toEqual([]);
    expect(serviceRecords(h.paths).find((r) => r.kind === "blocked-dropped")).toMatchObject({ issue: 7 });
  }, 30_000);
});
describe("Scheduler.tick: the disk sweep step (spec 064)", () => {
  it("sweeps a stale test root in the tick and writes its report", async () => {
    const before = process.env.CLAUDE_CODE_TMPDIR;
    const tmp = join(tmpdir(), `loop-sweep-${process.pid}-${Date.now()}`);
    mkdirSync(join(tmp, "panelator-test-old"), { recursive: true });
    try {
      process.env.CLAUDE_CODE_TMPDIR = tmp;
      const { s, deps, paths } = await setup(routes([]));
      const old = new Date(deps.now().getTime() - 3 * 3600_000);
      utimesSync(join(tmp, "panelator-test-old"), old, old);
      const t = await s.tick();
      expect(t.errors).toEqual([]);
      expect(existsSync(join(tmp, "panelator-test-old"))).toBe(false);
      expect(JSON.parse(readFileSync(paths.diskSweep, "utf8")).volumes[0]).toMatchObject({ path: tmp, removed: 1 });
      expect(serviceRecords(paths).filter((r) => r.kind === "disk-sweep")).toHaveLength(1);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
      else process.env.CLAUDE_CODE_TMPDIR = before;
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("a failing sweep is reported in errors and the tick still finishes", async () => {
    const { s, deps, allowErrors } = await setup(routes([issue(1)]));
    allowErrors(/^sweep: /);
    deps.agentsDir = join(deps.agentsDir, "missing");
    const t = await s.tick();
    expect(t.errors.some((e) => e.startsWith("sweep: "))).toBe(true);
    expect(t.eligible).toBe(1);
  }, 30_000);

  it("a tick with the checked-in registry lists check runs for origin/main and reports no error (spec 081 AC-4)", async () => {
    const { s, deps, gh, pair } = await setup(routes([]));
    const { loadRegistry } = await import("../src/standing/registry.ts");
    const { EVENT_NAMES } = await import("../src/standing/events.ts");
    const { registryActionsCheck } = await import("../src/actions/index.ts");
    deps.registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
    deps.cfg.required_checks = ["test"];
    const sha = git(pair.repo, "rev-parse", "origin/main").trim();
    const t = await s.tick();
    expect(t.errors).toEqual([]);
    const listed = gh.calls.filter((c) => c.method === "GET" && c.url.includes("/check-runs"));
    expect(listed.map((c) => c.url)).toEqual([expect.stringContaining(`/commits/${sha}/check-runs`)]);
    expect(gh.unmatched.filter((u) => JSON.stringify(u).includes("/check-runs"))).toEqual([]);
  }, 30_000);
});
describe("Scheduler: sleep inhibitor while runs are in flight", () => {
  it("takes the lock before a run's harness starts and releases it only when the last of two overlapping runs ends", async () => {
    const log = grantLog();
    const rec = recordingInhibitor();
    const heldAtStart: boolean[] = [];
    const h = await setup(routes([]), 2, async (d, claim) => { heldAtStart.push(rec.inhibitor.held); return log.drive(d, claim, () => false); });
    h.deps.inhibitor = rec.inhibitor;
    await withStanding(h, log);
    const standing = h.deps.runStanding!;
    h.deps.runStanding = async (...a) => { heldAtStart.push(rec.inhibitor.held); return standing(...a); };
    await readyClaim(h, 3);
    await h.s.tick();
    await settle();
    expect(log.grants.sort()).toEqual(["chain:3", "standing"]);
    expect(heldAtStart).toEqual([true, true]);
    expect(rec.spawned).toEqual(["standing action-audit"]);
    await rmClaim(h, 3);
    await log.release("chain:3");
    expect(rec.inhibitor.held).toBe(true);
    expect(rec.killed).toEqual([]);
    await log.release("standing");
    expect(rec.inhibitor.held).toBe(false);
    expect(rec.killed).toEqual(["standing action-audit"]);
    expect(rec.logged.map((r) => r.kind)).toEqual(["inhibit-acquired", "inhibit-released"]);
  }, 30_000);

  it("takes the lock again for the next run and releases it when the service stops", async () => {
    const log = grantLog();
    const rec = recordingInhibitor();
    const h = await setup(routes([]), 1, log.drive);
    h.deps.inhibitor = rec.inhibitor;
    await withStanding(h, log);
    await h.s.tick();
    await settle();
    await log.release("standing");
    expect(rec.inhibitor.held).toBe(false);
    let ticks = 0;
    const tick = h.s.tick.bind(h.s);
    h.s.tick = async () => { const t = await tick(); if (++ticks === 1) h.s.stop("SIGTERM"); return t; };
    const running = h.s.run();
    for (let i = 0; i < 200 && log.grants.length < 2; i++) await settle();
    expect(rec.inhibitor.held).toBe(true);
    await log.release("standing");
    await running;
    expect(rec.inhibitor.held).toBe(false);
    expect(rec.spawned).toEqual(["standing action-audit", "standing action-audit"]);
    expect(rec.killed).toHaveLength(2);
    expect(rec.logged.map((r) => r.kind)).toEqual(["inhibit-acquired", "inhibit-released", "inhibit-acquired", "inhibit-released"]);
  }, 30_000);
});
describe("Scheduler.tick AWS step (spec 022 AC-1, AC-2, AC-10, AC-11; spec 050 AC-5, AC-8)", () => {
  const tickLines = (paths: ReturnType<typeof statePaths>) => readFileSync(paths.serviceLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.kind === "tick");
  async function awsSetup(opts: Parameters<typeof awsWorld>[0] = {}) {
    const h = await setup(routes([]));
    const w = await awsWorld({ start: "2026-10-12T12:00:00Z", ...opts });
    const { ParameterStore } = await import("../src/parameters/store.ts");
    const { loadParameterDefinitions } = await import("../src/parameters/definitions.ts");
    const { loadRegistry } = await import("../src/standing/registry.ts");
    const { EVENT_NAMES } = await import("../src/standing/events.ts");
    const { registryActionsCheck } = await import("../src/actions/index.ts");
    h.deps.registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
    h.deps.parameters = new ParameterStore(h.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), h.deps.cfg, h.deps.registry));
    for (const def of Object.values(h.deps.registry)) def.trigger = { cron: "0 0 1 1 *" } as never;
    w.ctx.paths = h.paths;
    w.ctx.parameters = h.deps.parameters;
    w.ctx.notifier = h.deps.notifier;
    h.deps.aws = w.ctx;
    const setNow = (d: Date) => { h.setNow(d); w.clock.now = d; };
    w.ctx.now = () => w.clock.now;
    return { ...h, w, setNow };
  }

  it("logs aws: off once, with the reason, and the tick field says why (no aws block)", async () => {
    const { s, w, paths } = await awsSetup({ config: null });
    await s.tick();
    await s.tick();
    expect(w.logs.filter((l) => l.kind === "aws-off")).toHaveLength(1);
    expect(tickLines(paths).every((t) => t.aws.off === "no aws block in agents/scheduler.yaml")).toBe(true);
    expect(w.calls()).toEqual([]);
  }, 30000);

  it("pulls once, keeps the field, pulls again after the interval, and follows a param set without a pull", async () => {
    const { s, w, deps, paths, setNow } = await awsSetup({ cap: 100 });
    await deps.parameters!.setParameter("aws_cap_usd", 100, "maintainer");
    w.setCost(20);
    const info = await s.tick();
    expect(info.aws).toMatchObject({ actual_usd: 20, cap_usd: 100, forecast_usd: 51.67 });
    await s.tick();
    expect(w.calls().filter((c) => c[0] === "ce")).toHaveLength(1);
    expect(tickLines(paths).at(-1).aws).toMatchObject({ actual_usd: 20, forecast_usd: 51.67, cap_usd: 100, reserved_usd: 0, as_of: "2026-10-12T12:00:00.000Z" });
    await deps.parameters!.setParameter("aws_cap_usd", 50, "maintainer");
    await s.tick();
    expect(w.calls().filter((c) => c[0] === "ce")).toHaveLength(1);
    expect(tickLines(paths).at(-1).aws).toMatchObject({ cap_usd: 50 });
    setNow(new Date("2026-10-13T13:00:00Z"));
    await s.tick();
    expect(w.calls().filter((c) => c[0] === "ce")).toHaveLength(2);
  }, 30000);

  it("at cap 0 pulls nothing, shows pull_skipped, and records the skip once", async () => {
    const { s, w, paths } = await awsSetup({ cap: 0 });
    await s.tick();
    await s.tick();
    expect(tickLines(paths).at(-1).aws).toEqual({ actual_usd: null, forecast_usd: null, cap_usd: 0, reserved_usd: null, as_of: null, pull_skipped: "cap 0" });
    expect(w.calls().map((c) => c[0])).toEqual(["sts"]);
    expect(w.logs.filter((l) => l.kind === "aws-pull-skipped")).toHaveLength(1);
  }, 30000);
});
describe("the constructor's default emitEvent (spec 094 AC-5)", () => {
  async function withRegistry(emitEvent?: SchedulerDeps["emitEvent"]) {
    const h = await setup(routes([]));
    const { loadRegistry } = await import("../src/standing/registry.ts");
    const { EVENT_NAMES } = await import("../src/standing/events.ts");
    const { registryActionsCheck } = await import("../src/actions/index.ts");
    const { loadParameterDefinitions } = await import("../src/parameters/definitions.ts");
    const { ParameterStore } = await import("../src/parameters/store.ts");
    const { initializeAgents, readAgentState } = await import("../src/standing/state.ts");
    const registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
    h.deps.registry = registry;
    h.deps.parameters = new ParameterStore(h.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), h.deps.cfg, registry));
    await initializeAgents(h.paths, registry, h.deps.parameters, h.deps.now());
    h.deps.emitEvent = emitEvent;
    new Scheduler(h.deps);
    const events = async (name: string) => (await readAgentState(h.paths, name))!.pending_events;
    return { h, events };
  }

  it("delivers, excludes the named agent, uses the clock and rejects an unknown name", async () => {
    const { h, events } = await withRegistry();
    const emitEvent = h.deps.emitEvent!;
    expect(typeof emitEvent).toBe("function");
    const infra = await events("infra-health");
    await emitEvent("issue_abandoned", { issue: 3 });
    const at = h.deps.now().toISOString();
    expect(await events("findings-filer")).toEqual([{ event: "issue_abandoned", payload: { issue: 3 }, at }]);
    expect(await events("infra-health")).toEqual(infra);
    await emitEvent("issue_abandoned", { issue: 4 }, "findings-filer");
    expect(await events("findings-filer")).toHaveLength(1);
    await emitEvent("infra_alarm", { kind: "network_outage" });
    expect((await events("infra-health")).filter((e) => e.event === "infra_alarm")).toHaveLength(1);
    expect(await events("findings-filer")).toHaveLength(1);
    await expect(emitEvent("nope", {})).rejects.toThrow("unknown event nope");
  }, 30_000);

  it("leaves a supplied emitEvent in place", async () => {
    const stub = async () => {};
    const { h } = await withRegistry(stub);
    expect(h.deps.emitEvent).toBe(stub);
  }, 30_000);

  it("sets none when there is no registry", async () => {
    const h = await setup(routes([]));
    new Scheduler(h.deps);
    expect(h.deps.emitEvent).toBeUndefined();
  }, 30_000);
});
describe("Scheduler.tick credential_expiry producer (spec 099 AC-3)", () => {
  it("emits once per day for an entry near expiry, reads the index only, and survives a failing store", async () => {
    const { s, deps, paths, setNow, allowErrors } = await setup(routes([]));
    allowErrors(/^credential expiry/);
    const { CredentialStore } = await import("../src/credentials/store.ts");
    const { loadCatalogue } = await import("../src/credentials/catalogue.ts");
    const store = new CredentialStore({ dir: join(paths.root, "cred-store"), systemdCreds: join(import.meta.dirname, "helpers", "fake-systemd-creds") });
    await store.writeSecret("fake-token", "s", "maintainer");
    const idx = await store.readIndex();
    idx["fake-token"]!.expires_at = "2026-10-15T12:00:00Z";
    writeFileSync(join(store.dir, "index.json"), JSON.stringify(idx));
    const catalogue = loadCatalogue(join(import.meta.dirname, "fixtures", "test-catalogue.yaml"), { profiles: ["backend"], agents: [] });
    const events: unknown[] = [];
    deps.emitEvent = async (e: string, p: unknown) => { events.push([e, p]); };
    deps.credentials = { store, catalogue, warnDays: 7 };
    setNow(new Date("2026-10-12T12:00:00Z"));
    await s.tick();
    expect(events).toEqual([["credential_expiry", { name: "fake-token", expires_at: "2026-10-15T12:00:00Z", last_check: null }]]);
    setNow(new Date("2026-10-12T14:00:00Z"));
    await s.tick();
    expect(events).toHaveLength(1);
    setNow(new Date("2026-10-13T14:00:00Z"));
    await s.tick();
    expect(events).toHaveLength(2);
    writeFileSync(join(store.dir, "index.json"), "{");
    setNow(new Date("2026-10-13T16:00:00Z"));
    const info = await s.tick();
    expect(info.errors.some((e) => e.startsWith("credential expiry"))).toBe(true);
}, 60000);
  it("a failed last check produces an event, expiry none with ok or null never does", async () => {
    const { expiryEvents } = await import("../src/credentials/check.ts");
    const { CredentialStore } = await import("../src/credentials/store.ts");
    const { loadCatalogue } = await import("../src/credentials/catalogue.ts");
    const dir = join(tmpdir(), `exp-${Date.now()}`);
    const store = new CredentialStore({ dir, systemdCreds: join(import.meta.dirname, "helpers", "fake-systemd-creds") });
    await store.writeSecret("fake-token", "s", "maintainer");
    const catalogue = loadCatalogue(join(import.meta.dirname, "fixtures", "test-catalogue.yaml"), { profiles: ["backend"], agents: [] });
    const ctx = { store, catalogue, warnDays: 7, statePath: join(dir, "exp-state.json"), now: () => new Date("2026-10-12T12:00:00Z") };
    expect(await expiryEvents(ctx)).toEqual([]);
    await store.writeCheck("fake-token", { last_checked_at: "x", last_check: "ok" });
    expect(await expiryEvents(ctx)).toEqual([]);
    await store.writeCheck("fake-token", { last_checked_at: "x", last_check: "failed: 401" });
    expect(await expiryEvents(ctx)).toHaveLength(1);
    expect(await expiryEvents(ctx)).toEqual([]);
  });
});
