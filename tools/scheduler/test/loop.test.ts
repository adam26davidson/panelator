import { openIndex } from "../src/events/index.ts";
import {TelegramClient} from '../src/telegram/client.ts';
import {telegramChannel} from '../src/telegram/channel.ts';
import {fakeTelegram} from './helpers/fake-telegram.ts';
import {emptyTelegram} from '../src/state/paused.ts';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { MAX_CHAIN_FAILURES, Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, readClaim, writeClaim } from "../src/state/claims.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import { writeToken } from "../src/state/token.ts";
import { HISTORY_ENTRY_MAX, initialChainState, ledgerOf } from "../src/chain/machine.ts";
import { step } from "../src/chain/driver.ts";
import { questionMarker } from "../src/chain/question.ts";
import { writeLedger } from "../src/state/ledger.ts";
import { listPaused, writePaused, type PausedRecord } from "../src/state/paused.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { Claim } from "../src/state/claims.ts";
import type { Question } from "../src/types.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";

const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };
const issue = (n: number, labels = ["validated", "class:product"]) => ({ number: n, title: `i${n}`, body: "Spec: specs/010-thing/spec.md", user: BOT, labels: labels.map((name) => ({ name })), created_at: `2026-10-0${n}T00:00:00Z`, updated_at: "2026-10-12T00:00:00Z" });

function routes(issues: unknown[], labelsNow: Record<number, string[]> = {}, comments: Record<number, unknown[]> = {}): Route[] {
  let commentId = 900;
  return [
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)\/comments$/, reply: (m, _b, url) => ({ body: comments[Number(m[1])] ?? [], headers: pageLink(url, 1, 1) }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: issues, headers: pageLink(url, 1, 1) }) },
    { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: issues.length } } } } }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/\d+\/timeline$/, reply: () => ({ body: [] }) },
    { method: "GET", path: /^\/repos\/o\/r\/issues\/(\d+)$/, reply: (m) => ({ body: { ...issue(Number(m[1])), labels: (labelsNow[Number(m[1])] ?? ["validated", "in-progress"]).map((name) => ({ name })) } }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/labels$/, reply: () => ({ body: [] }) },
    { method: "DELETE", path: /^\/repos\/o\/r\/issues\/\d+\/labels\/[^/]+$/, reply: () => ({ body: {} }) },
    { method: "POST", path: /^\/repos\/o\/r\/issues\/\d+\/comments$/, reply: () => ({ status: 201, body: { id: ++commentId, created_at: "2026-10-12T12:00:00Z" } }) },
  ];
}

type Drive = NonNullable<ConstructorParameters<typeof Scheduler>[1]>["driveChain"];
async function setup(rs: Route[], slots = 1, drive?: Drive, specFile = spec) {
  const pair = repoPair(withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": specFile }, "specs/010-thing/spec.md"));
  const paths = statePaths(join(pair.root, "state"));
  await ensureStateDirs(paths);
  const gh = mockGitHub(rs);
  const notifications: Notification[] = [];
  const started: number[] = [];
  let now = new Date("2026-10-12T12:00:00Z");
  let mono = 0;
  const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", slots, state_dir: paths.root, poll_interval_s: 5 };
  const deps: SchedulerDeps = {
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r", { settleDelaysMs: [0, 0, 0] }),
    notifier: { notify: async (n) => { notifications.push(n); } },
    stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
    // the "chain" here is a stub: it records the issue and parks the claim in verify so the test controls time
    adapterFor: () => { throw new Error("not used"); }, systemdScope: false, now: () => now, log: () => {},
    fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
    unitActive: async () => false, stopUnit: async () => {},
    botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
    fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => mono, requestRestart: () => { started.push(-1); },
  };
  const s = new Scheduler(deps, { driveChain: drive ?? (async (_d, claim) => { started.push(claim.issue); return { ...claim, state: { ...claim.state, stage: "verify" } }; }) });
  return { s, deps, gh, notifications, started, paths, pair, setNow: (d: Date) => { now = d; }, setMono: (m: number) => { mono = m; } };
}

describe('Telegram answers and watchdog fallback',()=>{
 it('wake interrupts the watchdog sleep without waiting for its timer',async()=>{
  const {s,deps}=await setup(routes([]));let ticks=0;deps.sleep=()=>new Promise<void>(()=>{});s.tick=async()=>{ticks++;if(ticks===2)s.stop('test');return {eligible:0,claimed:[],released:[],held:0,standing:[],errors:[],restartPending:false};};const running=s.run();await new Promise(r=>setTimeout(r,10));expect(ticks).toBe(1);s.wake();await running;expect(ticks).toBe(2);
 },30000);
 const tgRecord=(issue=7):PausedRecord=>({...record(),issue,nonce:`nonce-${issue}`,telegram:{...emptyTelegram(),message_id:issue*10,sent:true,sent_at:'2026-10-10T00:00:00Z',thread_message_ids:[issue*10]}});
 const message=(id:number,text:string)=>({update_id:id,message:{message_id:1000+id,date:Date.parse('2026-10-12T11:00:00Z')/1000,chat:{id:42},text}});
 it('journals a reply before confirmation, redelivery makes one issue record and one delayed ack',async()=>{
  const {s,deps,paths,gh}=await setup(routes([waiting()]),1,firstStep);const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));
  try{await writePaused(paths,tgRecord());const u=message(1,'Use the file store.');await s.handleTelegramUpdate(u);expect(server.sent).toHaveLength(0);expect((await listPaused(paths))[0].phase).toBe('resuming');await s.handleTelegramUpdate(u);await s.confirmTelegramUpdate(u);await s.confirmTelegramUpdate(u);expect(server.sent).toHaveLength(1);expect(server.sent[0].text).toContain('Picked up your reply from 11:00');expect(gh.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/comments'))).toHaveLength(1);await s.tick();expect(await listPaused(paths)).toEqual([]);expect(logLines(paths).filter(e=>e.event==='answered')).toHaveLength(1);}finally{await server.close();}
 },30000);
 it('keeps free text while two questions are open, then a selection answers the right one',async()=>{
  const {s,deps,paths}=await setup(routes([]));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('secret',42,server.url));
  try{await writePaused(paths,tgRecord(7));await writePaused(paths,tgRecord(8));await s.handleTelegramUpdate(message(2,'Choose the file store'));expect(server.sent[0].text).toContain('#7');expect(server.sent[0].text).toContain('#8');const u={update_id:3,callback_query:{id:'pick',data:'pick:8',message:{message_id:1,date:1,chat:{id:42}}}};await s.handleTelegramUpdate(u);await s.confirmTelegramUpdate(u);const all=await listPaused(paths);expect(all.find(r=>r.issue===7)?.phase).toBe('paused');expect(all.find(r=>r.issue===8)?.answer).toBe('Choose the file store');expect(server.answeredCallbacks).toHaveLength(1);}finally{await server.close();}
 },30000);
 it('answers /questions and no-open messages once per update',async()=>{
  const {s,deps}=await setup(routes([]));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('secret',42,server.url));try{const u=message(1,'hello');await s.handleTelegramUpdate(u);await s.handleTelegramUpdate(u);await s.handleTelegramUpdate(message(2,'/questions'));expect(server.sent.map(m=>m.text)).toEqual(['No open question','No open question']);}finally{await server.close();}
 },30000);
 it('reminds on Telegram, keeps issue comments as an answer path, rejects a later button',async()=>{
  const comments:unknown[]=[];const {s,deps,paths,gh}=await setup(routes([waiting()],{}, {7:comments}),1,firstStep);const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('secret',42,server.url));
  try{await writePaused(paths,{...tgRecord(),asked_at:'2026-10-10T00:00:00Z'});await s.tick();expect(server.sent).toHaveLength(1);expect(server.sent[0].reply_to_message_id).toBe(70);expect(gh.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/comments'))).toHaveLength(0);comments.push(comment(501,ME,'2026-10-12T11:00:00Z','Use file'));await s.tick();await settle();await s.handleTelegramUpdate({update_id:5,callback_query:{id:'late',data:'q:nonce-7:1',message:{message_id:70,date:1,chat:{id:42}}}});expect(server.sent.at(-1)?.text).toContain('already answered on issue');expect(logLines(paths).filter(e=>e.event==='answered')[0].channel).toBe('issue');}finally{await server.close();}
 },30000);
 it('retries a failed send just once, then waits on the issue',async()=>{
  const {s,deps,paths}=await setup(routes([waiting()]));const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('secret',42,server.url));try{await writePaused(paths,{...record(),telegram:{...emptyTelegram(),send_failures:1}});server.fail('sendMessage',500);await s.tick();await s.tick();expect(server.requests.filter(r=>r.method==='sendMessage')).toHaveLength(1);expect((await listPaused(paths))[0].telegram?.send_failures).toBe(2);}finally{await server.close();}
 },30000);
});

describe("Scheduler.tick", () => {
  it("records a completed main check once across two service instances", async () => {
    const { s, deps, paths, gh } = await setup([
      ...routes([]),
      { method: "GET", path: /^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 42, name: "test", status: "completed", conclusion: "success" }] } }) },
    ]);
    const { loadRegistry } = await import("../src/standing/registry.ts");
    const { EVENT_NAMES } = await import("../src/standing/events.ts");
    const { registryActionsCheck } = await import("../src/actions/index.ts");
    deps.registry = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
    deps.cfg.required_checks = ["test"];
    await s.tick(); s.stop("restart test");
    const restarted = new Scheduler(deps);
    await restarted.tick(); restarted.stop("test done");
    expect(gh.calls.filter(c => c.url.includes("/check-runs"))).toHaveLength(2);
    const db = openIndex(paths);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'ci.check' AND json_extract(payload, '$.check') = 'test'").get()).toEqual({ n: 1 });
    db.close(); expect(gh.unmatched).toEqual([]);
  }, 30000);
  it('a due standing agent takes the free slot before shortlist and never overlaps itself',async()=>{
    const {s,deps,paths}=await setup(routes([issue(1)]));
    const {loadRegistry}=await import('../src/standing/registry.ts');
    const {EVENT_NAMES}=await import('../src/standing/events.ts');
    const {registryActionsCheck}=await import('../src/actions/index.ts');
    const {loadParameterDefinitions}=await import('../src/parameters/definitions.ts');
    const {ParameterStore}=await import('../src/parameters/store.ts');
    const {initializeAgents,readAgentState,writeAgentState}=await import('../src/standing/state.ts');
    const all=loadRegistry(join(agentsDir,'standing'),EVENT_NAMES,registryActionsCheck(join(agentsDir,'actions.yaml')));
    deps.registry={'action-audit':all['action-audit']};deps.parameters=new ParameterStore(paths,loadParameterDefinitions(join(agentsDir,'parameters.yaml'),deps.cfg,deps.registry));
    await initializeAgents(paths,deps.registry,deps.parameters,deps.now());
    const state=(await readAgentState(paths,'action-audit'))!;await writeAgentState(paths,'action-audit',{...state,next_run:deps.now().toISOString()});
    let calls=0,finish!:()=>void;const pending=new Promise<void>(r=>{finish=r;});deps.runStanding=async()=>{calls++;await pending;};
    expect((await s.tick()).claimed).toEqual([]);expect(s.active).toBe(1);expect((await s.tick()).claimed).toEqual([]);expect(calls).toBe(1);
    finish();await new Promise(r=>setTimeout(r,20));expect(s.active).toBe(0);
  },30000);
  it("claims only as many issues as there are slots, in rank order, and labels the rest of the decisions (AC-1, AC-2, AC-5)", async () => {
    const { s, gh, started, paths } = await setup(routes([issue(2), issue(1), issue(3, ["validated"])]));
    const t = await s.tick();
    expect(t.held).toBe(0);
    // No class/spec is system work, preferred at the initial 0.75 work share.
    expect(t.claimed).toEqual([3]);
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([3]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([3]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/3/labels")?.body).toEqual({ labels: ["in-progress"] });
    const t2 = await s.tick();
    expect(t2.claimed).toEqual([]);
  }, 30_000);

  it("claims two with slots: 2", async () => {
    const { s } = await setup(routes([issue(2), issue(1)]), 2);
    expect((await s.tick()).claimed).toEqual([1, 2]);
  }, 30_000);

  it("claims an issue whose spec is missing, to start at the spec stage, with no label but in-progress (spec 006 AC-19)", async () => {
    const bad = { ...issue(4), body: "Spec: specs/999-none/spec.md" };
    const { s, gh, paths, notifications } = await setup(routes([bad]));
    const t = await s.tick();
    expect(t.claimed).toEqual([4]);
    const [c] = await listClaims(paths);
    expect(c.state.specProblem).toMatch(/not found on main/);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/labels")).map((c) => c.body)).toEqual([{ labels: ["in-progress"] }]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))).toBeUndefined();
    expect(notifications).toEqual([]);
  }, 30_000);

  it("seeds a new claim from the issue's escalation ledger (spec 006 AC-7)", async () => {
    const { s, paths } = await setup(routes([issue(7)]));
    await writeLedger(paths, 7, ledgerOf({ ...initialChainState(7), rescues: 1, history: ["plan failed"] }));
    expect((await s.tick()).claimed).toEqual([7]);
    const [c] = await listClaims(paths);
    expect(c.state.rescues).toBe(1);
    expect(c.state.history).toEqual(["plan failed"]);
  }, 30_000);

  it("labels a UI issue without design artifacts needs-design-stage once, with its comment and one notification (spec 006 AC-20)", async () => {
    const ui = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8");
    const rs = routes([issue(4)]);
    const { s, gh, notifications, paths } = await setup(rs, 1, undefined, ui);
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/4/labels").map((c) => c.body)).toEqual([{ labels: ["needs-design-stage"] }]);
    expect(gh.calls.filter((c) => c.url === "/repos/o/r/issues/4/comments").map((c) => c.body)).toEqual([{ body: expect.stringContaining("spec E will provide the design stage") }]);
    expect(notifications).toEqual([expect.objectContaining({ issue: 4, label: "needs-design-stage" })]);
    rs[1] = { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: [issue(4, ["validated", "class:product", "needs-design-stage"])], headers: pageLink(url, 1, 1) }) };
    gh.calls.length = 0;
    await s.tick();
    expect(gh.calls.filter((c) => c.method === "POST")).toEqual([expect.objectContaining({ url: "/graphql" })]);
    expect(notifications).toHaveLength(1);
  }, 30_000);

  it("does not claim when the issue list is incomplete (review focus 1)", async () => {
    const rs = routes([issue(1)]);
    rs[2] = { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 3 } } } } }) };
    const { s } = await setup(rs);
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(t.errors[0]).toMatch(/incomplete/);
  }, 30_000);

  it("releases a stale claim whose issue lost in-progress on GitHub (review focus 2)", async () => {
    const { s, deps, paths, pair } = await setup(routes([], { 7: ["validated"] }));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("releases a claim with no run and no activity for the liveness window, saving a patch (AC-15)", async () => {
    const { s, deps, paths, pair, gh, setNow } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "implement" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([7]);
    expect(readdirSync(paths.patches)).toHaveLength(1);
    expect(gh.calls.find((c) => c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url.endsWith("/labels/in-progress"))).toBeTruthy();
    // Spec 012 AC-2: the expiry bypasses step(), and still records the chain's leaving implement.
    const db = openIndex(paths);
    const rows = db.prepare("SELECT kind, issue, payload FROM events WHERE kind IN ('chain.transition', 'issue.released') ORDER BY at, rowid").all() as { kind: string; issue: number; payload: string }[];
    db.close();
    expect(rows.map((r) => [r.kind, r.issue, JSON.parse(r.payload)])).toEqual([
      ["chain.transition", 7, expect.objectContaining({ from: "implement", to: "released", event: "liveness_expired", track: "issue" })],
      ["issue.released", 7, { reason: "stopped" }],
    ]);
  }, 30_000);

  it("does not expire or start a chain postponed to a quota reset still ahead (spec 013 AC-5)", async () => {
    const { s, paths, pair, setNow, started } = await setup(routes([]));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "waiting", resumeStage: "plan", postponedUntil: "2026-10-12T16:10:00Z" }, worktree: wt, started_at: "2026-10-12T00:00:00Z", last_activity_at: "2026-10-12T09:00:00Z", run_id: null });
    setNow(new Date("2026-10-12T12:30:00Z"));
    const t = await s.tick();
    expect(t.released).toEqual([]);
    expect(started).toEqual([]);
    expect(await listClaims(paths)).toHaveLength(1);
  }, 30_000);

  it("resumes a claim found on disk after a restart (AC-31)", async () => {
    const { s, deps, paths, pair, started } = await setup(routes([]));
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await s.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(started).toEqual([7]);
  }, 30_000);

  it("flags a restart when tools/scheduler changed on main (AC-17)", async () => {
    const { s, deps, started } = await setup(routes([]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(started).toEqual([-1]);
  }, 30_000);

  it("releases a chain whose driveChain rejects MAX_CHAIN_FAILURES times with a chain_error: the error, a finding, the ledger (ruling 7b, C7)", async () => {
    expect(MAX_CHAIN_FAILURES).toBe(3);
    const errors: Record<string, unknown>[] = [];
    let calls = 0;
    const { s, deps, paths, pair, gh } = await setup(routes([]), 1, async () => { calls++; throw new Error("boom"); });
    deps.log = (rec) => { if (rec.kind === "error") errors.push(rec); };
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    for (let i = 1; i <= 3; i++) {
      const t = await s.tick();
      expect(t.released).toEqual([]);
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toHaveLength(i);
      expect(errors[i - 1]).toMatchObject({ kind: "error", issue: 7, error: "boom" });
    }
    const t4 = await s.tick();
    expect(calls).toBe(3);
    expect(t4.released).toEqual([7]);
    expect(await listClaims(paths)).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toBeTruthy();
    expect(gh.calls.find((c) => c.method === "DELETE" && c.url === "/repos/o/r/issues/7/labels/in-progress")).toBeTruthy();
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"chain-error"');
    // C7: the comment carries the real error, a finding is queued, and the ledger counts the release.
    const comment = gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")!.body as { body: string };
    expect(comment.body).toContain("boom");
    expect(readFileSync(paths.findingsQueue, "utf8")).toContain("chain released after repeated scheduler errors");
    const ledger = JSON.parse(readFileSync(join(paths.escalations, "7.json"), "utf8"));
    expect(ledger).toMatchObject({ chainErrors: 1, chainFailures: null });
    expect(ledger.history.at(-1)).toBe("chain error in verify (counted): boom");
  }, 30_000);

  it("keeps the failure count across a restart: a new Scheduler reads it from the claim (C7)", async () => {
    let calls = 0;
    const { deps, paths, pair } = await setup(routes([]), 1, async () => { calls++; throw new Error("boom"); });
    await writeClaim(paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    for (let i = 0; i < 2; i++) {
      await new Scheduler(deps, { driveChain: async () => { calls++; throw new Error(`boom ${i}`); } }).tick();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await listClaims(paths))[0].state.chainFailures).toEqual({ count: 2, last: "boom 1" });
    expect(JSON.parse(readFileSync(join(paths.escalations, "7.json"), "utf8")).chainFailures).toEqual({ count: 2, last: "boom 1" });
    // A drive that returns resets the count.
    await new Scheduler(deps, { driveChain: async (_d, c) => c }).tick();
    await new Promise((r) => setTimeout(r, 100));
    expect((await listClaims(paths))[0].state.chainFailures).toBeNull();
    expect(calls).toBe(2);
    // Tm6: the error kept is clipped like a history entry.
    await new Scheduler(deps, { driveChain: async () => { throw new Error("x".repeat(HISTORY_ENTRY_MAX + 50)); } }).tick();
    await new Promise((r) => setTimeout(r, 100));
    expect((await listClaims(paths))[0].state.chainFailures?.last).toHaveLength(HISTORY_ENTRY_MAX);
  }, 30_000);

  it("records a freshness error and still lists and claims when fast-forward fails (ruling 7c)", async () => {
    const { s, deps } = await setup(routes([issue(1)]));
    deps.fastForward = async () => { throw new Error("not a fast-forward"); };
    const t = await s.tick();
    expect(t.errors[0]).toMatch(/freshness/);
    expect(t.claimed).toEqual([1]);
  }, 30_000);
  it("writes the claim file before the claim label, so a failed claim leaves no orphaned in-progress (review fix 1)", async () => {
    const { s, gh, paths } = await setup(routes([issue(1)]));
    rmSync(paths.worktrees, { recursive: true, force: true });
    writeFileSync(paths.worktrees, "not a directory\n");
    const t = await s.tick();
    expect(t.errors[0]).toMatch(/claim 1/);
    expect(t.claimed).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")).toBeUndefined();
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("claims nothing once a restart is pending and requests the restart from the idle tick (review fix 2, AC-17)", async () => {
    const { s, deps, gh, started } = await setup(routes([issue(1)]));
    deps.fastForward = async () => ({ moved: true, changedPaths: ["tools/scheduler/src/x.ts"] });
    const t = await s.tick();
    expect(t.restartPending).toBe(true);
    expect(t.claimed).toEqual([]);
    expect(gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/issues/1/labels")).toBeUndefined();
    expect(started).toContain(-1);
  }, 30_000);

  it("refreshes token.json at the start of a tick when it expires within 5 minutes (I3)", async () => {
    const { s, deps, paths } = await setup(routes([]));
    let refreshes = 0;
    deps.refreshToken = async () => { refreshes++; };
    await writeToken(paths, { token: "ghs_x", expires_at: new Date(deps.now().getTime() + 2 * 60_000).toISOString() });
    await s.tick();
    expect(refreshes).toBe(1);
  }, 30_000);
});

const Q: Question = { kind: "technical", question: "Which store?", options: [{ label: "a", cost: "cheap" }, { label: "b", cost: "dear" }], recommendation: "a" };
const ME = "adam26davidson";
const BOT_LOGIN = "panelator-pipeline[bot]";
const comment = (id: number, login: string, at: string, body: string) => ({ id, user: { login }, created_at: at, body });
const pausedState = () => ({ ...initialChainState(7), stage: "paused" as const, askingStage: "plan" as const, question: Q, rescues: 1 });
const record = (over: Partial<PausedRecord> = {}): PausedRecord => ({
  issue: 7, phase: "paused", state: pausedState(), question: Q, asking_stage: "plan", nonce: "nonce-7",
  question_comment_id: 500, asked_at: "2026-10-12T08:00:00Z", reminded: false, answer: null, reply_comment_id: null, ...over,
});
const waiting = (labels = ["validated", "class:product", "needs-decision"]) => issue(7, labels);
/** The real first step of the chain, so a resume's `answered` event is applied as the driver applies it. */
const firstStep: Drive = async (d, claim) => (await step(d, claim)).claim;
const settle = () => new Promise((r) => setTimeout(r, 100));
const logLines = (paths: { questionsLog: string }) => { try { return readFileSync(paths.questionsLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const labelCalls = (gh: { calls: { method: string; url: string; body: unknown }[] }, n: number) =>
  gh.calls.filter((c) => c.url.startsWith(`/repos/o/r/issues/${n}/labels`)).map((c) => (c.method === "POST" ? `+${(c.body as { labels: string[] }).labels.join(",")}` : `-${decodeURIComponent(c.url.split("/").pop()!)}`));

describe("Scheduler.tick: paused issues (spec 006)", () => {
  it("resumes a paused issue on the maintainer's reply, ahead of a priority issue (AC-15, AC-18)", async () => {
    const rs = routes([waiting(), issue(8, ["validated", "class:product", "priority"])], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });
    const { s, gh, paths, deps } = await setup(rs, 1, firstStep);
    await writePaused(paths, record());
    const t = await s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([7]);
    expect(labelCalls(gh, 7)).toEqual(["+in-progress", "-needs-decision"]);
    expect(labelCalls(gh, 8)).toEqual([]);
    const [c] = await listClaims(paths);
    expect(c.pendingEvent).toBeUndefined();
    // A technical answer asked by plan is recorded by the spec stage in record mode (AC-18).
    expect(c.state).toMatchObject({ stage: "spec", specMode: "record", answer: "Question #500: Use the file store.", answerQuestionId: 500, rescues: 1 });
    expect(await listPaused(paths)).toEqual([]);
    const answered = logLines(paths).filter((e) => e.event === "answered");
    expect(answered).toEqual([{ issue: 7, at: deps.now().toISOString(), event: "answered", asking_stage: "plan", question_comment_id: 500, reply_comment_id: 501, answer: "Use the file store.", question: Q,channel:'issue' }]);
  }, 30_000);

  it("closes a capability-hold issue on the maintainer's answer instead of resuming it (spec 014 AC-8)", async () => {
    const capability = { ...waiting(), title: "The GitHub App cannot create draft security advisories", body: "Capability needed\n\n<!-- panelator-capability:security-advisories -->" };
    const rs = routes([capability], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Granted.")] });
    rs.push({ method: "PATCH", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: {} }) });
    const { s, gh, paths, deps } = await setup(rs, 1, firstStep);
    const events: unknown[] = [];
    // Each event records whether the issue was already closed when it was emitted (round 2, 4).
    deps.emitEvent = async (event, payload) => { events.push({ event, payload, closed: gh.calls.some((c) => c.method === "PATCH" && c.url === "/repos/o/r/issues/7") }); };
    const capQ: Question = { kind: "capability", question: "Grant the App security advisories write?", options: [{ label: "grant", cost: "two minutes" }], recommendation: "grant" };
    await writePaused(paths, record({ question: capQ, asking_stage: "spec", state: { ...pausedState(), askingStage: "spec", question: capQ } }));
    const t = await s.tick();
    await settle();
    expect(t.claimed).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(await listPaused(paths)).toEqual([]);
    expect(gh.calls.filter((c) => c.method === "PATCH" && c.url === "/repos/o/r/issues/7")).toEqual([expect.objectContaining({ body: expect.objectContaining({ state: "closed" }) })]);
    expect(labelCalls(gh, 7)).toEqual(["-needs-decision"]);
    expect(logLines(paths).filter((e) => e.event === "answered")).toEqual([expect.objectContaining({ issue: 7, question_comment_id: 500, reply_comment_id: 501, answer: "Granted." })]);
    expect(events).toEqual([{ event: "maintainer_reply", payload: { issue: 7, question_id: 500 }, closed: true }, { event: "capability_answered", payload: { issue: 7, question_id: 500 }, closed: true }]);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toHaveLength(1);
  }, 30_000);

  it("resumes a capability issue whose paused question is not a capability question (round 2, 1)", async () => {
    const capability = { ...waiting(), title: "The GitHub App cannot create draft security advisories", body: "Capability needed\n\n<!-- panelator-capability:security-advisories -->" };
    const rs = routes([capability], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Yes, build the fallback.")] });
    rs.push({ method: "PATCH", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: {} }) });
    const { s, gh, paths } = await setup(rs, 1, firstStep);
    await writePaused(paths, record({ asking_stage: "spec", state: { ...pausedState(), askingStage: "spec" } }));
    const t = await s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(gh.calls.filter((c) => c.method === "PATCH" && c.url === "/repos/o/r/issues/7")).toEqual([]);
    expect(logLines(paths).filter((e) => e.event === "answered")).toEqual([expect.objectContaining({ answer: "Yes, build the fallback." })]);
  }, 30_000);

  it("does not resume on a maintainer comment older than the question (review focus 1)", async () => {
    const rs = routes([waiting()], {}, { 7: [comment(499, ME, "2026-10-12T09:00:00Z", "earlier"), comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q")] });
    const { s, paths, gh } = await setup(rs, 1, firstStep);
    await writePaused(paths, record());
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(await listPaused(paths)).toHaveLength(1);
    expect(labelCalls(gh, 7)).toEqual([]);
  }, 30_000);

  it("does not claim an issue with a paused record that lacks needs-decision (AC-13)", async () => {
    const { s, paths } = await setup(routes([waiting(["validated", "class:product"])]));
    await writePaused(paths, record());
    expect((await s.tick()).claimed).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
  }, 30_000);

  it("completes a crash mid-pause by adopting the question comment that carries the record's nonce (AC-13, review focus 8)", async () => {
    const rs = routes([waiting(["validated", "class:product", "in-progress"])], {}, { 7: [comment(640, BOT_LOGIN, "2026-10-12T11:00:00Z", `### Question\n\n${questionMarker("nonce-7")}`)] });
    const { s, paths, gh, notifications } = await setup(rs);
    await writePaused(paths, record({ phase: "pausing", question_comment_id: null, asked_at: null }));
    await s.tick();
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"))).toEqual([]);
    expect(await listPaused(paths)).toEqual([expect.objectContaining({ phase: "paused", question_comment_id: 640, asked_at: "2026-10-12T11:00:00Z" })]);
    expect(labelCalls(gh, 7)).toEqual(["+needs-decision", "-in-progress"]);
    expect(notifications.map((n) => n.gate)).toEqual(["question"]);
    expect(logLines(paths).map((e) => [e.event, e.question_comment_id])).toEqual([["sent", 640]]);
  }, 30_000);

  it("posts a new question when only an earlier question with another nonce is on the issue (AC-13)", async () => {
    const rs = routes([waiting()], {}, { 7: [comment(300, BOT_LOGIN, "2026-10-11T11:00:00Z", `### Question\n\n${questionMarker("old-nonce")}`)] });
    const { s, paths, gh } = await setup(rs);
    await writePaused(paths, record({ phase: "pausing", question_comment_id: null, asked_at: null }));
    await s.tick();
    const posted = gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments");
    expect(posted).toHaveLength(1);
    expect((posted[0].body as { body: string }).body.endsWith(questionMarker("nonce-7"))).toBe(true);
    const [r] = await listPaused(paths);
    expect(r).toMatchObject({ phase: "paused", question_comment_id: 901 });
  }, 30_000);

  it("removes the claim a crash mid-pause left on disk, without resuming it (review focus 8)", async () => {
    const { s, paths, pair, started, deps } = await setup(routes([waiting()]));
    await writePaused(paths, record({ phase: "pausing" }));
    await writeClaim(paths, { issue: 7, slot: 0, state: pausedState(), worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: "2026-10-01T00:00:00Z", run_id: null });
    const t = await s.tick();
    await settle();
    expect(started).toEqual([]);
    expect(t.released).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(await listPaused(paths)).toEqual([expect.objectContaining({ phase: "paused" })]);
  }, 30_000);

  it("removes a claim left on disk next to a record already paused", async () => {
    const { s, paths, pair, started, deps } = await setup(routes([waiting()]));
    await writePaused(paths, record());
    await writeClaim(paths, { issue: 7, slot: 0, state: pausedState(), worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    await s.tick();
    await settle();
    expect(started).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(await listPaused(paths)).toHaveLength(1);
  }, 30_000);

  it("finishes a crash mid-resume with no second claim write and no second answered line (AC-15, review focus 8)", async () => {
    const seen: Claim[] = [];
    const drive: Drive = async (d, claim) => { seen.push(claim); return firstStep(d, claim, () => false); };
    const { s, paths, pair, gh } = await setup(routes([waiting(["validated", "class:product", "needs-decision", "in-progress"])]), 1, drive);
    await writePaused(paths, record({ phase: "resuming", answer: "Use the file store.", reply_comment_id: 501 }));
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(paths, { issue: 7, slot: 0, state: pausedState(), worktree: wt, started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null, pendingEvent: { type: "answered", answer: "Use the file store.", questionId: 500 } });
    await appendQuestionLog(paths, { issue: 7, at: "2026-10-12T11:00:00Z", event: "answered", asking_stage: "plan", question_comment_id: 500, reply_comment_id: 501, answer: "Use the file store.", question: Q });
    const t = await s.tick();
    await settle();
    expect(t.claimed).toEqual([7]);
    expect(seen.map((c) => c.started_at)).toEqual(["2026-10-01T00:00:00Z"]);
    expect(logLines(paths).filter((e) => e.event === "answered")).toHaveLength(1);
    expect(labelCalls(gh, 7)).toEqual(["+in-progress", "-needs-decision"]);
    expect(await listPaused(paths)).toEqual([]);
    const [c] = await listClaims(paths);
    expect(c.pendingEvent).toBeUndefined();
    expect(c.state).toMatchObject({ stage: "spec", answer: "Question #500: Use the file store." });
  }, 30_000);

  it("logs answered on a resume a crash left before its log line (AC-15)", async () => {
    const { s, paths } = await setup(routes([waiting()]), 1, firstStep);
    await writePaused(paths, record({ phase: "resuming", answer: "Use the file store.", reply_comment_id: 501 }));
    await s.tick();
    await settle();
    expect(logLines(paths).filter((e) => e.event === "answered")).toEqual([expect.objectContaining({ question_comment_id: 500, reply_comment_id: 501, question: Q })]);
    expect((await listClaims(paths))[0].state.stage).toBe("spec");
  }, 30_000);

  it("leaves a resume the record holds when no slot is free, and retries it next tick", async () => {
    const rs = routes([waiting()], {}, { 7: [comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });
    let hold: () => void = () => {};
    const drive: Drive = async (_d, claim) => { await new Promise<void>((r) => { hold = r; }); return claim; };
    const { s, paths, pair, deps } = await setup(rs, 1, drive);
    await writeClaim(paths, { issue: 3, slot: 0, state: { ...initialChainState(3), stage: "verify" }, worktree: join(pair.worktrees, "issue-3"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
    // Issue 3's chain runs first; an answer resumes ahead of a claim that has not started (spec 016 AC-1).
    await s.tick();
    await writePaused(paths, record());
    await s.tick();
    expect(await listPaused(paths)).toEqual([expect.objectContaining({ phase: "resuming",answer:'Use the file store.' })]);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([3]);
    await (await import("node:fs/promises")).unlink(join(paths.claims, "3.json"));
    hold();
    await settle();
    expect((await s.tick()).claimed).toEqual([7]);
    hold();
  }, 30_000);

  it("does not expire or delete a claim carrying the answered event after the record is gone (review focus 8)", async () => {
    const { s, paths, pair, started } = await setup(routes([], { 7: ["validated", "class:product"] }), 1, firstStep);
    const wt = join(pair.worktrees, "issue-7");
    git(pair.repo, "worktree", "add", "-q", "-B", "issue-7", wt, "origin/main");
    await writeClaim(paths, { issue: 7, slot: 0, state: pausedState(), worktree: wt, started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null, pendingEvent: { type: "answered", answer: "Use the file store.", questionId: 500 } });
    const t = await s.tick();
    await settle();
    expect(t.released).toEqual([]);
    const [c] = await listClaims(paths);
    expect(c.pendingEvent).toBeUndefined();
    expect(c.state).toMatchObject({ stage: "spec", answer: "Question #500: Use the file store." });
    expect(started).toEqual([]);
  }, 30_000);

  it("does not expire or delete a claim carrying pending actions, by liveness or by MAX_CHAIN_FAILURES", async () => {
    let calls = 0;
    const { s, paths, pair, notifications } = await setup(routes([], { 7: ["validated", "class:product"] }), 1, async () => { calls++; throw new Error("boom"); });
    await writeClaim(paths, {
      issue: 7, slot: 0, state: { ...initialChainState(7), stage: "abandoned" }, worktree: join(pair.worktrees, "issue-7"), started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null,
      pendingActions: [{ type: "comment", text: "abandoned" }],
    });
    for (let i = 0; i < MAX_CHAIN_FAILURES + 1; i++) {
      const t = await s.tick();
      expect(t.released).toEqual([]);
      await settle();
    }
    expect(calls).toBe(MAX_CHAIN_FAILURES + 1);
    expect((await listClaims(paths)).map((c) => c.issue)).toEqual([7]);
    // C7: reported once, when the count reaches MAX_CHAIN_FAILURES, not on every later failure; CM3: with a finding.
    expect(notifications.filter((n) => n.gate === "chain_error")).toEqual([
      expect.objectContaining({ issue: 7, text: expect.stringContaining("an abandonment") }),
    ]);
    const findings = readFileSync(paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toEqual([expect.objectContaining({ issue: 7, finding: expect.objectContaining({ what: "pending work keeps failing", evidence: "boom", noticed_how: "scheduler chain error" }) })]);
  }, 30_000);

  it("never expires a claim in stage paused or abandoned, whose liveness_expired is invalid", async () => {
    const { s, paths, pair, gh } = await setup(routes([]), 2, async (_d, c) => c);
    for (const [n, stage] of [[5, "paused"], [6, "abandoned"]] as const) {
      await writeClaim(paths, { issue: n, slot: 0, state: { ...initialChainState(n), stage }, worktree: join(pair.worktrees, `issue-${n}`), started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null });
    }
    const t = await s.tick();
    expect(t.errors).toEqual([]);
    expect(t.released).toEqual([]);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"))).toEqual([]);
  }, 30_000);

  it("sends one reminder after 24 hours: the reminded mark first, one comment, one notification (AC-16, C15)", async () => {
    const { s, paths, gh, notifications } = await setup(routes([waiting()]));
    await writePaused(paths, record({ asked_at: "2026-10-11T11:00:00Z" }));
    await s.tick();
    const posted = gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments");
    expect(posted.map((c) => (c.body as { body: string }).body)).toEqual(["@adam26davidson Still waiting on your answer: Which store?"]);
    expect(notifications).toEqual([{ issue: 7, gate: "question-reminder", label: "needs-decision", text: "@adam26davidson Still waiting on your answer: Which store?" }]);
    expect((await listPaused(paths))[0].reminded).toBe(true);
    expect(logLines(paths).map((e) => e.event)).toEqual(["reminded"]);
    await s.tick();
    expect(gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments")).toHaveLength(1);
    expect(notifications).toHaveLength(1);
  }, 30_000);

  it("drops the record of a paused issue that is no longer open, claiming nothing (AC-15, review focus 5)", async () => {
    const { s, paths } = await setup(routes([]));
    await writePaused(paths, record({ phase: "resuming", answer: "x", reply_comment_id: 501 }));
    const t = await s.tick();
    expect(t.claimed).toEqual([]);
    expect(await listPaused(paths)).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(readFileSync(paths.serviceLog, "utf8")).toContain('"kind":"paused-dropped"');
    expect(logLines(paths)).toEqual([]);
  }, 30_000);
});

const dns =() => Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" });
const serviceRecords = (paths: { serviceLog: string }) => readFileSync(paths.serviceLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("Scheduler.tick: transient failures (spec 015)", () => {
  async function outageSetup(drive: Drive, listed: () => unknown[] = () => []) {
    const rs = routes([]).map((r) =>
      String(r.path) === String(/^\/repos\/o\/r\/issues$/) ? { ...r, reply: (_m: RegExpExecArray, _b: unknown, url: URL) => ({ body: listed(), headers: pageLink(url, 1, 1) }) }
        : String(r.path) === String(/^\/graphql$/) ? { ...r, reply: () => ({ body: { data: { repository: { issues: { totalCount: listed().length } } } } }) } : r);
    const t = await setup(rs, 1, drive);
    const events: { event: string; payload: unknown }[] = [];
    t.deps.emitEvent = async (event, payload) => { events.push({ event, payload }); };
    await writeClaim(t.paths, { issue: 7, slot: 0, state: { ...initialChainState(7), stage: "verify" }, worktree: join(t.pair.worktrees, "issue-7"), started_at: t.deps.now().toISOString(), last_activity_at: t.deps.now().toISOString(), run_id: null });
    let now = t.deps.now();
    const advance = (s: number) => { now = new Date(now.getTime() + s * 1000); t.setNow(now); };
    return { ...t, events, advance, claim: async () => (await listClaims(t.paths))[0] };
  }

  it("postpones a chain that fails on EAI_AGAIN with backoff, spends no chain-failure count and logs the outage once (AC-5, AC-6; issue #29)", async () => {
    let calls = 0;
    let failing = true;
    const t = await outageSetup(async (_d, c) => { calls++; if (failing) throw dns(); return c; });
    const errors: unknown[] = [];
    t.deps.log = (r) => { if (r.kind === "error") errors.push(r); };
    const waits: number[] = [];
    for (let i = 1; i <= MAX_CHAIN_FAILURES + 2; i++) {
      const tick = await t.s.tick();
      await settle();
      expect(tick.released).toEqual([]);
      expect(calls).toBe(i);
      const c = await t.claim();
      expect(c.state.chainFailures).toBeNull();
      expect(c.outage).toMatchObject({ count: i, since: "2026-10-12T12:00:00.000Z", last: "getaddrinfo EAI_AGAIN api.github.com", alarmed: false });
      expect(c.last_activity_at).toBe(t.deps.now().toISOString());
      waits.push((Date.parse(c.outage!.retry_at) - t.deps.now().getTime()) / 1000);
      // Not started again before retry_at.
      t.advance(waits.at(-1)! - 1);
      await t.s.tick();
      await settle();
      expect(calls).toBe(i);
      t.advance(1);
    }
    expect(waits).toEqual([60, 120, 240, 480, 960]);
    expect(errors).toEqual([]);
    // The ledger was never written: no counter moved.
    expect(existsSync(join(t.paths.escalations, "7.json"))).toBe(false);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage")).toEqual([
      expect.objectContaining({ issue: 7, cause: "EAI_AGAIN", error: "getaddrinfo EAI_AGAIN api.github.com" }),
    ]);
    expect(serviceRecords(t.paths).find((r) => r.kind === "chain-error")).toBeUndefined();
    failing = false;
    await t.s.tick();
    await settle();
    expect((await t.claim()).outage).toBeUndefined();
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage-over")).toEqual([
      expect.objectContaining({ issue: 7, since: "2026-10-12T12:00:00.000Z", failures: MAX_CHAIN_FAILURES + 2 }),
    ]);
  }, 60_000);

  it("counts a genuine error after an outage as today, and transient failures between genuine ones neither count nor reset (AC-7)", async () => {
    const script: (Error | null)[] = [dns(), new Error("boom"), dns(), new Error("boom"), dns(), new Error("boom")];
    const t = await outageSetup(async (_d, c) => { const e = script.shift(); if (e) throw e; return c; });
    const counts: (number | null)[] = [];
    for (let i = 0; i < 6; i++) {
      await t.s.tick();
      await settle();
      const c = await t.claim();
      if (!c) break;
      counts.push(c.state.chainFailures?.count ?? null);
      if (i === 1) expect(c.outage).toBeUndefined();
      t.advance(600);
    }
    expect(counts).toEqual([null, 1, 1, 2, 2, 3]);
    const t7 = await t.s.tick();
    expect(t7.released).toEqual([7]);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "chain-error")).toHaveLength(1);
  }, 60_000);

  it("raises one notification, one finding and one infra_alarm event after two hours of outage (AC-8)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    for (let i = 0; i < 12; i++) {
      await t.s.tick();
      await settle();
      t.advance(1800);
    }
    const c = await t.claim();
    expect(c.outage?.alarmed).toBe(true);
    expect(t.notifications.filter((n) => n.gate === "infra")).toHaveLength(1);
    expect(t.notifications.find((n) => n.gate === "infra")?.text).toContain("EAI_AGAIN");
    const findings = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings).toHaveLength(1);
    expect(findings[0].finding).toMatchObject({ what: "network outage blocks the chain", noticed_how: "scheduler transient error" });
    expect(t.events.filter((e) => e.event === "infra_alarm")).toEqual([{ event: "infra_alarm", payload: expect.objectContaining({ issue: 7, since: "2026-10-12T12:00:00.000Z", cause: "EAI_AGAIN" }) }]);
    expect(t.notifications.filter((n) => n.gate === "chain_error")).toEqual([]);
  }, 60_000);

  it("counts the failures of an outage past its 24-hour ceiling as genuine, with one finding, and then releases with chain_error (AC-13)", async () => {
    let open = false;
    const t = await outageSetup(async () => { throw dns(); }, () => (open ? [issue(7)] : []));
    const c0 = await t.claim();
    const since = new Date(t.deps.now().getTime() - 25 * 3600_000).toISOString();
    await writeClaim(t.paths, { ...c0, outage: { since, count: 40, last: "getaddrinfo EAI_AGAIN api.github.com", retry_at: since, alarmed: true } });
    const LAST = "outage past ceiling: getaddrinfo EAI_AGAIN api.github.com";
    // A laptop asleep for a day is not a day of failures: the first failures past the ceiling, until there are three
    // spanning at least 30 minutes, still count nothing.
    for (let i = 1; i <= 2; i++) {
      await t.s.tick();
      await settle();
      const c = await t.claim();
      expect(c.state.chainFailures).toBeNull();
      expect(c.outage).toMatchObject({ since, count: 40 + i, past_ceiling: { failures: i } });
      expect(c.outage?.ceiling).toBeFalsy();
      t.advance(1800);
    }
    for (let i = 1; i <= MAX_CHAIN_FAILURES; i++) {
      expect((await t.s.tick()).released).toEqual([]);
      await settle();
      const c = await t.claim();
      expect(c.state.chainFailures).toEqual({ count: i, last: LAST });
      expect(c.outage).toMatchObject({ since, count: 42 + i, ceiling: true });
      t.advance(1800);
    }
    expect(JSON.parse(readFileSync(join(t.paths.escalations, "7.json"), "utf8")).chainFailures.count).toBe(MAX_CHAIN_FAILURES);
    expect(serviceRecords(t.paths).filter((r) => r.kind === "transient-outage-ceiling")).toHaveLength(1);
    const findings = readFileSync(t.paths.findingsQueue, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(findings.filter((f) => f.finding.what === "network outage outlasted the retry ceiling")).toHaveLength(1);
    expect((await t.s.tick()).released).toEqual([7]);
    await settle();
    expect(serviceRecords(t.paths).filter((r) => r.kind === "chain-error")).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(join(t.paths.escalations, "7.json"), "utf8"));
    expect(ledger.chainErrors).toBe(1);
    expect(ledger.history.at(-1)).toBe(`chain error in verify (counted): ${LAST}`);
    // Claimed again: the release past the ceiling is not forgiven, so the next one abandons the issue.
    open = true;
    const reclaim = await t.s.tick();
    await settle();
    expect(reclaim).toMatchObject({ claimed: [7] });
    const again = (await listClaims(t.paths)).find((c) => c.issue === 7)!;
    expect(again.state.chainErrors).toBe(1);
    expect(serviceRecords(t.paths).find((r) => r.kind === "chain-errors-forgiven")).toBeUndefined();
  }, 60_000);

  it("reports a claim carrying pending work once when its outage passes the ceiling (AC-13)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    const c0 = await t.claim();
    const since = new Date(t.deps.now().getTime() - 25 * 3600_000).toISOString();
    await writeClaim(t.paths, { ...c0, pendingEvent: { type: "chain_error", error: "boom" }, outage: { since, count: 40, last: "getaddrinfo EAI_AGAIN api.github.com", retry_at: since, alarmed: true } });
    for (let i = 0; i < 6; i++) {
      await t.s.tick();
      await settle();
      t.advance(1800);
    }
    expect(t.notifications.filter((n) => n.gate === "chain_error")).toHaveLength(1);
    expect(t.notifications.find((n) => n.gate === "chain_error")?.text).toContain("past its 24-hour ceiling");
    expect(serviceRecords(t.paths).filter((r) => r.kind === "pending-work-failing")).toHaveLength(1);
    expect(await t.claim()).toBeTruthy();
  }, 60_000);

  it("does not let liveness expire a claim that is retrying through an outage (AC-9)", async () => {
    const t = await outageSetup(async () => { throw dns(); });
    for (let i = 0; i < 4; i++) {
      const tick = await t.s.tick();
      await settle();
      expect(tick.released).toEqual([]);
      t.advance(5400);
    }
    expect(await t.claim()).toBeTruthy();
    expect(serviceRecords(t.paths).find((r) => r.kind === "stale-claim")).toBeUndefined();
  }, 60_000);

  it("forgives a chain-error release recorded for a transient cause when the issue is claimed again (AC-11; issue #13)", async () => {
    const { s, paths } = await setup(routes([issue(1)]));
    await writeLedger(paths, 1, { ...ledgerOf(initialChainState(1)), chainErrors: 1, history: ["chain error in verify: getaddrinfo EAI_AGAIN api.github.com"] });
    const t = await s.tick();
    expect(t.claimed).toEqual([1]);
    const claim = (await listClaims(paths)).find((c) => c.issue === 1)!;
    expect(claim.state.chainErrors).toBe(0);
    const ledger = JSON.parse(readFileSync(join(paths.escalations, "1.json"), "utf8"));
    expect(ledger.chainErrors).toBe(0);
    expect(ledger.history).toEqual(["chain error in verify (transient, not counted): getaddrinfo EAI_AGAIN api.github.com"]);
    expect(serviceRecords(paths)).toContainEqual(expect.objectContaining({ kind: "chain-errors-forgiven", issue: 1, forgiven: 1 }));
  }, 30_000);
});

type Harness =Awaited<ReturnType<typeof setup>>;
const FUTURE = "2026-10-12T13:00:00Z";
const PAST = "2026-10-12T11:00:00Z";
const writeWaiting = (h: Harness, n: number, postponedUntil: string) =>
  writeClaim(h.paths, {
    issue: n, slot: 0, state: { ...initialChainState(n), stage: "waiting", resumeStage: "review", postponedUntil },
    worktree: join(h.pair.worktrees, `issue-${n}`), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null,
  });
const rmClaim = async (h: Harness, n: number) => (await import("node:fs/promises")).unlink(join(h.paths.claims, `${n}.json`));
const holdingDrive = () => {
  const st = { release: () => {}, started: [] as number[] };
  const drive: Drive = async (_d, claim) => { st.started.push(claim.issue); await new Promise<void>((r) => { st.release = r; }); return claim; };
  return { st, drive };
};

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
    h.setNow(new Date("2026-10-12T14:00:00Z"));
    const t2 = await h.s.tick();
    await settle();
    expect(h.started).toEqual([7]);
    expect(t2.claimed).toEqual([]);
  }, 30_000);

  it("counts the waiting claim, not the running chain (AC-2)", async () => {
    const { st, drive } = holdingDrive();
    const shortlist: unknown[] = [];
    const h = await setup(routes(shortlist), 2, drive);
    await writeClaim(h.paths, { issue: 3, slot: 0, state: { ...initialChainState(3), stage: "verify" }, worktree: join(h.pair.worktrees, "issue-3"), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null });
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
    await writeClaim(h2.paths, { issue: 7, slot: 0, state: pausedState(), worktree: join(h2.pair.worktrees, "issue-7"), started_at: h2.deps.now().toISOString(), last_activity_at: h2.deps.now().toISOString(), run_id: null });
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

/** A run log shared by a chain stub and a standing-agent stub, each held until the test releases it. */
const grantLog = () => {
  const grants: string[] = [];
  const held = new Map<string, () => void>();
  const hold = (key: string) => new Promise<void>((r) => { grants.push(key); held.set(key, r); });
  const release = async (key: string) => { held.get(key)?.(); held.delete(key); await settle(); };
  const drive: Drive = async (_d, claim) => { await hold(`chain:${claim.issue}`); return claim; };
  return { grants, hold, release, drive };
};
const readyClaim = (h: Harness, n: number) =>
  writeClaim(h.paths, { issue: n, slot: 0, state: { ...initialChainState(n), stage: "verify" }, worktree: join(h.pair.worktrees, `issue-${n}`), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null });
/** Registers the action-audit agent; `due` puts its next_run at now. The stub never updates its state, so it stays due after each run. */
async function withStanding(h: Harness, log: ReturnType<typeof grantLog>, due = true) {
  const { loadRegistry } = await import("../src/standing/registry.ts");
  const { EVENT_NAMES } = await import("../src/standing/events.ts");
  const { registryActionsCheck } = await import("../src/actions/index.ts");
  const { loadParameterDefinitions } = await import("../src/parameters/definitions.ts");
  const { ParameterStore } = await import("../src/parameters/store.ts");
  const { initializeAgents, readAgentState, writeAgentState } = await import("../src/standing/state.ts");
  const all = loadRegistry(join(agentsDir, "standing"), EVENT_NAMES, registryActionsCheck(join(agentsDir, "actions.yaml")));
  h.deps.registry = { "action-audit": all["action-audit"] };
  h.deps.parameters = new ParameterStore(h.paths, loadParameterDefinitions(join(agentsDir, "parameters.yaml"), h.deps.cfg, h.deps.registry));
  await initializeAgents(h.paths, h.deps.registry, h.deps.parameters, h.deps.now());
  const state = (await readAgentState(h.paths, "action-audit"))!;
  if (due) await writeAgentState(h.paths, "action-audit", { ...state, next_run: h.deps.now().toISOString() });
  h.deps.runStanding = async () => { await log.hold("standing"); };
}
const answeredRoutes = (shortlist: unknown[] = []) =>
  routes([waiting(), ...shortlist], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });

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

describe("Scheduler.tick: fair slot scheduling, failure and crash windows (spec 016)", () => {
  it("claims no second issue in the same grant when the first claim's label fails after its claim file (AC-7, AC-8)", async () => {
    const log = grantLog();
    const failLabel: Route = { method: "POST", path: /^\/repos\/o\/r\/issues\/1\/labels$/, reply: () => ({ status: 422, body: { message: "Validation Failed" } }) };
    const h = await setup([failLabel, ...routes([issue(1), issue(2)])], 1, log.drive);
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
      issue: 9, slot: 0, state: pausedState(), worktree: join(h.pair.worktrees, "issue-9"), started_at: h.deps.now().toISOString(), last_activity_at: h.deps.now().toISOString(), run_id: null,
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
