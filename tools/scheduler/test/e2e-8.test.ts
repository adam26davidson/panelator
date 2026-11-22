import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsDir } from "../src/config.ts";
import type { StageRun } from "../src/adapters/types.ts";
import { listPaused } from "../src/state/paused.ts";
import { ActionLog } from '../src/actions/log.ts';
import { loadActionLevels, applyAction } from '../src/actions/index.ts';
import { appendFindings } from '../src/state/findings.ts';
import { observeRun } from '../src/quota/book.ts';
import { readAgentState, writeAgentState } from '../src/standing/state.ts';
import { emit } from '../src/standing/events.ts';
import { runStandingAgent } from '../src/standing/run.ts';
import { readJsonLines, type TriageEntry } from '../src/filer/input.ts';
import { openIndex } from "../src/events/index.ts";
import { chainWorld, standingWorld, RATE_LIMITED, NETWORK_DOWN, UNREACHABLE_REASON } from "./helpers/e2e-routes.ts";
import { BOT, repoFiles, ask, SEND, inputsOf, recordWorlds } from "./helpers/e2e-chain.ts";

// Leaves this file's worlds for e2e-event-kinds.test.ts (spec 026 AC-2).
recordWorlds("e2e-8");

describe('standing agents: recorded runs through the real runner and mocked App',()=>{
 const why='Independently verified operational adjustment';
 const context=(w:Awaited<ReturnType<typeof standingWorld>>)=>({paths:w.paths,parameters:w.parameters,log:new ActionLog(w.paths.actionsLog,w.paths),levels:loadActionLevels(join(agentsDir,'actions.yaml')),gh:w.gh,now:w.deps.now});
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
it('records two agent.run events when a standing agent fails once and succeeds on the retry (spec 026 AC-2)',async()=>{
  const w=await standingWorld({operator:[undefined,{summary:'recovered'}]});
  const state=(await readAgentState(w.paths,'operator'))!;state.next_run=w.deps.now().toISOString();await writeAgentState(w.paths,'operator',state);
  await w.scheduler.tick();await idle(w);await w.scheduler.tick();await idle(w);
  const db=openIndex(w.paths);
  const runs=(db.prepare("SELECT agent, run_id, payload FROM events WHERE kind = 'agent.run' ORDER BY at, rowid").all() as {agent:string;run_id:string;payload:string}[]).map(r=>({agent:r.agent,...JSON.parse(r.payload)}));
  db.close();
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({agent:'operator',outcome:'failed',attempt:1,error:expect.any(String)});
  expect(runs[1]).toMatchObject({agent:'operator',outcome:'ok',attempt:2,summary:'recovered'});
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

 // Spec 045: a standing agent waits out a network outage; it is not the agent's failure.
 type SW=Awaited<ReturnType<typeof standingWorld>>;
 const dueNow=async(w:SW,name:string,extra:Record<string,unknown>={})=>{const st=(await readAgentState(w.paths,name))!;await writeAgentState(w.paths,name,{...st,...extra,next_run:w.deps.now().toISOString()});};
 const tickAt=async(w:SW,at:string)=>{w.setNow(new Date(at));await w.scheduler.tick();await idle(w);};
 const capture=(w:SW)=>{const logs:Record<string,unknown>[]=[];w.deps.log=r=>{logs.push(r as Record<string,unknown>);};return {logs,kinds:(agent:string,kind:string)=>logs.filter(l=>l.kind===kind&&l.agent===agent)};};
 const T0='2026-10-01T00:00:00.000Z';
 it('waits out a network outage with backoff, counting nothing, and ends it with the next ok run (spec 045 AC-2 to AC-4, AC-7)',async()=>{
  const w=await standingWorld({'findings-filer':[NETWORK_DOWN,NETWORK_DOWN,{summary:'triaged',decisions:[]}]});
  const log=capture(w);await dueNow(w,'findings-filer');
  await tickAt(w,T0);
  let st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st).toMatchObject({failures:0,postponed_until:'2026-10-01T00:01:00.000Z',next_run:T0,last_run:null,outage:{since:T0,count:1,alarmed:false,last:UNREACHABLE_REASON}});
  expect(st.running).toBeUndefined();expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
  await tickAt(w,'2026-10-01T00:00:30.000Z');expect(w.adapter.ran).toEqual(['findings-filer']);
  await tickAt(w,'2026-10-01T00:01:10.000Z');
  st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st).toMatchObject({failures:0,postponed_until:'2026-10-01T00:03:10.000Z',outage:{since:T0,count:2}});
  await tickAt(w,'2026-10-01T00:04:00.000Z');
  st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st.outage).toBeUndefined();expect(st.postponed_until).toBeUndefined();expect(st.last_run?.outcome).toBe('ok');
  expect(log.kinds('findings-filer','standing-outage')).toMatchObject([{cause:'EAI_AGAIN'}]);
  const postponed=log.kinds('findings-filer','standing-postponed');expect(postponed).toHaveLength(2);
  expect(String(postponed[0].error)).toMatch(/; postponed until 2026-10-01T00:01:00.000Z$/);
  expect(log.kinds('findings-filer','standing-outage-over')).toMatchObject([{since:T0,failures:2}]);
  expect(log.kinds('findings-filer','standing-error')).toHaveLength(0);
  expect(filerRunWords(w)).toHaveLength(3);expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
 },60000);
 it('postpones a standing agent whose input build is cut off by the network (spec 045 AC-1, AC-7)',async()=>{
  const w=await standingWorld({'findings-filer':[{summary:'triaged',decisions:[]}]});
  const log=capture(w);await dueNow(w,'findings-filer');
  // The filer's input build is the first GitHub read of the attempt; the socket error surfaces from it once.
  const real=w.gh.listOpenIssuesByAuthor.bind(w.gh);
  w.gh.listOpenIssuesByAuthor=async a=>{w.gh.listOpenIssuesByAuthor=real;throw Object.assign(new Error('read EHOSTUNREACH'),{code:'EHOSTUNREACH'});};
  await tickAt(w,T0);
  expect(await readAgentState(w.paths,'findings-filer')).toMatchObject({failures:0,postponed_until:'2026-10-01T00:01:00.000Z',outage:{count:1}});
  expect(log.kinds('findings-filer','standing-outage')).toMatchObject([{cause:'EHOSTUNREACH'}]);
  expect(w.adapter.ran).toEqual([]);expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
  await tickAt(w,'2026-10-01T00:02:00.000Z');
  const st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st.outage).toBeUndefined();expect(st.last_run?.outcome).toBe('ok');expect(w.adapter.ran).toEqual(['findings-filer']);
 },60000);
 it('postpones a standing agent when the state volume is low, and runs it after the wait (spec 059 AC-3, AC-6)',async()=>{
  let low=true;
  const w=await standingWorld({'findings-filer':[{summary:'triaged',decisions:[]}]},async path=>({bytes:low&&path.endsWith('/worktrees')?100*2**20:20*2**30,inodes:1_000_000}));// only the agent's worktree volume: a full state root would also raise the sweep's alarm (spec 064 AC-2)
  const log=capture(w);await dueNow(w,'findings-filer');
  await tickAt(w,T0);
  expect(await readAgentState(w.paths,'findings-filer')).toMatchObject({failures:0,postponed_until:'2026-10-01T00:01:00.000Z',outage:{count:1,alarmed:false}});
  expect(log.kinds('findings-filer','standing-outage')).toMatchObject([{cause:'ENOSPC'}]);
  expect(w.adapter.ran).toEqual([]);expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);expect(w.notifications).toHaveLength(0);
  low=false;
  await tickAt(w,'2026-10-01T00:02:00.000Z');
  const st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st.outage).toBeUndefined();expect(st.last_run?.outcome).toBe('ok');expect(w.adapter.ran).toEqual(['findings-filer']);
 },60000);
 it('a transient failure between two genuine ones neither counts nor resets the count (spec 045 AC-2, AC-4, AC-7)',async()=>{
  const w=await standingWorld({operator:[undefined,NETWORK_DOWN,undefined]});
  const log=capture(w);await dueNow(w,'operator');
  await tickAt(w,T0);
  let st=(await readAgentState(w.paths,'operator'))!;expect(st.failures).toBe(1);expect(st.outage).toBeUndefined();
  await tickAt(w,'2026-10-01T00:01:00.000Z');
  st=(await readAgentState(w.paths,'operator'))!;
  expect(st).toMatchObject({failures:1,postponed_until:'2026-10-01T00:02:00.000Z',outage:{count:1}});
  await tickAt(w,'2026-10-01T00:01:30.000Z');expect(w.adapter.ran).toHaveLength(2);
  await tickAt(w,'2026-10-01T00:03:00.000Z');
  st=(await readAgentState(w.paths,'operator'))!;
  expect(st).toMatchObject({failures:0,last_run:{outcome:'failed'}});expect(st.outage).toBeUndefined();
  expect(st.last_run?.run_id).toContain('-2-');
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);expect(w.notifications).toMatchObject([{gate:'standing'}]);
  expect(log.kinds('operator','standing-outage-over')).toHaveLength(1);
 },60000);
 it('an outage two hours old raises one alarm: a finding, an infra notification and an infra_alarm event (spec 045 AC-5, AC-7)',async()=>{
  const w=await standingWorld({operator:[NETWORK_DOWN,NETWORK_DOWN]});
  const log=capture(w);
  const since='2026-09-30T22:00:00.000Z';
  await dueNow(w,'operator',{outage:{since,count:3,last:'x',alarmed:false}});
  await tickAt(w,T0);
  const st=(await readAgentState(w.paths,'operator'))!;
  expect(st).toMatchObject({failures:0,outage:{since,count:4,alarmed:true}});
  const queue=await readJsonLines<{finding:{what:string;where:string;evidence:string;noticed_how:string}}>(w.paths.findingsQueue);
  expect(queue).toHaveLength(1);
  expect(queue[0].finding).toMatchObject({what:'network outage blocks standing agent operator',where:'agents/standing/operator.md',noticed_how:'standing run transient error'});
  for(const part of ['4',since,'EAI_AGAIN'])expect(queue[0].finding.evidence).toContain(part);
  expect(w.notifications).toMatchObject([{gate:'infra',label:'operator:outage'}]);
  expect(log.kinds('operator','standing-outage-alarm')).toHaveLength(1);
  // spec 094 AC-2: through the constructor's default emitEvent, to infra health.
  expect((await readAgentState(w.paths,'infra-health'))!.pending_events).toEqual([{event:'infra_alarm',payload:{kind:'network_outage',agent:'operator',since,failures:4,cause:'EAI_AGAIN'},at:T0}]);
  expect(st.pending_events.filter(e=>e.event==='finding_queued')).toHaveLength(0);
  await tickAt(w,'2026-10-01T00:20:00.000Z');
  expect((await readAgentState(w.paths,'operator'))?.outage?.count).toBe(5);
  expect((await readAgentState(w.paths,'infra-health'))!.pending_events.filter(e=>e.event==='infra_alarm')).toHaveLength(1);
  expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(1);expect(w.notifications).toHaveLength(1);expect(log.kinds('operator','standing-outage-alarm')).toHaveLength(1);
 },60000);
 it('an outage a day old stops being transient: its failures count from the third past the ceiling (spec 045 AC-6, AC-7)',async()=>{
  const w=await standingWorld({operator:[NETWORK_DOWN,NETWORK_DOWN]});
  const log=capture(w);
  await dueNow(w,'operator',{outage:{since:'2026-09-29T23:00:00.000Z',count:10,last:'x',alarmed:true,past_ceiling:{since:'2026-09-30T23:29:00.000Z',failures:2}}});
  await tickAt(w,T0);
  let st=(await readAgentState(w.paths,'operator'))!;
  expect(st).toMatchObject({failures:1,outage:{ceiling:true,past_ceiling:{failures:3}}});expect(st.postponed_until).toBeDefined();
  expect(log.kinds('operator','standing-outage-ceiling')).toHaveLength(1);expect(await readJsonLines(w.paths.findingsQueue)).toHaveLength(0);
  await tickAt(w,new Date(Date.parse(st.postponed_until!)+1000).toISOString());
  st=(await readAgentState(w.paths,'operator'))!;
  expect(st).toMatchObject({failures:0,last_run:{outcome:'failed'}});
  const queue=await readJsonLines<{finding:{what:string;evidence:string}}>(w.paths.findingsQueue);
  expect(queue).toHaveLength(1);expect(queue[0].finding.evidence.startsWith('outage past ceiling: ')).toBe(true);expect(queue[0].finding.what).toBe('standing agent operator failed twice: EAI_AGAIN');
  expect(w.notifications).toHaveLength(1);expect(w.notifications[0]).toMatchObject({gate:'standing',label:'operator:failed:EAI_AGAIN'});expect(st.next_run).not.toBeNull();expect(st.pending_events).toEqual([]);
 },60000);
 it('a GitHub 404 while applying a filer result is a genuine failure, not an outage (spec 045 AC-1)',async()=>{
  const w=await standingWorld({'findings-filer':[{summary:'filed',decisions:[{ref:'1',outcome:'file',reason:'verified',issue:{title:'Bug',body:'Evidence',class:'class:bug'}}]}]});
  const log=capture(w);
  await appendFindings(w.paths,{issue:7,stage:'review',run_id:'r1',timestamp:T0},[{what:'finding',where:'a.txt',evidence:'observed',noticed_how:'review'}]);
  w.mock.routes.splice(w.mock.routes.findIndex(r=>r.method==='POST'&&String(r.path)==='/^\\/repos\\/o\\/r\\/issues$/'),1);
  await dueNow(w,'findings-filer');await tickAt(w,T0);
  const st=(await readAgentState(w.paths,'findings-filer'))!;
  expect(st.failures).toBe(1);expect(st.outage).toBeUndefined();expect(st.postponed_until).toBeUndefined();
  expect(log.kinds('findings-filer','standing-error')).toHaveLength(1);
 },60000);
 it('the failed-twice notification is keyed by the cause, so repeats of one cause share an identity (spec 102 AC-7)',async()=>{
  const w=await standingWorld({'findings-filer':[undefined,undefined],operator:[{summary:'quiet'},{summary:'quiet'}]});
  const base=w.adapter;
  w.deps.adapterFor=()=>({...base,judge:(e:unknown[],x:number|null,t:boolean)=>{const j=base.judge(e,x,t);return j.outcome==='failed'?{...j,reason:'spawn: spawn E2BIG'}:j;}}) as never;
  const state=(await readAgentState(w.paths,'findings-filer'))!;state.next_run=w.deps.now().toISOString();await writeAgentState(w.paths,'findings-filer',state);
  await w.scheduler.tick();await idle(w);await w.scheduler.tick();await idle(w);
  expect(w.notifications.filter(n=>n.gate==='standing')).toEqual([{issue:0,gate:'standing',label:'findings-filer:failed:spawn: spawn E2BIG',text:'Standing agent findings-filer failed twice: spawn: spawn E2BIG'}]);
 },60000);
 it('a twice-failed filer is not woken by its own failure finding before its schedule (spec 020 AC-1, AC-2, AC-5)',async()=>{
  const w=await failFilerTwice();
  expect(await readAgentState(w.paths,'findings-filer')).toMatchObject({failures:0,next_run:'2026-10-02T00:00:00.000Z',pending_events:[],last_run:{outcome:'failed'}});
  const queue=await readJsonLines<{finding:{what:string}}>(w.paths.findingsQueue);
  expect(queue).toHaveLength(1);expect(queue[0].finding.what.startsWith(FAILED_TWICE+': ')).toBe(true);expect(queue[0].finding.what).toBe(FAILED_TWICE+': exit');expect(w.notifications).toHaveLength(1);
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
 it('the exclusion holds whatever emitEvent a caller supplies, a two-parameter one included (spec 020 AC-1, AC-2)',async()=>{
  const w=await standingWorld({'findings-filer':[undefined,undefined,{summary:'triaged',decisions:[]}]});
  // An injected emitEvent that never sees a third argument must not defeat the exclusion: the queue's listener does not go through it.
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
  await observeRun(w.paths,{run_id:'x',issue:7,stage:'review',attempt:1,outcome:'failed',harness:'claude',model:'claude-fable-5-2',cost_usd:0,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,turns:1,tool_calls:0,wall_seconds:1,started_at:t0.toISOString(),ended_at:t0.toISOString(),events_path:''},{outcome:'failed',reason:"You've hit your session limit · resets 3am (UTC)",apiErrorStatus:429,finalText:null},t0);
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
  await observeRun(w.paths,{run_id:'x',issue:7,stage:'review',attempt:1,outcome:'failed',harness:'claude',model:'claude-fable-5-2',cost_usd:0,input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0,turns:1,tool_calls:0,wall_seconds:1,started_at:t0.toISOString(),ended_at:t0.toISOString(),events_path:''},{outcome:'failed',reason:"You've reached your Fable limit. Switch to another model.",apiErrorStatus:429,finalText:null},t0);
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
  expect(ticks[1].quota).toEqual({limits:[{key:'claude:claude-fable-5-2',scope:'unknown',resets_at:'2026-10-01T00:15:00.000Z',source:'backoff'}],waiting:[{what:'agent:operator',until:'2026-10-01T00:15:00.000Z'}]});
  expect(ticks.at(-1).quota).toBeUndefined();
 },30000);
});
