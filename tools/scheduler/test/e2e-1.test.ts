import { TelegramClient } from '../src/telegram/client.ts';
import { telegramChannel } from '../src/telegram/channel.ts';
import { TelegramPoller } from '../src/telegram/poller.ts';
import { fakeTelegram } from './helpers/fake-telegram.ts';
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "octokit";
import { describe, expect, it } from "vitest";
import { agentsDir, defaultConfigPath, loadConfig } from "../src/config.ts";
import { GitHubClient } from "../src/github/client.ts";
import { Scheduler, type SchedulerDeps } from "../src/service/loop.ts";
import { ServiceLog } from "../src/service/log.ts";
import { SleepInhibitor } from "../src/service/inhibit.ts";
import { loadStageDefinitions } from "../src/stages/definition.ts";
import type { StageRun } from "../src/adapters/types.ts";
import { listClaims } from "../src/state/claims.ts";
import { writePaused, listPaused } from "../src/state/paused.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import { chainWorld, scripted, worldPaths, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git, repoPair, withTopDesign } from "./helpers/repo-pair.ts";
import { spec, BOT, specOf, repoFiles, PLAN, APPROVE, ask, ESCALATE, SEND, agents, expectSettled, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-1");

describe('Telegram recorded chains',()=>{
 const wait=async(f:()=>boolean)=>{for(let i=0;i<600&&!f();i++)await new Promise(r=>setTimeout(r,20));expect(f()).toBe(true);};
 async function connect(w:ChainWorld){const server=await fakeTelegram();w.deps.telegram=telegramChannel(new TelegramClient('SECRET',42,server.url));return server;}
 it('recovers a crash after the GitHub answer comment, confirms once and acknowledges a slept reply once',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('capability','Enable it?')},PLAN],implement:[a.implement(9)],review:[APPROVE],'question-check':[SEND]}});const server=await connect(w);
  try{await w.tick();const replyDate=Math.floor(Date.now()/1000)+1;w.deps.now=()=>new Date((replyDate+300)*1000);const u={update_id:15,message:{message_id:1000,date:replyDate,chat:{id:42},text:'done'}};const post=w.deps.gh.comment.bind(w.deps.gh);let crash=true;w.deps.gh.comment=async(issue,body)=>{const r=await post(issue,body);if(crash&&body.startsWith('Answer from')){crash=false;throw Error('simulated crash after remote delivery');}return r;};await expect(w.scheduler.handleTelegramUpdate(u)).rejects.toThrow('simulated crash');expect((await listPaused(w.paths))[0].phase).toBe('paused');
   const restarted=new Scheduler(w.deps);const poll=new TelegramPoller(w.deps.telegram!.client,w.paths.telegramOffset,50,x=>restarted.handleTelegramUpdate(x),()=>{},undefined,x=>restarted.confirmTelegramUpdate(x));poll.start();try{server.push(u);await wait(()=>server.sent.some(m=>String(m.text).startsWith('Picked up your reply from')));await restarted.tick();await wait(()=>restarted.active===0);expect(w.comments.filter(c=>c.body.startsWith('Answer from'))).toHaveLength(1);await restarted.handleTelegramUpdate(u);await restarted.confirmTelegramUpdate(u);expect(server.sent.filter(m=>String(m.text).startsWith('Picked up'))).toHaveLength(1);expect(JSON.parse(readFileSync(w.paths.telegramOffset,'utf8')).next_update_id).toBe(16);expect(w.mergeRequests).toEqual([9]);await expectSettled(w);}finally{await poll.stop();}
  }finally{await server.close();}
 },120000);
 it('technical review answer resumes review before the ADR fix and merge',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[PLAN],implement:[a.implement(9)],review:[ESCALATE(ask('technical','Which cache?')),{conversation:'settled',decision:'Use option one for bounded memory'},APPROVE],fix:[a.adr()],'question-check':[SEND]}});const server=await connect(w);
  try{await w.tick();const [r]=await listPaused(w.paths);const u={update_id:1,message:{message_id:1000,date:Math.floor(Date.now()/1000)+1,chat:{id:42},text:'Use option one'}};await w.scheduler.handleTelegramUpdate(u);await w.scheduler.confirmTelegramUpdate(u);await w.tick();const turn=w.adapter.runs.find(r=>r.conversation);expect(turn?.stage).toBe('review');expect(turn?.resume?.sessionId).toBe(r.session!.session_id);expect(w.adapter.runs.find(r=>r.stage==='fix')?.input.decision).toBe('Use option one for bounded memory');expect(w.onMain('docs/decisions/0001-x.md')).toContain('maintainer answer');expect(w.mergeRequests).toEqual([9]);await expectSettled(w);}finally{await server.close();}
 },120000);
 it('a missing resumed session falls back fresh in the same attempt and merges',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('capability','Enable it?')},PLAN],implement:[a.implement(9)],review:[APPROVE],'question-check':[SEND]}});const server=await connect(w);const build=w.adapter.buildCommand.bind(w.adapter);const empty=join(w.pair.root,'empty.jsonl');writeFileSync(empty,'');let failedResume=false;w.adapter.buildCommand=run=>{if(run.resume&&!failedResume){failedResume=true;return {argv:[process.execPath,join(import.meta.dirname,'fixtures','stage-script.ts'),empty,run.resultPath,'1','0'],env:{}};}return build(run);};
  try{await w.tick();const u={update_id:1,message:{message_id:1000,date:Math.floor(Date.now()/1000)+1,chat:{id:42},text:'done'}};await w.scheduler.handleTelegramUpdate(u);await w.scheduler.confirmTelegramUpdate(u);await w.tick();expect(failedResume).toBe(true);const records=readdirSync(w.paths.usage).map(f=>JSON.parse(readFileSync(join(w.paths.usage,f),'utf8')));expect(records.find(r=>r.resume_fallback)?.attempt).toBe(1);expect(w.mergeRequests).toEqual([9]);await expectSettled(w);}finally{await server.close();}
 },120000);
 it('free text with two questions waits for a choice, then resumes and merges the selected issue',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('capability','Enable it?')},PLAN],implement:[a.implement(9)],review:[APPROVE],'question-check':[SEND]}});const server=await connect(w);
  try{await w.tick();const [r]=await listPaused(w.paths);await writePaused(w.paths,{...r,issue:8,nonce:'other',issue_title:'Other issue'});await w.scheduler.handleTelegramUpdate({update_id:1,message:{message_id:1000,date:Math.floor(Date.now()/1000)+1,chat:{id:42},text:'done'}});expect(w.adapter.ran).toEqual(['plan','question-check']);const list=server.sent.at(-1)!;expect(list.text).toContain('#7 Thing');expect(list.text).toContain('#8 Other issue');const v={update_id:2,callback_query:{id:'pick',data:'pick:7',message:{message_id:Number(list.message_id),date:1,chat:{id:42}}}};await w.scheduler.handleTelegramUpdate(v);await w.scheduler.confirmTelegramUpdate(v);await w.tick();expect(w.mergeRequests).toEqual([9]);await expectSettled(w);}finally{await server.close();}
 },120000);
 it('a reminder stays on Telegram and a later issue reply wins over a button',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('capability','Enable it?')},PLAN],implement:[a.implement(9)],review:[APPROVE],'question-check':[SEND]}});const server=await connect(w);
  try{await w.tick();const [r]=await listPaused(w.paths);await writePaused(w.paths,{...r,asked_at:new Date(Date.now()-25*3600000).toISOString()});const comments=w.comments.length;await w.tick();expect(w.comments).toHaveLength(comments);expect(server.sent.at(-1)?.text).toContain('Still waiting');w.reply('done');await w.tick();await w.scheduler.handleTelegramUpdate({update_id:1,callback_query:{id:'late',data:`q:${r.nonce}:1`,message:{message_id:r.telegram!.message_id!,date:1,chat:{id:42}}}});expect(server.sent.at(-1)?.text).toContain('already answered on issue');expect(w.mergeRequests).toEqual([9]);await expectSettled(w);}finally{await server.close();}
 },120000);
 it('button reply resumes the asking session, acknowledges before work and merges',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('capability','Can you enable it?')},PLAN],implement:[a.implement(9)],review:[APPROVE],'question-check':[SEND]}});
  const server=await connect(w);try{
   await w.tick();const [r]=await listPaused(w.paths);expect(r.session?.session_id).toBe(w.adapter.runs[0].sessionId);expect(server.sent).toHaveLength(1);expect(w.questions()[0].body).not.toContain('@adam');
   const poll=new TelegramPoller(w.deps.telegram!.client,w.paths.telegramOffset,50,u=>w.scheduler.handleTelegramUpdate(u),()=>{},undefined,u=>w.scheduler.confirmTelegramUpdate(u));poll.start();
   try{server.push({update_id:1,callback_query:{id:'cb',data:`q:${r.nonce}:1`,message:{message_id:r.telegram!.message_id!,date:Date.now()/1000,chat:{id:42}}}});await wait(()=>server.sent.some(m=>String(m.text).includes('Got it')));await w.tick();expect(w.adapter.runs[2].resume?.sessionId).toBe(r.session!.session_id);expect(w.mergeRequests).toEqual([9]);expect(server.answeredCallbacks).toHaveLength(1);
    expect(JSON.stringify(w.logs)).not.toContain('SECRET');
    for(const dir of readdirSync(w.paths.runs)){for(const file of ['command.txt','input.json','prompt.md'])expect(readFileSync(join(w.paths.runs,dir,file),'utf8')).not.toContain('SECRET');}
    await expectSettled(w);}finally{await poll.stop();}
  }finally{await server.close();}
 },120000);
 it('plan pushback stays in its session through a follow-up, then records the settled decision',async()=>{
  let w!:ChainWorld;const a=agents(()=>w);const pushback='why not the second one?';
  const follow={...ask('product','Second has a larger footprint. Still choose it?'),follow_up:true,reply_quote:pushback};
  w=await chainWorld({files:repoFiles(),results:{plan:[{escalation:ask('product','Which layout?')},{escalation:follow},{conversation:'settled',decision:'Use second for simpler operation'},PLAN],spec:[(run:StageRun)=>{
   const marks=w.questions().map(q=>`(maintainer answer, question #${q.id})`).join(', ');return a.spec(12,{'specs/010-thing/spec.md':specOf().replace('## 6. Open decisions',`Use second ${marks}.\n\n## 6. Open decisions`)})(run);
  }],implement:[a.implement(9)],review:[APPROVE,APPROVE],'question-check':[SEND]}});
  const server=await connect(w);try{
   await w.tick();const [first]=await listPaused(w.paths);
   const u={update_id:10,message:{message_id:1000,date:Math.floor(Date.now()/1000)+1,chat:{id:42},text:pushback}};
   await w.scheduler.handleTelegramUpdate(u);await w.scheduler.confirmTelegramUpdate(u);await w.tick();
   const [second]=await listPaused(w.paths);expect(second.question.follow_up).toBe(true);expect(w.adapter.runs[2].conversation).toBe(true);expect(w.adapter.runs[2].resume?.sessionId).toBe(first.session!.session_id);expect(server.sent.at(-1)?.reply_to_message_id).toBe(1000);
   const v={update_id:11,message:{message_id:1001,date:Math.floor(Date.now()/1000)+2,chat:{id:42},text:'Use second'}};
   await w.scheduler.handleTelegramUpdate(v);await w.scheduler.confirmTelegramUpdate(v);await w.tick();
   const record=w.adapter.runs.find(r=>r.stage==='spec');expect(record?.input.decision).toBe('Use second for simpler operation');expect(record?.resume).toBeUndefined();expect(w.mergeRequests).toEqual([12,9]);expect(server.sent.some(m=>String(m.text).startsWith('Settled:'))).toBe(true);await expectSettled(w);
  }finally{await server.close();}
 },120000);
});
describe("end to end: one issue through the whole chain with the fake adapter and a mocked GitHub", () => {
  it("claims, plans, implements, verifies, reviews, merges, and leaves the records (AC-1, AC-3, AC-24, AC-29 shape)", async () => {
    const pair = repoPair(withTopDesign({ "a.txt": "a\n", "specs/010-thing/spec.md": spec }, "specs/010-thing/spec.md"));
    // PR binding compares head_sha with the issue worktree HEAD, which the loop creates from origin/main
    const SHA = git(pair.repo, "rev-parse", "origin/main").trim();
    const paths = statePaths(join(pair.root, "state"));
    await ensureStateDirs(paths);
    worldPaths.push(paths);
    const labels = new Set(["validated", "class:product"]);
    const comments: string[] = [];
    const labelLog: string[] = [];
    const issue = () => ({ number: 7, title: "Thing", body: "Spec: specs/010-thing/spec.md", user: BOT, labels: [...labels].map((name) => ({ name })), created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" });
    const routes: Route[] = [
      { method: "GET", path: /^\/repos\/o\/r\/issues$/, reply: (_m, _b, url) => ({ body: [issue()], headers: pageLink(url, 1, 1) }) },
      { method: "POST", path: /^\/graphql$/, reply: () => ({ body: { data: { repository: { issues: { totalCount: 1 } } } } }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7\/timeline$/, reply: () => ({ body: [] }) },
      { method: "GET", path: /^\/repos\/o\/r\/issues\/7$/, reply: () => ({ body: issue() }) },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/labels$/, reply: (_m, b) => { for (const l of (b as { labels: string[] }).labels) { labels.add(l); labelLog.push(`+${l}`); } return { body: [] }; } },
      { method: "DELETE", path: /^\/repos\/o\/r\/issues\/7\/labels\/([^/]+)$/, reply: (m) => { labels.delete(m[1]); labelLog.push(`-${m[1]}`); return { body: {} }; } },
      { method: "POST", path: /^\/repos\/o\/r\/issues\/7\/comments$/, reply: (_m, b) => { comments.push((b as { body: string }).body); return { status: 201, body: {} }; } },
      { method: "GET", path: /^\/repos\/o\/r\/pulls$/, reply: () => ({ body: [] }) },
      { method: "GET", path: /^\/repos\/o\/r\/pulls\/9$/, reply: () => ({ body: { number: 9, base: { ref: "main" }, head: { ref: "issue-7", sha: SHA }, html_url: "u", mergeable: true, mergeable_state: "clean", merged: false, state: "open" } }) },
      { method: "GET", path: /^\/repos\/o\/r\/commits\/[0-9a-f]+\/check-runs$/, reply: () => ({ body: { total_count: 1, check_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } }) },
      { method: "PUT", path: /^\/repos\/o\/r\/pulls\/9\/merge$/, reply: () => ({ body: { merged: true, message: "ok" } }) },
    ];
    const gh = mockGitHub(routes);
    const notifications: Notification[] = [];
    const logs: Record<string, unknown>[] = [];
    const adapter = scripted({
      plan: [{ verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }], findings: [{ what: "w", where: "a.txt:1", evidence: "e", noticed_how: "n" }] }],
      implement: [{ pr_number: 9, head_sha: SHA, tasks_done: ["T1"] }],
      review: [{ verdict: "approve", findings_on_pr: [], declined_to_judge: [] }],
    });
    const cfg = { ...loadConfig(defaultConfigPath), repo: "o/r", required_checks: ["test"], state_dir: paths.root, slots: 1 };
    const deps: SchedulerDeps = {
      cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", throttle: { enabled: false }, request: { fetch: gh.fetch } }), "o/r"),
      notifier: { notify: async (n) => { notifications.push(n); } },
      stages: loadStageDefinitions(join(agentsDir, "stages")), agentsDir, repoDir: pair.repo, binDir: join(pair.root, "bin"),
      adapterFor: () => adapter, systemdScope: false, now: () => new Date(), log: (rec) => { logs.push(rec); },
      fetchOrigin: async () => { git(pair.repo, "fetch", "-q", "origin"); },
      unitActive: async () => false, stopUnit: async () => {},
      botLogin: "panelator-pipeline[bot]", serviceLog: new ServiceLog(paths.serviceLog), inhibitor: new SleepInhibitor({ enabled: false }),
      fastForward: async () => ({ moved: false, changedPaths: [] }), sleep: async () => {}, monotonic: () => 0, requestRestart: () => {},
    };
    const s = new Scheduler(deps);
    const t = await s.tick();
    expect(t.claimed).toEqual([7]);
    // wait for the background chain to finish
    for (let i = 0; i < 200 && s.active > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(s.active).toBe(0);
    expect(logs.filter((r) => r.kind === "error")).toEqual([]);
    expect(gh.unmatched).toEqual([]);

    expect(adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(comments).toEqual([]);
    expect(notifications).toEqual([]);
    expect(await listClaims(paths)).toEqual([]);
    expect(existsSync(join(paths.worktrees, "issue-7"))).toBe(false);
    const usage = readdirSync(paths.usage).sort();
    expect(usage).toHaveLength(3);
    for (const f of usage) {
      const rec = JSON.parse(readFileSync(join(paths.usage, f), "utf8"));
      expect(rec).toMatchObject({ issue: 7, outcome: "ok", harness: "fake", cost_usd: 0.1 });
      expect(existsSync(join(paths.root, rec.events_path))).toBe(true);
    }
    expect(readFileSync(paths.findingsQueue, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(paths.root, "merges.jsonl"), "utf8")).toContain('"issue":7');
    const ticks = readFileSync(paths.serviceLog, "utf8").split("\n").filter((l) => l.includes('"kind":"tick"'));
    expect(ticks).toHaveLength(1);
  }, 120_000);
});
