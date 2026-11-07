import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import type {DriverDeps} from '../chain/driver.ts';
import type {StandingDefinition,StageDefinition} from '../types.ts';
import type {ParameterStore} from '../parameters/store.ts';
import {validate,type SchemaName} from '../schema/validate.ts';
import {runStage,type StageOutcome} from '../runner/run.ts';
import {retryDecision,afterFallback} from '../runner/retry.ts';
import {modelLimitFallback,planLaunch,quotaParams,readBook,waitAfterLimit} from '../quota/book.ts';
import {removeWorktree} from '../runner/worktree.ts';
import {resolveProfile} from '../profiles/resolve.ts';
import type {StageInput} from '../stages/prompt.ts';
import {ActionLog} from '../actions/log.ts';
import {applyAction,loadActionLevels} from '../actions/index.ts';
import {appendFindings} from '../state/findings.ts';
import {buildFilerInput,type FilerDeps} from '../filer/input.ts';
import {applyFilerResult,type FilerResult} from '../filer/apply.ts';
import {transientCause,transientRun,outageBackoffS,OUTAGE_ALARM_MS,OUTAGE_CEILING_MS,CEILING_MIN_FAILURES,CEILING_MIN_SPAN_MS,PAST_CEILING} from '../chain/transient.ts';
import {HISTORY_ENTRY_MAX} from '../chain/machine.ts';
import {buildAuditInput} from './audit-input.ts';
import {updateAgentState,type AgentState} from './state.ts';
import {parseDuration} from './registry.ts';
import {record} from '../events/store.ts';
const exec=promisify(execFile);
export interface StandingDeps extends DriverDeps {parameters:ParameterStore;botLogin:string}
/** A repair turn only rewrites JSON it already has; the cap also keeps a session-lost fresh run from a full investigation. */
const REPAIR_MAX_TURNS=5,REPAIR_MAX_ERRORS=40;
const repairPrompt=(errors:string[])=>`Your result failed validation:\n${errors.slice(0,REPAIR_MAX_ERRORS).map(e=>`- ${e}`).join('\n')}${errors.length>REPAIR_MAX_ERRORS?`\n- and ${errors.length-REPAIR_MAX_ERRORS} more`:''}\n\nDo not investigate further and call no tools. Return the complete corrected result JSON as your final message, every decision included, changing only what these errors name. Keep your decisions as they are.`;
export async function runStandingAgent(d:StandingDeps,def:StandingDefinition,state:AgentState):Promise<void> {
 const received=state.pending_events;
 const now=d.now(),attempt=state.failures+1,runId=`standing-${def.name}-${attempt}-${now.getTime()}`;
 // Spec 013 AC-7 to AC-9: the quota book decides whether the agent starts now and on which model; a wait starts no run.
 const quota=await quotaParams(d.parameters),what=`agent:${def.name}`;
 const launch=await planLaunch(d.paths,{what,stage:def.name,tier:def.tier,harness:def.harness,model:def.model,fallback:def.fallback,independent:def.independent},quota,now);
 if(launch.kind==='wait') {
  d.log({kind:launch.defer?'quota-defer':'quota-wait',agent:def.name,model:def.model,key:launch.key,until:launch.until,reason:launch.reason,...launch.defer});
  await updateAgentState(d.paths,def.name,s=>({...s,postponed_until:launch.until,summary:`waiting on quota: ${launch.reason}`}));
  return;
 }
 const moved=launch.model!==def.model?{model:launch.model,harness:launch.harness}:null;
 if(moved)d.log({kind:'quota-fallback',agent:def.name,from:def.model,to:moved.model,key:launch.note?.key});
 let postponedUntil:string|null=null;
 const postpone=async(reason:string)=>{postponedUntil=await waitAfterLimit(d.paths,def.harness,def.model,d.now());throw new Error(`${reason}; postponed until ${postponedUntil}`);};
 const filer:FilerDeps={paths:d.paths,gh:d.gh,botLogin:d.botLogin,now:d.now,classes:[...d.cfg.labels.feature_classes,...d.cfg.labels.debt_classes],notify:(text,key)=>d.notifier.notify({issue:0,gate:'standing',label:`${def.name}:${key??text}`,text}),log:d.log};
 let worktree=d.repoDir,created=false;
 let summary='',outcome='failed',error='standing run failed',actionCount=0,findingCount=0;
 // Spec 045 AC-1: the outage cause label of a transient attempt; `judged` marks an error thrown for the run's own judgement, already classified.
 let transient:string|null=null,judged=false;
 try {
  await updateAgentState(d.paths,def.name,s=>{const next={...s,running:{run_id:moved?runId+'-fallback':runId,started_at:now.toISOString()}};delete next.postponed_until;return next;});
  if(def.worktree==='fresh') {
   worktree=join(d.paths.worktrees,`standing-${def.name}`);
   // A run never inherits the previous run's changes, including after an interrupted run.
   await removeWorktree(d.repoDir,worktree).catch(()=>{});
   await mkdir(d.paths.worktrees,{recursive:true});
   await exec('git',['worktree','add','--detach',worktree,'origin/main'],{cwd:d.repoDir});created=true;
  }
  const input=def.output==='filer-result'?await buildFilerInput(filer):def.input==='audit-input'?await buildAuditInput(d.paths,state.last_run?.at??null,now):null;
  const parameters=await d.parameters.all();
  const inputCheck=validate(def.input as SchemaName,input??{events:received,since:state.last_run?.at??null,parameters});
  if(!inputCheck.ok)throw new Error(`standing input: ${inputCheck.errors.join('; ')}`);
  const profile=def.profile==='none'?null:resolveProfile(d.agentsDir,def.profile);
  // Standing agents have no write or GitHub tool, even when a profile normally supplies one.
  const safeProfile=profile?{...profile,tools:['Read','Glob','Grep'],credentialHook:undefined}:null;
  const req={def,input:{} as StageInput,standingInput:{agent:def.name,events:input?{events:received,input}:received,since:state.last_run?.at??null,parameters},issue:0,attempt,worktree,profile:safeProfile,runId};
  const context={paths:d.paths,adapter:d.adapterFor(def.harness),systemdScope:d.systemdScope,systemdRunBin:d.systemdRunBin,now:d.now,binDir:d.binDir,sessionWindowMs:quota.sessionWindowMs};
  const logLimit=(r:StageOutcome)=>{if(r.limit)d.log({kind:'quota-limit',agent:def.name,run_id:r.runId,key:r.limit.key,scope:r.limit.scope,resets_at:r.limit.resets_at,source:r.limit.source});};
  let ran={harness:moved?.harness??def.harness,model:moved?.model??def.model};
  let result=moved?await runStage({...context,adapter:d.adapterFor(moved.harness)},{...req,model:moved.model,harness:moved.harness,runId:runId+'-fallback'}):await runStage(context,req);
  logLimit(result);
  if(moved) {
   if(afterFallback(def as unknown as StageDefinition,result.judgement).kind==='postpone')await postpone('rate limited (429)');
  } else {
   const toModel=modelLimitFallback(await readBook(d.paths),{tier:def.tier,harness:def.harness,model:def.model},quota,d.now());
   const retry=retryDecision(def as unknown as StageDefinition,result.judgement,result.usage.cost_usd??0,d.cfg.retry_cost_limit_usd,toModel);
   if(retry.kind==='fallback') {
    if(retry.model===toModel)d.log({kind:'quota-fallback',agent:def.name,from:def.model,to:toModel,key:result.limit?.key});
    await updateAgentState(d.paths,def.name,s=>({...s,running:{run_id:runId+'-fallback',started_at:d.now().toISOString()}}));
    ran={harness:retry.harness,model:retry.model};
    result=await runStage({...context,adapter:d.adapterFor(retry.harness)},{...req,model:retry.model,harness:retry.harness,runId:runId+'-fallback'});
    logLimit(result);
    if(afterFallback(def as unknown as StageDefinition,result.judgement).kind==='postpone')await postpone('rate limited (429)');
   } else if(retry.kind==='postpone')await postpone('rate limited (429)');
  }
  // Spec 025 AC-3 to AC-5: one repair turn in the session that did the work, on the first attempt only, so a wake
  // costs at most three runs: the attempt, its repair, and the one fresh retry of spec 008 AC-3.
  if(attempt===1&&result.judgement.reason==='result: invalid') {
   const repairId=runId+'-repair';
   d.log({kind:'standing-repair',agent:def.name,run_id:result.runId,errors:result.resultErrors.length});
   await updateAgentState(d.paths,def.name,s=>({...s,running:{run_id:repairId,started_at:d.now().toISOString()}}));
   result=await runStage({...context,adapter:d.adapterFor(ran.harness)},{...req,...ran,def:{...def,bounds:{...def.bounds,max_turns:Math.min(def.bounds.max_turns,REPAIR_MAX_TURNS)}},resume:{sessionId:result.sessionId,...ran},replyPrompt:repairPrompt(result.resultErrors),runId:repairId});
   logLimit(result);
  }
  // Spec 013 AC-7: a run still rate limited is postponed whatever the tier, never counted as a failure.
  if(result.judgement.outcome==='failed'&&result.judgement.apiErrorStatus===429)await postpone('rate limited (429)');
  if(result.judgement.outcome==='failed')transient=transientRun(result.judgement);
  if(result.outcome!=='ok'||!result.result){judged=true;throw new Error(result.reason??result.resultErrors.join('; '));}
  const body=result.result as {summary:string;actions?:{kind:string;args:Record<string,unknown>;why:string}[];findings?:unknown[]};
  if(def.output==='filer-result')await applyFilerResult(filer,runId,input as Awaited<ReturnType<typeof buildFilerInput>>,body as FilerResult);
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},body.findings??[]);
  const ctx={paths:d.paths,parameters:d.parameters,log:new ActionLog(d.paths.actionsLog,d.paths),levels:loadActionLevels(join(d.agentsDir,'actions.yaml')),gh:d.gh,now:d.now};
  for(const action of body.actions??[])await applyAction(ctx,{...action,agent:def.name,run_id:runId},def.actions);
  actionCount=body.actions?.length??0;findingCount=body.findings?.length??0;
  summary=body.summary;outcome='ok';
  await writeFile(join(d.paths.runs,result.runId,'summary.json'),JSON.stringify({summary}));
 }catch(e){
  error=(e as Error).message;
  // Spec 045 AC-1: an error thrown around the run is transient when it names the network; a judged failure never reaches the classifier again.
  if(postponedUntil===null&&transient===null&&!judged)transient=transientCause(e);
  if(postponedUntil!==null)d.log({kind:'standing-postponed',agent:def.name,error});
  else if(transient===null)d.log({kind:'standing-error',agent:def.name,error});
 }
 finally{
  if(created)await removeWorktree(d.repoDir,worktree).catch(e=>d.log({kind:'error',error:String(e)}));
  await updateAgentState(d.paths,def.name,s=>{const next={...s};delete next.running;return next;});
 }
 // Spec 026 AC-2: every attempt that ran is recorded, the first failed one before the scheduler waits for the retry.
 await record(d.paths,'agent.run',d.now(),{outcome,summary:summary||error,events_received:received.length,actions:actionCount,findings:findingCount,attempt,...(outcome==='failed'?{error}:{})},{agent:def.name,run_id:runId});
 // Spec 013 AC-7: a quota postponement is not a failure: the count, pending events and schedule stay as they are.
 if(postponedUntil!==null){const until=postponedUntil;await updateAgentState(d.paths,def.name,s=>({...s,postponed_until:until,summary:error}));return;}
 // Spec 045 AC-2 to AC-6: a transient failure postpones the agent with backoff and counts nothing until the outage passes its ceiling.
 let keepOutage=false;
 if(transient!==null) {
  const cause=transient,at=d.now(),nowMs=at.getTime(),prev=state.outage;
  const count=(prev?.count??0)+1,since=prev?.since??at.toISOString(),last=error.slice(0,HISTORY_ENTRY_MAX);
  const until=new Date(nowMs+outageBackoffS(count)*1000).toISOString(),age=nowMs-Date.parse(since);
  if(!prev)d.log({kind:'standing-outage',agent:def.name,cause,error});
  d.log({kind:'standing-postponed',agent:def.name,error:`${error}; postponed until ${until}`});
  // AC-5: one alarm per agent per outage, once it is two hours old.
  const alarm=!prev?.alarmed&&age>=OUTAGE_ALARM_MS;
  const outage:NonNullable<AgentState['outage']>={since,count,last,alarmed:Boolean(prev?.alarmed)||alarm};
  if(alarm) {
   d.log({kind:'standing-outage-alarm',agent:def.name,since,failures:count,cause});
   await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:at.toISOString()},[{what:`network outage blocks standing agent ${def.name}`,where:`agents/standing/${def.name}.md`,evidence:`${count} transient failures since ${since} (${cause}); last: ${last}`,noticed_how:'standing run transient error'}],{exclude:def.name});
   await d.notifier.notify({issue:0,gate:'infra',label:`${def.name}:outage`,text:`Standing agent ${def.name} has failed on a transient network error ${count} times since ${since} (${cause}); it keeps retrying. Last error: ${last}`});
   await d.emitEvent?.('infra_alarm',{kind:'network_outage',agent:def.name,since,failures:count,cause});
  }
  // AC-6: past the ceiling a failure counts as genuine only once enough of them span enough time.
  if(age>=OUTAGE_CEILING_MS) {
   const past={since:prev?.past_ceiling?.since??at.toISOString(),failures:(prev?.past_ceiling?.failures??0)+1};
   outage.past_ceiling=past;
   const counts=Boolean(prev?.ceiling)||(past.failures>=CEILING_MIN_FAILURES&&nowMs-Date.parse(past.since)>=CEILING_MIN_SPAN_MS);
   if(counts) {
    outage.ceiling=true;
    if(!prev?.ceiling)d.log({kind:'standing-outage-ceiling',agent:def.name,since,failures:count,cause});
    error=PAST_CEILING+error;keepOutage=true;
   }
  }
  await updateAgentState(d.paths,def.name,s=>({...s,postponed_until:until,summary:error,outage}));
  if(!keepOutage)return;
 }
 // Spec 045 AC-4: the next real outcome ends the outage.
 const over=keepOutage?undefined:state.outage;
 if(over)d.log({kind:'standing-outage-over',agent:def.name,since:over.since,failures:over.count});
 if(outcome!=='ok'&&state.failures===0){await updateAgentState(d.paths,def.name,current=>{const n={...current,failures:1};if(over)delete n.outage;return n;});return;}
 const at=d.now().toISOString();
 const next=def.trigger.schedule?new Date(d.now().getTime()+parseDuration(String((await d.parameters.read(`schedule.${def.name}`)).value))).toISOString():null;
 await updateAgentState(d.paths,def.name,current=>{const n={...current,last_run:{at,run_id:runId,outcome},summary:summary||error,next_run:next,failures:0,pending_events:current.pending_events.filter(e=>!received.some(r=>JSON.stringify(r)===JSON.stringify(e)))};if(over)delete n.outage;return n;});
 if(outcome!=='ok') {
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:at},[{what:`standing agent ${def.name} failed twice`,where:`agents/standing/${def.name}.md`,evidence:error,noticed_how:'standing run retry exhausted'}],{exclude:def.name});
  await filer.notify(`Standing agent ${def.name} failed twice: ${error}`);
 }
}
