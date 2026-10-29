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
import {buildAuditInput} from './audit-input.ts';
import {updateAgentState,type AgentState} from './state.ts';
import {parseDuration} from './registry.ts';
const exec=promisify(execFile);
export interface StandingDeps extends DriverDeps {parameters:ParameterStore;botLogin:string}
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
 const filer:FilerDeps={paths:d.paths,gh:d.gh,botLogin:d.botLogin,now:d.now,classes:[...d.cfg.labels.feature_classes,...d.cfg.labels.debt_classes],notify:(text,key)=>d.notifier.notify({issue:0,gate:'standing',label:`${def.name}:${key??text}`,text})};
 let worktree=d.repoDir,created=false;
 let summary='',outcome='failed',error='standing run failed';
 try {
  await updateAgentState(d.paths,def.name,s=>{const next={...s,running:{run_id:runId,started_at:now.toISOString()}};delete next.postponed_until;return next;});
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
    result=await runStage({...context,adapter:d.adapterFor(retry.harness)},{...req,model:retry.model,harness:retry.harness,runId:runId+'-fallback'});
    logLimit(result);
    if(afterFallback(def as unknown as StageDefinition,result.judgement).kind==='postpone')await postpone('rate limited (429)');
   } else if(retry.kind==='postpone')await postpone('rate limited (429)');
  }
  if(result.outcome!=='ok'||!result.result)throw new Error(result.reason??result.resultErrors.join('; '));
  const body=result.result as {summary:string;actions?:{kind:string;args:Record<string,unknown>;why:string}[];findings?:unknown[]};
  if(def.output==='filer-result')await applyFilerResult(filer,runId,input as Awaited<ReturnType<typeof buildFilerInput>>,body as FilerResult);
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},body.findings??[]);
  const ctx={paths:d.paths,parameters:d.parameters,log:new ActionLog(d.paths.actionsLog),levels:loadActionLevels(join(d.agentsDir,'actions.yaml')),gh:d.gh,now:d.now};
  for(const action of body.actions??[])await applyAction(ctx,{...action,agent:def.name,run_id:runId},def.actions);
  summary=body.summary;outcome='ok';
  await writeFile(join(d.paths.runs,result.runId,'summary.json'),JSON.stringify({summary}));
 }catch(e){error=(e as Error).message;d.log({kind:postponedUntil===null?'standing-error':'standing-postponed',agent:def.name,error});}
 finally{
  if(created)await removeWorktree(d.repoDir,worktree).catch(e=>d.log({kind:'error',error:String(e)}));
  await updateAgentState(d.paths,def.name,s=>{const next={...s};delete next.running;return next;});
 }
 // Spec 013 AC-7: a quota postponement is not a failure: the count, pending events and schedule stay as they are.
 if(postponedUntil!==null){const until=postponedUntil;await updateAgentState(d.paths,def.name,s=>({...s,postponed_until:until,summary:error}));return;}
 if(outcome!=='ok'&&state.failures===0){await updateAgentState(d.paths,def.name,current=>({...current,failures:1}));return;}
 const at=d.now().toISOString();
 const next=def.trigger.schedule?new Date(d.now().getTime()+parseDuration(String((await d.parameters.read(`schedule.${def.name}`)).value))).toISOString():null;
 await updateAgentState(d.paths,def.name,current=>({...current,last_run:{at,run_id:runId,outcome},summary:summary||error,next_run:next,failures:0,pending_events:current.pending_events.filter(e=>!received.some(r=>JSON.stringify(r)===JSON.stringify(e)))}));
 if(outcome!=='ok') {
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:at},[{what:`standing agent ${def.name} failed twice`,where:`agents/standing/${def.name}.md`,evidence:error,noticed_how:'standing run retry exhausted'}]);
  await filer.notify(`Standing agent ${def.name} failed twice: ${error}`);
 }
}
