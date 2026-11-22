import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { emptyTelegram } from '../src/state/paused.ts';
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CHAIN_FAILURES } from "../src/service/loop.ts";
import { listClaims, writeClaim } from "../src/state/claims.ts";
import { initialChainState } from "../src/chain/machine.ts";
import { questionMarker } from "../src/chain/question.ts";
import { listPaused, writePaused, type PausedRecord } from "../src/state/paused.ts";
import { appendQuestionLog } from "../src/state/questions.ts";
import type { Claim } from "../src/state/claims.ts";
import type { Question } from "../src/types.ts";
import { ALL, matches } from "./helpers/markers.ts";
import { git } from "./helpers/repo-pair.ts";
import { issue, routes, type Drive, setup, claimedPayloads, Q, ME, BOT_LOGIN, comment, pausedState, record, waiting, firstStep, waitFor, settle, logLines, labelCalls } from "./helpers/loop-harness.ts";

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
 it('a GitHub error while posting the answer is a handler failure, not a Telegram outage (spec 042 AC-4)',async()=>{
  let posts=0;const rs=routes([waiting()]).map(r=>r.method==='POST'&&String(r.path).includes('comments')?{...r,reply:(m:RegExpExecArray,b:unknown,u:URL)=>posts++===0?{status:422,body:{message:'mock github comment failure'}}:r.reply(m,b,u)}:r);
  const {s,deps,paths,gh}=await setup(rs,1,firstStep);const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('secret',42,server.url));
  const logs:Record<string,unknown>[]=[],waits:number[]=[];const {TelegramPoller}=await import('../src/telegram/poller.ts');
  const poll=new TelegramPoller(deps.telegram!.client,paths.telegramOffset,50,u=>s.handleTelegramUpdate(u),r=>logs.push(r),async ms=>{waits.push(ms);},u=>s.confirmTelegramUpdate(u));
  try{await writePaused(paths,tgRecord());server.push(message(1,'Use the file store.'));poll.start();
   await waitFor({'offset names update 2':()=>existsSync(paths.telegramOffset)&&JSON.parse(readFileSync(paths.telegramOffset,'utf8')).next_update_id===2,'two comment posts':()=>gh.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/comments')).length>=2,'one sent message':()=>server.sent.length>=1,'paused record resuming':async()=>(await listPaused(paths))[0]?.phase==='resuming'});
   expect(logs).toHaveLength(2);expect(logs[0]).toMatchObject({kind:'telegram',status:'connected'});expect(logs[1]).toMatchObject({kind:'telegram-handler-failed',update_id:1});expect(String(logs[1].error)).toContain('mock github comment failure');
   expect(logs.some(l=>l.kind==='telegram-outage'||l.kind==='telegram-recovered')).toBe(false);expect(waits).toEqual([2000]);
   expect(gh.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/comments'))).toHaveLength(2);expect(server.sent).toHaveLength(1);expect((await listPaused(paths))[0].phase).toBe('resuming');
  }finally{await poll.stop();await server.close();}
 },30000);
 it('the answer comment neutralises every marker but its own, and the resumed answer is the maintainer\'s exact text (spec 076 AC-2)',async()=>{
  const {s,deps,paths,gh}=await setup(routes([waiting()]),1,firstStep);const server=await fakeTelegram();deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));
  try{await writePaused(paths,tgRecord());const u=message(901,ALL);await s.handleTelegramUpdate(u);await s.confirmTelegramUpdate(u);
   const posted=gh.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/comments')).map(c=>(c.body as {body:string}).body);
   expect(posted).toHaveLength(1);expect(matches(posted[0]!)).toHaveLength(1);expect(posted[0]!.trimEnd().endsWith('<!-- panelator-telegram-answer:901 -->')).toBe(true);
   expect((await listPaused(paths))[0].answer).toBe(ALL);}finally{await server.close();}
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

  it("resumes a paused issue into a claim with no slot field (spec 034 AC-2)", async () => {
    const rs = routes([waiting()], {}, { 7: [comment(500, BOT_LOGIN, "2026-10-12T08:00:00Z", "q"), comment(501, ME, "2026-10-12T09:00:00Z", "Use the file store.")] });
    const { s, paths } = await setup(rs, 1, firstStep);
    await writePaused(paths, record());
    expect((await s.tick()).claimed).toEqual([7]);
    await settle();
    expect("slot" in JSON.parse(readFileSync(join(paths.claims, "7.json"), "utf8"))).toBe(false);
    expect(claimedPayloads(paths, 7)).toStrictEqual([{}]); // spec 095 AC-1
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
    await writeClaim(paths, { issue: 7, state: pausedState(), worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: "2026-10-01T00:00:00Z", run_id: null });
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
    await writeClaim(paths, { issue: 7, state: pausedState(), worktree: join(pair.worktrees, "issue-7"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
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
    await writeClaim(paths, { issue: 7, state: pausedState(), worktree: wt, started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null, pendingEvent: { type: "answered", answer: "Use the file store.", questionId: 500 } });
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
    await writeClaim(paths, { issue: 3, state: { ...initialChainState(3), stage: "verify" }, worktree: join(pair.worktrees, "issue-3"), started_at: deps.now().toISOString(), last_activity_at: deps.now().toISOString(), run_id: null });
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
    await writeClaim(paths, { issue: 7, state: pausedState(), worktree: wt, started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null, pendingEvent: { type: "answered", answer: "Use the file store.", questionId: 500 } });
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
      issue: 7, state: { ...initialChainState(7), stage: "abandoned" }, worktree: join(pair.worktrees, "issue-7"), started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null,
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
    expect(findings).toEqual([expect.objectContaining({ issue: 7, finding: expect.objectContaining({ what: "pending work keeps failing: boom", evidence: "boom", noticed_how: "scheduler chain error" }) })]);
  }, 30_000);

  it("never expires a claim in stage paused or abandoned, whose liveness_expired is invalid", async () => {
    const { s, paths, pair, gh } = await setup(routes([]), 2, async (_d, c) => c);
    for (const [n, stage] of [[5, "paused"], [6, "abandoned"]] as const) {
      await writeClaim(paths, { issue: n, state: { ...initialChainState(n), stage }, worktree: join(pair.worktrees, `issue-${n}`), started_at: "2026-10-01T00:00:00Z", last_activity_at: "2026-10-01T00:00:00Z", run_id: null });
    }
    const t = await s.tick();
    expect(t.errors).toEqual([]);
    expect(t.released).toEqual([]);
    expect(gh.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"))).toEqual([]);
  }, 30_000);

  it("the reminder comment neutralises a question carrying every family (spec 076 AC-2)", async () => {
    const { s, paths, gh } = await setup(routes([waiting()]));
    await writePaused(paths, record({ asked_at: "2026-10-11T11:00:00Z", question: { ...Q, question: ALL } }));
    await s.tick();
    const posted = gh.calls.filter((c) => c.method === "POST" && c.url === "/repos/o/r/issues/7/comments").map((c) => (c.body as { body: string }).body);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Still waiting on your answer");
    expect(matches(posted[0]!)).toEqual([]);
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
