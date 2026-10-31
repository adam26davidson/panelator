// Spec 025: the repair turn and the debounce on finding_queued wakes, through the real runner and tick.
import {describe,it,expect} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import type {StageRun} from '../src/adapters/types.ts';
import {readJsonLines,type TriageEntry} from '../src/filer/input.ts';
import {appendFindings} from '../src/state/findings.ts';
import {emit} from '../src/standing/events.ts';
import {eventsWake,DEBOUNCED_EVENTS,readAgentState,writeAgentState,type AgentState} from '../src/standing/state.ts';
import {standingWorld,RATE_LIMITED} from './helpers/e2e-routes.ts';
type World=Awaited<ReturnType<typeof standingWorld>>;
const idle=async(w:World)=>{for(let i=0;i<1000&&w.scheduler.active;i++)await new Promise(r=>setTimeout(r,25));expect(w.scheduler.active).toBe(0);};
const tick=async(w:World)=>{await w.scheduler.tick();await idle(w);};
const queue=(w:World,what='a finding')=>appendFindings(w.paths,{issue:7,stage:'review',run_id:'r1',timestamp:w.deps.now().toISOString()},[{what,where:'a.txt',evidence:'observed',noticed_how:'review'}]);
const filerRuns=(w:World)=>w.adapter.runs.filter(r=>r.stage==='findings-filer');
const FILER='findings-filer';
const unknownShape={summary:'x',decisions:[{ref:'1',outcome:'file',reason:'r',title:'only a title'}]};
const good={summary:'ok',decisions:[{ref:'1',outcome:'discard',reason:'not an issue'}]};
describe('recorded shapes through the runner (spec 025 AC-2)',()=>{
 it('a recorded flat decision is applied, with the raw result and a note kept on the run',async()=>{
  const w=await standingWorld({[FILER]:[{summary:'x',decisions:[{ref:'1',outcome:'file',title:'Flat',body:'Flat body',class:'class:bug'}]}]});
  await queue(w);await tick(w);
  expect(filerRuns(w)).toHaveLength(1);
  expect((await readJsonLines<TriageEntry>(w.paths.findingsTriage))[0]).toMatchObject({ref:'1',outcome:'file'});
  const dir=readdirSync(w.paths.runs).find(d=>d.startsWith('standing-findings-filer'))!;
  expect(JSON.parse(readFileSync(join(w.paths.runs,dir,'outcome.json'),'utf8')).normalised).toEqual(['1: flat title, body, class gathered into issue','1: missing reason replaced by a placeholder']);
  expect(JSON.parse(readFileSync(join(w.paths.runs,dir,'result.json'),'utf8')).decisions[0].title).toBe('Flat');
 },30000);
});
describe('the repair turn (spec 025 AC-3 to AC-6)',()=>{
 it('resumes the session once with the errors, turn-capped, and the repaired result applies',async()=>{
  let repair:StageRun|undefined;
  const w=await standingWorld({[FILER]:[unknownShape,(run:StageRun)=>{repair=run;return good;}]});
  await queue(w);await tick(w);
  const runs=filerRuns(w);expect(runs).toHaveLength(2);
  expect(runs[1].resume?.sessionId).toBe(runs[0].sessionId);
  expect(repair!.runId).toMatch(/-repair$/);
  expect(repair!.prompt).toContain("must have required property 'issue'");expect(repair!.prompt).toMatch(/final message/);
  expect(repair!.bounds.max_turns).toBeLessThanOrEqual(5);
  expect(await readAgentState(w.paths,FILER)).toMatchObject({failures:0,last_run:{outcome:'ok'},pending_events:[]});
  expect((await readJsonLines<TriageEntry>(w.paths.findingsTriage)).map(t=>t.outcome)).toEqual(['discard']);
  expect(w.notifications).toHaveLength(0);
 },30000);
 it('a second invalid result is a failure; the next attempt is fresh, with no repair of its own: three runs at most',async()=>{
  const w=await standingWorld({[FILER]:[unknownShape,unknownShape,unknownShape,good]});
  await queue(w);await tick(w);
  expect(filerRuns(w)).toHaveLength(2);expect((await readAgentState(w.paths,FILER))?.failures).toBe(1);
  await tick(w);
  const runs=filerRuns(w);expect(runs).toHaveLength(3);expect(runs[2].resume).toBeUndefined();
  expect(await readAgentState(w.paths,FILER)).toMatchObject({failures:0,last_run:{outcome:'failed'}});
  expect((await readJsonLines<{finding:{what:string}}>(w.paths.findingsQueue)).at(-1)?.finding.what).toBe('standing agent findings-filer failed twice');
  expect(w.notifications).toHaveLength(1);
 },30000);
 it('a run that failed some other way gets no repair turn',async()=>{
  const w=await standingWorld({[FILER]:[undefined,good]});
  await queue(w);await tick(w);
  expect(filerRuns(w)).toHaveLength(1);expect((await readAgentState(w.paths,FILER))?.failures).toBe(1);
 },30000);
 it('a repair turn that is rate limited postpones the agent and counts no failure',async()=>{
  const w=await standingWorld({[FILER]:[unknownShape,RATE_LIMITED]});
  await queue(w);await tick(w);
  const s=(await readAgentState(w.paths,FILER))!;
  expect(filerRuns(w)).toHaveLength(2);expect(s.failures).toBe(0);expect(s.postponed_until).toBeTruthy();expect(s.pending_events.length).toBeGreaterThan(0);
 },30000);
});
describe('eventsWake (spec 025 AC-12 to AC-14)',()=>{
 const H=3600000;
 const state=(over:Partial<AgentState>):AgentState=>({last_run:{at:'2026-10-01T00:00:00.000Z',run_id:'r',outcome:'ok'},next_run:null,paused:false,paused_by:null,pending_events:[{event:'finding_queued',payload:{},at:'x'}],failures:0,...over});
 const wakes=(over:Partial<AgentState>,now='2026-10-01T05:59:00Z',ms=6*H)=>eventsWake(state(over),Date.parse(now),ms);
 it('holds finding_queued within the interval from the last run',()=>{expect(wakes({})).toBe(false);});
 it('wakes once the interval has passed',()=>{expect(wakes({},'2026-10-01T06:00:00Z')).toBe(true);});
 it('wakes when nothing has run yet',()=>{expect(wakes({last_run:null})).toBe(true);});
 it('wakes for nothing with no events',()=>{expect(wakes({pending_events:[]},'2026-10-09T00:00:00Z')).toBe(false);});
 it('an interval of zero turns it off',()=>{expect(wakes({},'2026-10-01T00:00:00Z',0)).toBe(true);});
 it('does not hold the retry after a first failure',()=>{expect(wakes({failures:1})).toBe(true);});
 it.each(['issue_abandoned','capability_answered','merge','maintainer_reply','ci_failure_main','infra_alarm','credential_expiry'])('%s is not held',event=>{
  expect(wakes({pending_events:[{event,payload:{},at:'x'}]})).toBe(true);
  expect(wakes({pending_events:[{event:'finding_queued',payload:{},at:'x'},{event,payload:{},at:'x'}]})).toBe(true);
 });
 it('only finding_queued is debounced',()=>{expect(DEBOUNCED_EVENTS).toEqual(['finding_queued']);});
});
describe('the event debounce through tick (spec 025 AC-12 to AC-15)',()=>{
 // The fixture's hourly operator agent would take the one slot at these times.
 const afterRun=async(w:World)=>{await writeAgentState(w.paths,'operator',{...(await readAgentState(w.paths,'operator'))!,paused:true});await writeAgentState(w.paths,'action-audit',{...(await readAgentState(w.paths,'action-audit'))!,paused:true});await queue(w,'first');await tick(w);expect(filerRuns(w)).toHaveLength(1);await queue(w,'second');};
 const decidedOne={summary:'ok',decisions:[{ref:'1',outcome:'discard',reason:'no'}]};
 const decidedTwo={summary:'ok',decisions:[{ref:'2',outcome:'discard',reason:'no'}]};
 it('holds a finding_queued wake, keeps the event, and runs when the interval passes',async()=>{
  const w=await standingWorld({[FILER]:[decidedOne,decidedTwo]});await afterRun(w);
  w.setNow(new Date('2026-10-01T05:00:00Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(1);
  expect((await readAgentState(w.paths,FILER))?.pending_events).toHaveLength(1);
  w.setNow(new Date('2026-10-01T06:01:00Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(2);expect((await readAgentState(w.paths,FILER))?.pending_events).toEqual([]);
 },30000);
 it('the schedule still fires inside the interval',async()=>{
  const w=await standingWorld({[FILER]:[decidedOne,decidedTwo]});await afterRun(w);
  await writeAgentState(w.paths,FILER,{...(await readAgentState(w.paths,FILER))!,next_run:'2026-10-01T01:00:00.000Z'});
  w.setNow(new Date('2026-10-01T01:00:30Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(2);
 },30000);
 it.each(['issue_abandoned','capability_answered'])('%s starts a run at once',async event=>{
  const w=await standingWorld({[FILER]:[decidedOne,decidedTwo]});await afterRun(w);
  w.setNow(new Date('2026-10-01T00:30:00Z'));
  await emit(w.paths,w.registry,event,{issue:7},w.deps.now());await tick(w);
  expect(filerRuns(w)).toHaveLength(2);expect((await readAgentState(w.paths,FILER))?.pending_events).toEqual([]);
 },30000);
 it('the interval is a parameter, read at each tick',async()=>{
  const w=await standingWorld({[FILER]:[decidedOne,decidedTwo]});await afterRun(w);
  expect((await w.parameters.read('standing.event_debounce')).value).toBe('6h');
  await w.parameters.setParameter('standing.event_debounce','0m','maintainer');
  w.setNow(new Date('2026-10-01T00:01:00Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(2);
 },30000);
 it('a first failure is still retried at the next tick',async()=>{
  const w=await standingWorld({[FILER]:[decidedOne,undefined,decidedTwo]});await afterRun(w);
  w.setNow(new Date('2026-10-01T06:01:00Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(2);expect((await readAgentState(w.paths,FILER))?.failures).toBe(1);
  w.setNow(new Date('2026-10-01T06:02:00Z'));await tick(w);
  expect(filerRuns(w)).toHaveLength(3);
 },30000);
});
