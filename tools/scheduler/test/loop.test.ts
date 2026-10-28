import { openIndex } from "../src/events/index.ts";
import {TelegramClient} from '../src/telegram/client.ts';
import {telegramChannel} from '../src/telegram/channel.ts';
import {fakeTelegram} from './helpers/fake-telegram.ts';
import {emptyTelegram} from '../src/state/paused.ts';
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { MAX_CHAIN_FAILURES, Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
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
    cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
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
  const {s,deps}=await setup(routes([]));let ticks=0;deps.sleep=()=>new Promise<void>(()=>{});s.tick=async()=>{ticks++;if(ticks===2)s.stop('test');return {eligible:0,claimed:[],released:[],errors:[],restartPending:false};};const running=s.run();await new Promise(r=>setTimeout(r,10));expect(ticks).toBe(1);s.wake();await running;expect(ticks).toBe(2);
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
    expect((await s.tick()).claimed).toEqual([]);expect(s.active).toBe(1);await s.tick();expect(calls).toBe(1);
    finish();await new Promise(r=>setTimeout(r,20));expect(s.active).toBe(0);
  },30000);
  it("claims only as many issues as there are slots, in rank order, and labels the rest of the decisions (AC-1, AC-2, AC-5)", async () => {
    const { s, gh, started, paths } = await setup(routes([issue(2), issue(1), issue(3, ["validated"])]));
    const t = await s.tick();
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
    expect(ledger.history.at(-1)).toBe("chain error in verify: boom");
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
