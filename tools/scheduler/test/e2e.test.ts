import {TelegramClient} from '../src/telegram/client.ts';
import {telegramChannel} from '../src/telegram/channel.ts';
import {TelegramPoller} from '../src/telegram/poller.ts';
import {fakeTelegram} from './helpers/fake-telegram.ts';
import {execFileSync} from 'node:child_process';
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
import { CHARTER_REVERT_LINE } from "../src/chain/driver.ts";
import { ledgerOf } from "../src/chain/machine.ts";
import { listClaims } from "../src/state/claims.ts";
import { writePaused,listPaused, type PausedRecord } from "../src/state/paused.ts";
import type { Question } from "../src/types.ts";
import { ensureStateDirs, statePaths } from "../src/state/paths.ts";
import type { Notification } from "../src/notify/types.ts";
import { mockGitHub, pageLink, type Route } from "./helpers/mock-github.ts";
import {ActionLog} from '../src/actions/log.ts';
import {undoAction} from '../src/actions/undo.ts';
import {loadActionLevels,applyAction} from '../src/actions/index.ts';
import {appendFindings} from '../src/state/findings.ts';
import {observeRun} from '../src/quota/book.ts';
import {readAgentState,writeAgentState} from '../src/standing/state.ts';
import {emit} from '../src/standing/events.ts';
import {runStandingAgent} from '../src/standing/run.ts';
import {readJsonLines,type TriageEntry} from '../src/filer/input.ts';
import { chainWorld, standingWorld, scripted, RATE_LIMITED, type ChainWorld } from "./helpers/e2e-routes.ts";
import { git, repoPair, withDesign, withTopDesign } from "./helpers/repo-pair.ts";

const spec = readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-backend.md"), "utf8");
const BOT = { login: "panelator-pipeline[bot]", type: "Bot" };

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
      cfg, paths, gh: new GitHubClient(new Octokit({ auth: "x", request: { fetch: gh.fetch } }), "o/r"),
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

// ---------------------------------------------------------------------------------------------------------------
// Spec 006 AC-28: the recorded chains for every escalation outcome. The real Scheduler, driver and machine, the fake
// adapter, and a mocked GitHub whose repository is a real bare origin (helpers/e2e-routes.ts).

const PARENT = "docs/product-spec.md";
const CHARTER = "# Charter\n\nThe root of the design tree.\n";
const specOf = (extraPaths: string[] = []) =>
  spec.replace("Parent: docs/top.md", `Parent: ${PARENT}`).replace("- `schemas/thing.json`", ["- `schemas/thing.json`", ...extraPaths.map((p) => `- \`${p}\``)].join("\n"));
/** The repository on main: a charter, a top design listing the spec, and the spec (omitted with `spec: null`). */
function repoFiles(o: { spec?: string | null } = {}): Record<string, string> {
  const files: Record<string, string> = {
    "a.txt": "a\n",
    "docs/charter.md": CHARTER,
    [PARENT]: `# Product spec\n\nParent: docs/charter.md\n\n## Children\n\n- \`specs/010-thing/spec.md\`\n`,
  };
  const text = o.spec === undefined ? specOf() : o.spec;
  if (text !== null) files["specs/010-thing/spec.md"] = text;
  return files;
}

const FAIL = undefined;
const PLAN = { verdict: "ready", domain: "backend", tasks: [{ id: "T1", description: "d", files: ["a.txt"] }] };
const APPROVE = { verdict: "approve", findings_on_pr: [], declined_to_judge: [] };
const CHANGES = { verdict: "changes_requested", findings_on_pr: [{ criterion: "AC-1", file: "a.txt", line: 1, scenario: "z is not produced" }], declined_to_judge: [] };
const ask = (kind: Question["kind"], question: string): Question => ({
  kind, question, options: [{ label: "option 1", cost: "16 KB of RAM" }, { label: "option 2", cost: "a second flash partition" }], recommendation: "option 1",
});
const ESCALATE = (q: Question) => ({ verdict: "escalate", findings_on_pr: [], declined_to_judge: [], escalation: q });
const SEND = { verdict: "send", reasoning: "a trade-off only the maintainer can weigh" };

/** Stage scripts that do the agent's git work in the world `w()` (assigned once the world exists). */
function agents(w: () => ChainWorld) {
  return {
    implement: (n: number, files: Record<string, string> = { "a.txt": `pr ${n}\n` }, check?: (run: StageRun) => void) => (run: StageRun) => {
      check?.(run);
      const sha = w().push(run, files);
      w().openPr(run, n, sha);
      return { pr_number: n, head_sha: sha, tasks_done: ["T1"] };
    },
    fix: (files: Record<string, string>) => (run: StageRun) => ({ head_sha: w().push(run, files, "fix"), addressed: [0] }),
    /** A fix recording the answers of the questions asked so far as an ADR carrying each mark (AC-18, TI1). */
    adr: (file = "docs/decisions/0001-x.md") => (run: StageRun) => {
      const marks = w().questions().map((q) => `(maintainer answer, question #${q.id})`).join(", ");
      return { head_sha: w().push(run, { [file]: `# Use option 1\n\nDecided by the maintainer ${marks}.\n` }, "adr"), addressed: [] };
    },
    spec: (n: number, files: Record<string, string>) => (run: StageRun) => {
      const sha = w().push(run, files, "spec");
      w().openPr(run, n, sha, "Spec revision for the thing");
      return { verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: n, head_sha: sha };
    },
  };
}

/** Nothing left over: no chain errors, no unmatched route, no claim, no paused record. */
async function expectSettled(w: ChainWorld): Promise<void> {
  expect(w.logs.filter((r) => r.kind === "error")).toEqual([]);
  expect(w.gh.unmatched).toEqual([]);
  expect(await listClaims(w.paths)).toEqual([]);
  expect(await listPaused(w.paths)).toEqual([]);
}
const inputsOf = (w: ChainWorld, stage: string) => w.adapter.runs.filter((r) => r.stage === stage).map((r) => r.input);
const runsOf = (w: ChainWorld, stage: string) => w.adapter.runs.filter((r) => r.stage === stage);
const patchesOf = (w: ChainWorld, kind: string) => readdirSync(w.paths.patches).filter((f) => f.startsWith("7-") && f.includes(`-${kind}`));
const pausedRecord = (w: ChainWorld): PausedRecord => JSON.parse(readFileSync(join(w.paths.paused, "7.json"), "utf8"));
const QUESTION_MARKER = /\n\n<!-- panelator-question:([0-9a-f-]{36}) -->$/;

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
      results: { plan: [PLAN, PLAN], implement: [a.implement(9), a.implement(10)], review: [CHANGES, APPROVE], fix: [FAIL, FAIL] },
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

  describe("a stage that asks a question keeps its work (spec 011 AC-10)", () => {
    const rev = (run: StageRun) => git(run.worktree, "rev-parse", "HEAD").trim();
    /** Implement commits and pushes `issue-7` (and opens PR 9 when `pr`), then asks; `held` records the head it left. */
    function asksAfterPushing(w: () => ChainWorld, q: Question, held: { head: string }, pr = false) {
      return (run: StageRun) => {
        held.head = w().push(run, { "a.txt": "held work\n" }, "held");
        if (pr) w().openPr(run, 9, held.head);
        return { escalation: q };
      };
    }
    const kinds = (w: ChainWorld, kind: string) => w.logs.filter((r) => r.kind === kind);

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

    it("a question whose resumed stage then fails: the retry starts clean, with the stale-branch record", async () => {
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
      const main = git(w.pair.origin, "rev-parse", "main").trim();
      await w.tick();
      w.reply("Added it.");
      await w.tick();
      await expectSettled(w);

      expect(starts).toEqual([held.head, main]);
      expect(kinds(w, "stale-branch-dropped")).toMatchObject([{ issue: 7, branch: "issue-7" }]);
      expect(inputsOf(w, "implement")[2].held_work).toBeUndefined();
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

// ---------------------------------------------------------------------------------------------------------------
// Spec 015 AC-12: the chain keeps its work through postponements and network outages.

/**
 * The world's GitHub behind a switchable network (`down` set: every request fails as a DNS failure does, or, with
 * `genuine`, answers 422), without Octokit's own retries, and a clock the test moves forward.
 */
function network(w: ChainWorld) {
  const n = { down: false, genuine: false, offset: 0 };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    if (n.down && n.genuine) return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422, headers: { "content-type": "application/json" } });
    if (n.down) throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.github.com"), { code: "EAI_AGAIN" }) });
    return w.gh.fetch(input, init);
  }) as typeof fetch;
  w.deps.gh = new GitHubClient(new Octokit({ auth: "x", request: { fetch: fetchFn }, retry: { enabled: false } }), "o/r");
  w.deps.now = () => new Date(Date.now() + n.offset);
  return n;
}
const serviceRecords = (w: ChainWorld) => readFileSync(w.paths.serviceLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("end to end: the chain keeps its work (spec 015 AC-12)", () => {
  it("review postponed three times on a PR whose base moved, then run: no dropped patch (issue #35)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const moveMain = () => {
      writeFileSync(join(w.pair.repo, "main.txt"), "main moved\n");
      git(w.pair.repo, "add", "main.txt");
      git(w.pair.repo, "commit", "-q", "-m", "main moved");
      git(w.pair.repo, "push", "-q", "origin", "main");
    };
    // Main moves on after the PR is opened: every review is prepared with a rebase that moves HEAD.
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); moveMain(); return r; }], review: [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED, APPROVE] } });
    const n = network(w);
    await w.tick();
    // Each wait ends when the quota book says the limit resets (spec 013): move the clock past it and tick again.
    for (let i = 0; i < 10 && (await listClaims(w.paths)).length; i++) {
      const until = (await listClaims(w.paths))[0].state.postponedUntil;
      n.offset = Math.max(n.offset, (until ? Date.parse(until) - Date.now() : 0) + 1000);
      await w.tick();
    }
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review", "review", "review", "review"]);
    expect(w.mergeRequests).toEqual([9]);
    expect(patchesOf(w, "dropped")).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "worktree-synced" && r.dropped)).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "rebase-undone")).toHaveLength(3);
  }, 180_000);

  it("a chain whose GitHub calls fail with EAI_AGAIN for four steps: no chain error, no release, the PR kept, merged (issue #29)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let n!: ReturnType<typeof network>;
    // The network goes down just after implement opened PR 9: the step's PR binding check is the first call to fail.
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); n.down = true; return r; }], review: [APPROVE] } });
    n = network(w);
    await w.tick();
    // Each retry after its backoff (60, 120, 240, 480 s), short of the two-hour alarm.
    for (let i = 0; i < 4; i++) {
      n.offset += 1000_000;
      await w.tick();
    }
    const during = (await listClaims(w.paths))[0];
    expect(during.outage).toMatchObject({ count: 5, alarmed: false });
    expect(during.state.chainFailures).toBeNull();
    n.down = false;
    n.offset += 1000_000;
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["plan", "implement", "review"]);
    expect(w.mergeRequests).toEqual([9]);
    expect(w.prs.get(9)?.merged).toBe(true);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "stale-branch-dropped" || r.kind === "recovered-commits")).toEqual([]);
    expect(w.logs.filter((r) => r.kind === "stage-result-kept")).toHaveLength(5);
    const records = serviceRecords(w);
    expect(records.filter((r) => r.kind === "transient-outage")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "transient-outage-over")).toHaveLength(1);
    expect(records.filter((r) => r.kind === "chain-error")).toEqual([]);
  }, 180_000);

  it("the same chain with a genuine error three times: chain_error and a release, as today", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    let n!: ReturnType<typeof network>;
    w = await chainWorld({ files: repoFiles(), results: { plan: [PLAN], implement: [(run: StageRun) => { const r = a.implement(9)(run); n.down = true; n.genuine = true; return r; }] } });
    n = network(w);
    await w.tick();
    for (let i = 0; i < 2; i++) await w.tick();
    expect((await listClaims(w.paths))[0].state.chainFailures?.count).toBe(3);
    // The second and third steps re-checked the recorded implement run (AC-10); implement ran once.
    expect(w.logs.filter((r) => r.kind === "stage-result-kept")).toHaveLength(2);
    expect(w.adapter.ran).toEqual(["plan", "implement"]);
    n.down = false;
    const t = await w.tick();
    expect(t.released).toEqual([7]);
    expect(serviceRecords(w).filter((r) => r.kind === "chain-error")).toHaveLength(1);
    expect(serviceRecords(w).find((r) => r.kind === "transient-outage")).toBeUndefined();
    // The release comment carries the genuine error; the issue is claimed again later in the same tick, as today.
    const released = w.comments.filter((c) => c.body.startsWith("Claim released: the scheduler failed on this issue repeatedly."));
    expect(released).toHaveLength(1);
    expect(released[0].body).toContain("Validation Failed");
  }, 180_000);
});

describe('standing agents: recorded runs through the real runner and mocked App',()=>{
 const why='Independently verified operational adjustment';
 const context=(w:Awaited<ReturnType<typeof standingWorld>>)=>({paths:w.paths,parameters:w.parameters,log:new ActionLog(w.paths.actionsLog),levels:loadActionLevels(join(agentsDir,'actions.yaml')),gh:w.gh,now:w.deps.now});
 async function idle(w:Awaited<ReturnType<typeof standingWorld>>){for(let i=0;i<1000&&w.scheduler.active;i++)await new Promise(r=>setTimeout(r,25));expect(w.scheduler.active).toBe(0);}
 it('takes a slot on a missed schedule once, applies a parameter and command undo, logs locked refusal',async()=>{
  const w=await standingWorld({operator:[{summary:'adjusted',actions:[{kind:'set_parameter',args:{name:'system_work_share',value:0.5},why},{kind:'set_parameter',args:{name:'aws_cap_usd',value:1},why}]}]});
  w.setNow(new Date('2026-10-01T12:00:00Z'));await w.scheduler.tick();await idle(w);
  expect(w.adapter.ran).toEqual(['operator']);expect((await w.parameters.read('system_work_share')).value).toBe(0.5);
  const rows=await context(w).log.list();expect(rows.map(r=>r.status)).toEqual(['applied','refused']);
  const config=join(w.pair.root,'cli-config.json');writeFileSync(config,JSON.stringify({...w.deps.cfg,state_dir:w.paths.root,app:{...w.deps.cfg.app,id:0,installation_id:0}}));
  const command=execFileSync(process.execPath,[join(agentsDir,'..','tools','scheduler','bin','scheduler.ts'),'action','undo',rows[0].id,'--config',config],{encoding:'utf8'});
  expect(JSON.parse(command)).toMatchObject({status:'applied',agent:'maintainer',undoes:rows[0].id});expect((await w.parameters.read('system_work_share')).value).toBe(0.75);
  await w.scheduler.tick();await idle(w);expect(w.adapter.ran).toEqual(['operator']);
  expect(w.mock.unmatched).toEqual([]);
 },30000);
 it('wakes the filer on queued findings and records file, discard, merge and private advisory decisions',async()=>{
  const issue={title:'Verified bug',body:'Evidence verified in source',class:'class:bug'};
  const w=await standingWorld({'findings-filer':[{summary:'triaged five',decisions:[{ref:'1',outcome:'file',reason:'independently verified',issue},{ref:'2',outcome:'discard',reason:'not an issue'},{ref:'3',outcome:'merge_into',reason:'same cause',issue_number:90},{ref:'4',outcome:'file',reason:'security must stay private',issue},{ref:'5',outcome:'security',reason:'second private finding',advisory:{title:'Second',description:'Second advisory',severity:'low'}}]}]});
  w.issues.push({number:90,title:'Existing bug',body:'Existing evidence',user:{login:BOT.login},labels:[{name:'validated'},{name:'class:bug'}],created_at:'2026-10-01T00:00:00Z'});
  await appendFindings(w.paths,{issue:7,stage:'review',run_id:'merge-review',timestamp:w.deps.now().toISOString()},[1,2,3,4,5].map(n=>({what:`finding ${n}`,where:'a.txt',evidence:'observed',noticed_how:'merge review',...(n>=4?{security:true}:{})})));
  expect((await w.scheduler.tick()).claimed).toEqual([]);await idle(w);
  const triage=await readJsonLines<TriageEntry>(w.paths.findingsTriage);expect(triage.map(t=>t.outcome)).toEqual(['file','discard','merge_into','security','security']);
  expect(w.mock.calls.filter(c=>c.method==='POST'&&c.url==='/repos/o/r/issues')).toHaveLength(1);
  expect(w.mock.calls.filter(c=>c.method==='POST'&&c.url==='/repos/o/r/security-advisories')).toHaveLength(2);expect(w.mock.unmatched).toEqual([]);
  // AC-22: each advisory notification has its own rate-limit key (issue:gate:label), so neither is dropped as a duplicate of the other.
  const keys=w.notifications.map(n=>`${n.issue}:${n.gate}:${n.label}`);expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(2);expect(keys.every(k=>k.startsWith('0:standing:findings-filer:'))).toBe(true);
 },30000);
 it('retries abandoned work twice and then defers after re-abandonment',async()=>{
  const result={summary:'retry with a corrected approach',decisions:[{ref:'issue:7',outcome:'retry',reason:'Read the new design before implementing'}]};
  const w=await standingWorld({'findings-filer':[result,result,result]});
  w.issues.push({number:7,title:'Abandoned',body:'No spec yet',user:{login:BOT.login},labels:[{name:'abandoned'}],created_at:'2026-10-01T00:00:00Z'});
  for(let i=0;i<3;i++){
   w.setNow(new Date(Date.UTC(2026,9,1+i*8)));w.issues[0].labels=[{name:'abandoned'}];
   await runStandingAgent({...w.deps,parameters:w.parameters},w.registry['findings-filer'],(await readAgentState(w.paths,'findings-filer'))!);
  }
  expect((await readJsonLines<TriageEntry>(w.paths.findingsTriage)).map(t=>t.outcome)).toEqual(['retry','retry','defer']);expect(w.mock.unmatched).toEqual([]);
 },30000);
 it('a design-flaw intake issue starts at spec/write and reaches the independent question check',async()=>{
  const question=ask('technical','Does this finding reveal a design flaw?');
  const w=await chainWorld({files:repoFiles({spec:null}),issueBody:'Possible design flaw\n\nVerified investigation and options.',results:{spec:[{verdict:'question',question}],'question-check':[SEND]}});
  await w.tick();expect(w.adapter.ran).toEqual(['spec','question-check']);expect(inputsOf(w,'spec')[0].mode).toBe('write');expect(await listPaused(w.paths)).toHaveLength(1);expect(w.gh.unmatched).toEqual([]);
 },30000);
 it('queues level-2 refusal and cannot resume a maintainer pause',async()=>{
  const w=await standingWorld({});const ctx=context(w);
  const request=(kind:string,args:Record<string,unknown>,maintainer=false)=>applyAction(ctx,{agent:maintainer?'maintainer':'operator',run_id:'fixture',kind,args,why},maintainer?'maintainer':['pause_agent','resume_agent','set_parameter']);
  await request('pause_agent',{name:'action-audit'},true);expect((await request('resume_agent',{name:'action-audit'})).status).toBe('refused');
  ctx.levels.set_parameter=2;expect((await request('set_parameter',{name:'slots',value:2})).reason).toBe('level 2');expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);
 });
 it('retries a failed standing run once and then records one finding and notification',async()=>{
  const w=await standingWorld({operator:[undefined,undefined]});
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=w.deps.now().toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);expect((await readAgentState(w.paths,'operator'))?.failures).toBe(1);
  await w.scheduler.tick();await idle(w);expect((await readAgentState(w.paths,'operator'))?.last_run?.outcome).toBe('failed');
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);expect(w.notifications).toHaveLength(1);
 },30000);
const FAILED_TWICE='standing agent findings-filer failed twice';
 const filerRunWords=(w:Awaited<ReturnType<typeof standingWorld>>)=>readdirSync(w.paths.runs).filter(d=>d.startsWith('standing-findings-filer')).sort((x,y)=>Number(x.split('-')[4])-Number(y.split('-')[4]));
 const lastFilerInput=(w:Awaited<ReturnType<typeof standingWorld>>)=>{const dirs=filerRunWords(w);return JSON.parse(readFileSync(join(w.paths.runs,dirs[dirs.length-1],'input.json'),'utf8'));};
 const failFilerTwice=async()=>{
  const w=await standingWorld({'findings-filer':[undefined,undefined,{summary:'triaged',decisions:[]}],operator:[{summary:'quiet'},{summary:'quiet'}]});
  const state=(await readAgentState(w.paths,'findings-filer'))!;state.next_run=w.deps.now().toISOString();await writeAgentState(w.paths,'findings-filer',state);
  await w.scheduler.tick();await idle(w);await w.scheduler.tick();await idle(w);
  return w;
 };
 it('a twice-failed filer is not woken by its own failure finding before its schedule (spec 020 AC-1, AC-2, AC-5)',async()=>{
  const w=await failFilerTwice();
  expect(await readAgentState(w.paths,'findings-filer')).toMatchObject({failures:0,next_run:'2026-10-02T00:00:00.000Z',pending_events:[],last_run:{outcome:'failed'}});
  const queue=await readJsonLines<{finding:{what:string}}>(w.paths.findingsQueue);
  expect(queue.map(r=>r.finding.what)).toEqual([FAILED_TWICE]);expect(w.notifications).toHaveLength(1);
  const runs=readdirSync(w.paths.runs).length;
  for(let i=1;i<=3;i++){w.setNow(new Date(w.deps.now().getTime()+i*2*60_000));await w.scheduler.tick();await idle(w);}
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toHaveLength(2);
  expect(readdirSync(w.paths.runs)).toHaveLength(runs);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);expect(w.notifications).toHaveLength(1);
  w.setNow(new Date('2026-10-02T00:00:30Z'));for(let i=0;i<2;i++){await w.scheduler.tick();await idle(w);}
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toHaveLength(3);
  expect(JSON.stringify(lastFilerInput(w))).toContain(FAILED_TWICE);
 },30000);
 it('a twice-failed filer is still woken by a foreign finding, after the debounce, and reads its own failure record (spec 020 AC-2, AC-5; spec 025 AC-14)',async()=>{
  const w=await failFilerTwice();w.setNow(new Date(w.deps.now().getTime()+60_000));
  await appendFindings(w.paths,{issue:7,stage:'review',run_id:'r1',timestamp:w.deps.now().toISOString()},[{what:'foreign finding',where:'a.txt',evidence:'observed',noticed_how:'review'}]);
  // Spec 025 AC-14: the event is delivered, and waits out the debounce from the failed run.
  await w.scheduler.tick();await idle(w);
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toHaveLength(2);
  expect((await readAgentState(w.paths,'findings-filer'))?.pending_events).toHaveLength(1);
  await w.parameters.setParameter('standing.event_debounce','0m','maintainer');
  await w.scheduler.tick();await idle(w);
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toHaveLength(3);
  const input=JSON.stringify(lastFilerInput(w));expect(input).toContain('foreign finding');expect(input).toContain(FAILED_TWICE);
 },30000);
 it('the exclusion holds with the service\'s two-parameter emitEvent, as bin/scheduler.ts supplies it (spec 020 AC-1, AC-2)',async()=>{
  const w=await standingWorld({'findings-filer':[undefined,undefined,{summary:'triaged',decisions:[]}]});
  // bin/scheduler.ts injects an emitEvent that never sees a third argument; the failure finding must still skip its agent.
  w.deps.emitEvent=(event:string,payload:unknown)=>emit(w.paths,w.registry,event,payload,w.deps.now());
  const state=(await readAgentState(w.paths,'findings-filer'))!;state.next_run=w.deps.now().toISOString();await writeAgentState(w.paths,'findings-filer',state);
  await w.scheduler.tick();await idle(w);await w.scheduler.tick();await idle(w);
  expect(await readAgentState(w.paths,'findings-filer')).toMatchObject({failures:0,pending_events:[],last_run:{outcome:'failed'}});
  w.setNow(new Date(w.deps.now().getTime()+2*60_000));await w.scheduler.tick();await idle(w);
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toHaveLength(2);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);expect(w.notifications).toHaveLength(1);
 },30000);
 it('a standing agent already blocked when it comes due starts no run and waits for the reset (spec 013 AC-7)',async()=>{
  const w=await standingWorld({operator:[{summary:'after the reset'}]});
  const t0=new Date('2026-10-01T00:00:00Z');
  await observeRun(w.paths,{run_id:'x',issue:7,stage:'review',attempt:1,outcome:'failed',harness:'claude',model:'claude-fable-5-1',cost_usd:0,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,turns:1,tool_calls:0,wall_seconds:1,started_at:t0.toISOString(),ended_at:t0.toISOString(),events_path:''},{outcome:'failed',reason:"You've hit your session limit · resets 3am (UTC)",apiErrorStatus:429,finalText:null},t0);
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=t0.toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);
  expect(w.adapter.ran).toEqual([]);
  expect((await readAgentState(w.paths,'operator'))).toMatchObject({failures:0,postponed_until:'2026-10-01T03:00:00.000Z',last_run:null});
  expect(readdirSync(w.paths.runs)).toEqual([]);
  w.setNow(new Date('2026-10-01T02:59:00Z'));await w.scheduler.tick();await idle(w);expect(w.adapter.ran).toEqual([]);
  w.setNow(new Date('2026-10-01T03:00:30Z'));await w.scheduler.tick();await idle(w);expect(w.adapter.ran).toEqual(['operator']);
  expect((await readAgentState(w.paths,'operator'))?.last_run?.outcome).toBe('ok');
 },30000);
 it('an agent moved to the fallback model before launch records the run id it actually runs under (spec 013 AC-9)',async()=>{
  const seen:{running?:string;run?:string}={};
  const w=await standingWorld({operator:[(run:StageRun)=>{seen.running=JSON.parse(readFileSync(join(w.paths.agents,'operator.json'),'utf8')).running?.run_id;seen.run=run.runId;return {summary:'on opus'};}]});
  const t0=new Date('2026-10-01T00:00:00Z');
  await observeRun(w.paths,{run_id:'x',issue:7,stage:'review',attempt:1,outcome:'failed',harness:'claude',model:'claude-fable-5-1',cost_usd:0,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,turns:1,tool_calls:0,wall_seconds:1,started_at:t0.toISOString(),ended_at:t0.toISOString(),events_path:''},{outcome:'failed',reason:"You've reached your Fable limit. Switch to another model.",apiErrorStatus:429,finalText:null},t0);
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=t0.toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);
  expect(w.adapter.runs.map(r=>r.model)).toEqual(['claude-opus-5-5']);
  expect(seen.running).toMatch(/-fallback$/);expect(seen.running).toBe(seen.run);
  expect((await readAgentState(w.paths,'operator'))?.last_run?.outcome).toBe('ok');
 },30000);
 it('a standard-tier standing agent is postponed on a 429 too, not counted as a failure (spec 013 AC-7)',async()=>{
  const w=await standingWorld({operator:[RATE_LIMITED]});
  w.registry.operator={...w.registry.operator,tier:'standard',fallback:undefined};
  const t0=new Date('2026-10-01T00:00:00Z');
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=t0.toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);
  expect(await readAgentState(w.paths,'operator')).toMatchObject({failures:0,postponed_until:'2026-10-01T00:15:00.000Z',last_run:null});
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
 },30000);
 it('a rate-limited filer does not feed itself: no finding from the 429, and new queued findings do not override the wait (issue #24)',async()=>{
  const w=await standingWorld({'findings-filer':[RATE_LIMITED,{summary:'triaged',decisions:[]}]});
  const t0=new Date('2026-10-01T00:00:00Z');
  const finding=(n:number)=>appendFindings(w.paths,{issue:7,stage:'review',run_id:`r${n}`,timestamp:w.deps.now().toISOString()},[{what:`finding ${n}`,where:'a.txt',evidence:'observed',noticed_how:'review'}]);
  await finding(1);
  await w.scheduler.tick();await idle(w);
  let state=(await readAgentState(w.paths,'findings-filer'))!;
  expect(state).toMatchObject({failures:0,postponed_until:'2026-10-01T00:15:00.000Z'});
  expect(state.pending_events.length).toBeGreaterThan(0);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);
  // More findings arrive during the wait; ticks before the reset still start no filer run.
  for(let i=1;i<=5;i++){await finding(i+1);w.setNow(new Date(t0.getTime()+i*2*60_000));await w.scheduler.tick();await idle(w);}
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toEqual(['findings-filer']);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(6);expect(w.notifications).toHaveLength(0);
  w.setNow(new Date('2026-10-01T00:16:00Z'));await w.scheduler.tick();await idle(w);
  state=(await readAgentState(w.paths,'findings-filer'))!;
  // After the reset the filer runs again (once), and the postponement is gone.
  expect(w.adapter.ran.filter(s=>s==='findings-filer')).toEqual(['findings-filer','findings-filer']);
  expect(state.postponed_until).toBeUndefined();
 },30000);
 it('a rate-limited standing run is postponed until the limit lifts, without a failure, finding or retry per tick (spec 013 AC-7)',async()=>{
  const w=await standingWorld({operator:[RATE_LIMITED,RATE_LIMITED,{summary:'ran after the limit'}]});
  const t0=new Date('2026-10-01T00:00:00Z');
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=t0.toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);
  let after=(await readAgentState(w.paths,'operator'))!;
  // An unrecognised 429 backs off 15 minutes; the failure count and the schedule are untouched.
  expect(after).toMatchObject({failures:0,postponed_until:'2026-10-01T00:15:00.000Z',next_run:t0.toISOString(),last_run:null});
  // Ticks before the wait ends start no run (issue #24).
  for(let i=0;i<3;i++){w.setNow(new Date(t0.getTime()+(i+1)*60_000));await w.scheduler.tick();await idle(w);}
  expect(w.adapter.ran.filter(s=>s==='operator')).toEqual(['operator']);
  w.setNow(new Date('2026-10-01T00:16:00Z'));await w.scheduler.tick();await idle(w);
  after=(await readAgentState(w.paths,'operator'))!;
  expect(after).toMatchObject({failures:0,postponed_until:'2026-10-01T00:46:00.000Z'});
  w.setNow(new Date('2026-10-01T00:47:00Z'));await w.scheduler.tick();await idle(w);
  after=(await readAgentState(w.paths,'operator'))!;
  expect(after.last_run?.outcome).toBe('ok');expect(after.postponed_until).toBeUndefined();
  expect(w.adapter.ran.filter(s=>s==='operator')).toEqual(['operator','operator','operator']);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
  const ticks=readFileSync(w.paths.serviceLog,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(r=>r.kind==='tick');
  // AC-10: the tick line shows the limit and the agent waiting on it while it lasts.
  expect(ticks[1].quota).toEqual({limits:[{key:'claude:claude-fable-5-1',scope:'unknown',resets_at:'2026-10-01T00:15:00.000Z',source:'backoff'}],waiting:[{what:'agent:operator',until:'2026-10-01T00:15:00.000Z'}]});
  expect(ticks.at(-1).quota).toBeUndefined();
 },30000);
});

// ---------------------------------------------------------------------------------------------------------------
// Spec 029 section 6: the design stage, recorded through the real Scheduler, driver and machine.

describe("end to end: the design stage (spec 029)", () => {
  const uiSpec = () => readFileSync(join(import.meta.dirname, "fixtures", "specs", "good-webui.md"), "utf8").replace("Parent: docs/top.md", `Parent: ${PARENT}`);
  const SCREENS = ["editor-empty", "editor-populated"];
  const DESIGN = "specs/010-thing/design/";
  const uiFiles = (design: boolean) => {
    const files = { ...repoFiles(), "specs/010-thing/spec.md": uiSpec() };
    return design ? withDesign(files, "specs/010-thing/spec.md", SCREENS) : files;
  };
  /** A design run's git work: a story and the renders (all three sizes unless `drop` names one), the PR, and the result. */
  const design = (w: () => ChainWorld, n: number, o: { drop?: string; tag?: string; renders?: number } = {}) => (run: StageRun) => {
    const files: Record<string, string> = { [`${DESIGN}editor.stories.tsx`]: `export default {}; // ${o.tag ?? "a"}\n` };
    for (const s of SCREENS) for (const suffix of ["", ".mobile", ".tablet"]) if (`${s}${suffix}.png` !== o.drop) files[`${DESIGN}${s}${suffix}.png`] = `png ${o.tag ?? "a"}\n`;
    const sha = w().push(run, files, "design");
    w().openPr(run, n, sha, `Refs #7\n\n![editor-empty](${DESIGN}editor-empty.png)`);
    const renders = ["x.png", "x.mobile.png", "x.tablet.png"].slice(0, o.renders ?? 3);
    return { verdict: "designed", spec_path: "specs/010-thing/spec.md", pr_number: n, head_sha: sha, screens: SCREENS.map((name) => ({ name, stories: [`${name}--default`], renders })) };
  };
  const newMerge = (w: ChainWorld) => w.mergeRequests;

  it("runs the design stage on design-7 for a UI spec without design/, reviews it with the design profile, fixes, merges, then plans (AC-1, AC-3, AC-4)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: uiFiles(false),
      results: {
        design: [design(() => w, 12)],
        review: [CHANGES, APPROVE, APPROVE],
        fix: [a.fix({ [`${DESIGN}editor-empty.png`]: "re-rendered\n" })],
        plan: [PLAN], implement: [a.implement(13)],
      },
    });
    expect((await w.tick()).claimed).toEqual([7]);
    await expectSettled(w);

    expect(w.adapter.ran).toEqual(["design", "review", "fix", "review", "plan", "implement", "review"]);
    const [d] = runsOf(w, "design");
    expect(d).toMatchObject({ branch: "design-7", profile: "design" });
    expect(d.input).toMatchObject({ spec_path: "specs/010-thing/spec.md", viewports: expect.stringContaining("desktop 1440x900") });
    expect(d.input.design_problem).toMatch(/editor-empty\.mobile\.png/);
    expect(runsOf(w, "review").map((r) => [r.branch, r.profile])).toEqual([["design-7", "design"], ["design-7", "design"], ["issue-7", "backend"]]);
    expect(runsOf(w, "fix")[0]).toMatchObject({ branch: "design-7", profile: "design", model: d.model });
    expect(runsOf(w, "review")[0].input.pr?.number).toBe(12);
    expect(newMerge(w)).toEqual([12, 13]);
    expect(w.writes()).toContain("DELETE /repos/o/r/git/refs/heads/design-7");
    expect(w.onMain(`${DESIGN}editor-populated.tablet.png`)).not.toBeNull();
    expect(w.onMain(`${DESIGN}editor-empty.png`)).toBe("re-rendered\n");
    // The plan runs on issue-7 from the merged design, with fresh counters.
    expect(runsOf(w, "plan")[0].branch).toBe("issue-7");
    expect(w.issueOpen).toBe(false);
    // No code path applies needs-design-stage, and nothing is commented.
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
    expect(w.comments).toEqual([]);
  }, 180_000);

  it("fails a design result with a screen of fewer than three renders as an invalid result, then accepts the retry (AC-2)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    w = await chainWorld({
      files: uiFiles(false),
      results: { design: [design(() => w, 12, { renders: 2 }), design(() => w, 12)], review: [APPROVE, APPROVE], plan: [PLAN], implement: [a.implement(13)] },
    });
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran.slice(0, 3)).toEqual(["design", "design", "review"]);
    const first = readdirSync(w.paths.runs).find((r) => r.startsWith("7-design-1-"))!;
    expect(readFileSync(join(w.paths.runs, first, "outcome.json"), "utf8")).toMatch(/renders/);
    expect(inputsOf(w, "design")[1].history).toContain("design attempt 1 failed: result: invalid");
    expect(newMerge(w)).toEqual([12, 13]);
  }, 180_000);

  it("sends the spec agent in revise mode when the gate still fails after two design merges, then designs again (AC-4)", async () => {
    let w!: ChainWorld;
    const a = agents(() => w);
    const revisedSpec = uiSpec().replace("A screen.", "A screen, simpler.");
    const specRun = (run: StageRun) => {
      const sha = w.push(run, { "specs/010-thing/spec.md": revisedSpec }, "spec");
      w.openPr(run, 14, sha, "Refs #7\n\nRevised UI design section");
      return { verdict: "revised", spec_path: "specs/010-thing/spec.md", pr_number: 14, head_sha: sha };
    };
    w = await chainWorld({
      files: uiFiles(false),
      results: {
        design: [design(() => w, 12, { drop: "editor-populated.tablet.png" }), design(() => w, 13, { drop: "editor-populated.tablet.png", tag: "b" }), design(() => w, 15, { tag: "c" })],
        spec: [specRun],
        review: [APPROVE, APPROVE, APPROVE, APPROVE, APPROVE],
        plan: [PLAN], implement: [a.implement(16)],
      },
    });
    await w.tick();
    await expectSettled(w);
    expect(w.adapter.ran).toEqual(["design", "review", "design", "review", "spec", "review", "design", "review", "plan", "implement", "review"]);
    const [spec1] = runsOf(w, "spec");
    expect(spec1.input.mode).toBe("revise");
    expect(spec1.input.spec_problem).toContain("the design stage could not satisfy the UI design section");
    expect(spec1.input.spec_problem).toContain("editor-populated.tablet.png");
    expect(runsOf(w, "design").map((r) => r.branch)).toEqual(["design-7", "design-7", "design-7"]);
    expect(newMerge(w)).toEqual([12, 13, 14, 15, 16]);
    expect(w.labelLog).toEqual(["+in-progress", "-in-progress"]);
  }, 240_000);

  it("removes needs-design-stage from a parked issue once, with one comment, and a restart comments nothing (AC-8)", async () => {
    const w = await chainWorld({ files: uiFiles(true), labels: ["validated", "class:product", "needs-design-stage", "blocked"], results: {} });
    await w.tick();
    expect(w.labelLog).toEqual(["-needs-design-stage"]);
    expect(w.comments.map((c) => c.body)).toEqual([expect.stringContaining("design stage now exists")]);
    expect(JSON.parse(readFileSync(w.paths.designRelabelled, "utf8"))).toEqual([7]);
    // The label comes back; a new Scheduler over the same state directory leaves the issue alone.
    w.labels.add("needs-design-stage");
    w.labelLog.length = 0;
    await new Scheduler(w.deps).tick();
    expect(w.labelLog).toEqual([]);
    expect(w.comments).toHaveLength(1);
    expect(w.adapter.ran).toEqual([]);
  }, 120_000);
});
