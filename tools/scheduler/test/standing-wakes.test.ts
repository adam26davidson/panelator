// Spec 025: the repair turn and the debounce on finding_queued wakes, through the real runner and tick.
import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {StageRun} from '../src/adapters/types.ts';
import {readJsonLines,type TriageEntry} from '../src/filer/input.ts';
import {appendFindings} from '../src/state/findings.ts';
import {emit} from '../src/standing/events.ts';
import {eventsWake,runningUnits,DEBOUNCED_EVENTS,readAgentState,writeAgentState,type AgentState} from '../src/standing/state.ts';
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
// A harness like the real one: no write tool, so the JSON arrives only as the final text.
const finalTextOnly=(w:World,wrap:(text:string)=>string=t=>t)=>{
 const texts:string[]=[];
 const adapter={...w.adapter,
  buildCommand(run:StageRun){const c=w.adapter.buildCommand(run);if(String(run.stage)===FILER)texts.push(wrap(c.argv.pop()!));return c;},
  judge(e:unknown[],exit:number|null,t:boolean){const j=w.adapter.judge(e,exit,t);return j.outcome==='ok'&&texts.length?{...j,finalText:texts.at(-1)!}:j;},
 };
 w.deps.adapterFor=()=>adapter;
};
// A resume whose session is gone: the process starts and reports nothing, not even an init event.
const resumeUnavailable=(w:World)=>{
 const empty=join(mkdtempSync(join(tmpdir(),'no-events-')),'empty.jsonl');writeFileSync(empty,'');
 w.deps.adapterFor=()=>({...w.adapter,buildCommand(run:StageRun){const c=w.adapter.buildCommand(run);if(run.resume)c.argv[2]=empty;return c;}});
};
const usage=(w:World)=>readdirSync(w.paths.usage).map(f=>JSON.parse(readFileSync(join(w.paths.usage,f),'utf8')) as {run_id:string;resume_fallback?:string});
describe('a result in the final text, with no result file (spec 025 AC-1, AC-2)',()=>{
 it('is read past prose and a code fence, normalised, applied and kept in result.json',async()=>{
  const w=await standingWorld({[FILER]:[{summary:'x',decisions:[{ref:'1',outcome:'file',title:'Flat',body:'Flat body',class:'class:bug'}]}]});
  finalTextOnly(w,t=>`Here is my result.\n\n\`\`\`json\n${t}\n\`\`\``);
  await queue(w);await tick(w);
  expect(filerRuns(w)).toHaveLength(1);
  expect((await readJsonLines<TriageEntry>(w.paths.findingsTriage))[0]).toMatchObject({ref:'1',outcome:'file'});
  const dir=readdirSync(w.paths.runs).find(d=>d.startsWith('standing-findings-filer'))!;
  expect(JSON.parse(readFileSync(join(w.paths.runs,dir,'result.json'),'utf8')).decisions[0].title).toBe('Flat');
 },30000);
 it('an invalid final text gets the repair turn, whose own final text is the result',async()=>{
  const w=await standingWorld({[FILER]:[unknownShape,good]});finalTextOnly(w);
  await queue(w);await tick(w);
  const runs=filerRuns(w);expect(runs).toHaveLength(2);expect(runs[1].resume?.sessionId).toBe(runs[0].sessionId);
  expect(await readAgentState(w.paths,FILER)).toMatchObject({failures:0,last_run:{outcome:'ok'}});
  expect((await readJsonLines<TriageEntry>(w.paths.findingsTriage)).map(t=>t.outcome)).toEqual(['discard']);
 },30000);
});
describe('a repair turn whose session cannot be resumed (spec 025 AC-6)',()=>{
 it('runs fresh under the turn cap, with the full prompt, and a valid result applies',async()=>{
  let fresh:StageRun|undefined;
  const w=await standingWorld({[FILER]:[unknownShape,unknownShape,(run:StageRun)=>{fresh=run;return good;}]});resumeUnavailable(w);
  await queue(w);await tick(w);
  const runs=filerRuns(w);expect(runs).toHaveLength(3);expect(runs[1].resume).toBeDefined();expect(runs[2].resume).toBeUndefined();
  expect(fresh!.runId).toMatch(/-repair-fresh$/);expect(fresh!.bounds.max_turns).toBeLessThanOrEqual(5);
  expect(fresh!.prompt).toContain('You are findings-filer');
  expect(usage(w).find(u=>u.run_id.endsWith('-repair-fresh'))?.resume_fallback).toContain('no init');
  expect(await readAgentState(w.paths,FILER)).toMatchObject({failures:0,last_run:{outcome:'ok'}});
 },30000);
 it('an invalid fresh result counts as the failure',async()=>{
  const w=await standingWorld({[FILER]:[unknownShape,unknownShape,unknownShape]});resumeUnavailable(w);
  await queue(w);await tick(w);
  expect(filerRuns(w)).toHaveLength(3);expect((await readAgentState(w.paths,FILER))?.failures).toBe(1);
 },30000);
});
describe('a restart while a repair turn is running (spec 025 AC-6)',()=>{
 const repair='panelator-stage-standing-findings-filer-1-5-repair';
 const interrupted=async(active:(unit:string)=>boolean)=>{
  const w=await standingWorld({[FILER]:[good]});await queue(w);
  await writeAgentState(w.paths,FILER,{...(await readAgentState(w.paths,FILER))!,running:{run_id:'standing-findings-filer-1-5-repair',started_at:w.deps.now().toISOString()}});
  const asked:string[]=[];w.deps.unitActive=async u=>{asked.push(u);return active(u);};
  await tick(w);return {w,asked};
 };
 it.each([repair,`${repair}-fresh`])('%s still active starts no second run',async unit=>{
  const {w}=await interrupted(u=>u===unit);expect(filerRuns(w)).toHaveLength(0);
 },30000);
 it('neither unit active starts it again',async()=>{
  const {w,asked}=await interrupted(()=>false);expect(filerRuns(w)).toHaveLength(1);
  expect(asked).toEqual(expect.arrayContaining([repair,`${repair}-fresh`]));
 },30000);
 it('an ordinary run is checked under its own id only',()=>{expect(runningUnits('standing-x-1-5')).toEqual(['panelator-stage-standing-x-1-5']);});
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
