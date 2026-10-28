import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import type {DriverDeps} from '../chain/driver.ts';
import type {StandingDefinition,StageDefinition} from '../types.ts';
import type {ParameterStore} from '../parameters/store.ts';
import {validate,type SchemaName} from '../schema/validate.ts';
import {runStage} from '../runner/run.ts';
import {retryDecision,afterFallback} from '../runner/retry.ts';
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
import {recordEvent} from '../events/store.ts';
import {buildReflectionInput} from '../reflection/input.ts';
import {applyReflectionResult,type ReflectionResult} from '../reflection/apply.ts';
const exec=promisify(execFile);
export interface StandingDeps extends DriverDeps {parameters:ParameterStore;botLogin:string;registry?:Record<string,StandingDefinition>}
export async function runStandingAgent(d:StandingDeps,def:StandingDefinition,state:AgentState):Promise<void> {
 const received=state.pending_events;
 let nActions=0,nFindings=0;
 const now=d.now(),periodKey=state.period_key??now.getTime(),attempt=state.failures+1,runId=`standing-${def.name}-${attempt}-${now.getTime()}`;
 const filer:FilerDeps={paths:d.paths,gh:d.gh,botLogin:d.botLogin,now:d.now,classes:[...d.cfg.labels.feature_classes,...d.cfg.labels.debt_classes],notify:(text,key)=>d.notifier.notify({issue:0,gate:'standing',label:`${def.name}:${key??text}`,text})};
 let worktree=d.repoDir,created=false;
 let summary='',outcome='failed',error='standing run failed';
 try {
  await updateAgentState(d.paths,def.name,s=>({...s,period_key:periodKey,running:{run_id:runId,started_at:now.toISOString()}}));
  if(def.worktree==='fresh') {
   worktree=join(d.paths.worktrees,`standing-${def.name}`);
   // A run never inherits the previous run's changes, including after an interrupted run.
   await removeWorktree(d.repoDir,worktree).catch(()=>{});
   await mkdir(d.paths.worktrees,{recursive:true});
   await exec('git',['worktree','add','--detach',worktree,'origin/main'],{cwd:d.repoDir});created=true;
  }
  const reflect=def.output==='reflection-result';
  const input=reflect?await buildReflectionInput({paths:d.paths,gh:d.gh,botLogin:d.botLogin,parameters:d.parameters,registry:d.registry??{[def.name]:def},agentsDir:d.agentsDir,repoDir:d.repoDir,now:d.now,log:d.log},def,state):def.output==='filer-result'?await buildFilerInput(filer):def.input==='audit-input'?await buildAuditInput(d.paths,state.last_run?.at??null,now):null;
  const parameters=await d.parameters.all();
  const inputCheck=validate(def.input as SchemaName,input??{events:received,since:state.last_run?.at??null,parameters});
  if(!inputCheck.ok)throw new Error(`standing input: ${inputCheck.errors.join('; ')}`);
  const profile=def.profile==='none'?null:resolveProfile(d.agentsDir,def.profile);
  // Standing agents have no write or GitHub tool, even when a profile normally supplies one.
  const safeProfile=profile?{...profile,tools:['Read','Glob','Grep'],credentialHook:undefined}:null;
  const req={def,input:{} as StageInput,standingInput:{agent:def.name,events:input?{events:received,input}:received,since:state.last_run?.at??null,parameters},issue:0,attempt,worktree,profile:safeProfile,runId};
  const context={paths:d.paths,adapter:d.adapterFor(def.harness),systemdScope:d.systemdScope,systemdRunBin:d.systemdRunBin,now:d.now,binDir:d.binDir};
  let result=await runStage(context,req);
  const retry=retryDecision(def as unknown as StageDefinition,result.judgement,result.usage.cost_usd??0,d.cfg.retry_cost_limit_usd);
  if(retry.kind==='fallback') {
   await updateAgentState(d.paths,def.name,s=>({...s,running:{run_id:runId+'-fallback',started_at:d.now().toISOString()}}));
   result=await runStage({...context,adapter:d.adapterFor(retry.harness)},{...req,model:retry.model,harness:retry.harness,runId:runId+'-fallback'});
   if(afterFallback(def as unknown as StageDefinition,result.judgement).kind==='postpone')throw new Error('rate limited (429); strong tier is not downgraded');
  } else if(retry.kind==='postpone')throw new Error('rate limited (429); strong tier is not downgraded');
  if(result.outcome!=='ok'||!result.result)throw new Error(result.reason??result.resultErrors.join('; '));
  const body=result.result as {summary:string;actions?:{kind:string;args:Record<string,unknown>;why:string}[];findings?:unknown[]};
  const ctx={paths:d.paths,parameters:d.parameters,log:new ActionLog(d.paths.actionsLog,d.paths),levels:loadActionLevels(join(d.agentsDir,'actions.yaml')),gh:d.gh,now:d.now};
  if(reflect) {
   // The plan lists the direct actions applied in this run, so they are applied first (spec 012 AC-16).
   const applied=[];for(const action of body.actions??[])applied.push(await applyAction(ctx,{...action,agent:def.name,run_id:runId},def.actions));
   const ri=input as {period:{from:string};open_questions:{issue:number;asking_stage:string;question:string;sent_at:string}[]};
   const planKey=`standing-${def.name}-${periodKey}`;
   const open=ri.open_questions.map(q=>({issue:q.issue,text:`${q.question||'(question text not recorded)'} (${q.asking_stage}, sent ${q.sent_at})`}));
   await applyReflectionResult({paths:d.paths,gh:d.gh,botLogin:d.botLogin,now:d.now,classes:filer.classes,maxIssues:d.cfg.reflection_max_issues},def,runId,planKey,body as unknown as ReflectionResult,applied,open);
   await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},body.findings??[]);
  } else {
   if(def.output==='filer-result')await applyFilerResult(filer,runId,input as Awaited<ReturnType<typeof buildFilerInput>>,body as FilerResult);
   await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},body.findings??[]);
   for(const action of body.actions??[])await applyAction(ctx,{...action,agent:def.name,run_id:runId},def.actions);
  }
  nActions=body.actions?.length??0;nFindings=body.findings?.length??0;
  summary=body.summary;outcome='ok';
  await writeFile(join(d.paths.runs,result.runId,'summary.json'),JSON.stringify({summary}));
 }catch(e){error=(e as Error).message;d.log({kind:'standing-error',agent:def.name,error});}
 finally{
  if(created)await removeWorktree(d.repoDir,worktree).catch(e=>d.log({kind:'error',error:String(e)}));
  await updateAgentState(d.paths,def.name,s=>{const next={...s};delete next.running;return next;});
 }
 const at=d.now().toISOString();
 await recordEvent(d.paths,{kind:'agent.run',at,agent:def.name,run_id:runId,payload:{outcome,summary:summary||error,events_received:received.length,actions:nActions,findings:nFindings}});
 if(outcome!=='ok'&&state.failures===0){await updateAgentState(d.paths,def.name,current=>({...current,failures:1}));return;}
 const next=def.trigger.schedule?new Date(d.now().getTime()+parseDuration(String((await d.parameters.read(`schedule.${def.name}`)).value))).toISOString():null;
 await updateAgentState(d.paths,def.name,current=>({...current,period_key:undefined,last_run:{at,run_id:runId,outcome},...(outcome==='ok'?{last_success:{at,run_id:runId}}:{}),summary:summary||error,next_run:next,failures:0,pending_events:current.pending_events.filter(e=>!received.some(r=>JSON.stringify(r)===JSON.stringify(e)))}));
 if(outcome!=='ok') {
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:at},[{what:`standing agent ${def.name} failed twice`,where:`agents/standing/${def.name}.md`,evidence:error,noticed_how:'standing run retry exhausted'}]);
  await filer.notify(`Standing agent ${def.name} failed twice: ${error}`);
 }
}
