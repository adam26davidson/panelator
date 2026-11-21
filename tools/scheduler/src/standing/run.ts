import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {SCOPE_FIX} from '../contacts/scope.ts';
import {buildCredentialCheckInput} from './credential-check-input.ts';
import {readJsonFile,writeJsonAtomic} from '../credentials/check.ts';
import {validateSchema} from '../credentials/catalogue.ts';
import {entriesFor,type DriverDeps} from '../chain/driver.ts';
import type {StandingDefinition,StageDefinition} from '../types.ts';
import type {ParameterStore} from '../parameters/store.ts';
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
import {transientCause,transientRun,outageBackoffS,OUTAGE_ALARM_MS,OUTAGE_CEILING_MS,outageAgeMs,CEILING_MIN_FAILURES,CEILING_MIN_SPAN_MS,PAST_CEILING,failureCause} from '../chain/transient.ts';
import {checkHostSpace} from '../runner/host-space.ts';
import {HISTORY_ENTRY_MAX} from '../chain/machine.ts';
import {buildAuditInput} from './audit-input.ts';
import {buildInfraHealthInput} from './infra-health-input.ts';
import {updateAgentState,type AgentState} from './state.ts';
import {parseDuration} from './registry.ts';
import {record} from '../events/store.ts';
import {openIndex} from '../events/index.ts';
import {buildReflectionInput,periodStart} from '../reflection/input.ts';
import {applyReflectionResult,type ReflectionResult} from '../reflection/apply.ts';
import type {MetricDefinition} from '../metrics/definitions.ts';
const exec=promisify(execFile);
export interface StandingDeps extends DriverDeps {parameters:ParameterStore;botLogin:string;metrics?:Record<string,MetricDefinition>;registry?:Record<string,StandingDefinition>}
/** The end of the agent's latest successful run: its state record, else its latest `ok` agent.run event (a failed pair of attempts leaves `last_run` failed). */
function lastSuccess(d:StandingDeps,def:StandingDefinition,state:AgentState):string|null {
 if(state.last_run?.outcome==='ok')return state.last_run.at;
 const db=openIndex(d.paths,{readOnly:true});
 try{return (db.prepare("SELECT max(at) AS at FROM events WHERE kind = 'agent.run' AND agent = ? AND json_extract(payload, '$.outcome') = 'ok'").get(def.name) as {at:string|null}).at;}finally{db.close();}
}
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
 const filer:FilerDeps={paths:d.paths,gh:d.gh,botLogin:d.botLogin,now:d.now,classes:[...d.cfg.labels.feature_classes,...d.cfg.labels.debt_classes],stopsPipelineLabel:d.cfg.labels.stops_pipeline,notify:(text,key)=>d.notifier.notify({issue:0,gate:'standing',label:`${def.name}:${key??text}`,text}).then(()=>{}),log:d.log};
 // Spec 028 AC-6: a reflection's period start and plan key are fixed before its first attempt and reused by every later one.
 const reflective=def.output==='reflection-result';
 let reflection=state.reflection;
 if(reflective&&!reflection) {
  const from=periodStart(lastSuccess(d,def,state),now);
  reflection={period_from:from.toISOString(),plan_key:`${def.name}-${from.getTime()}`};
  const fixed=reflection;
  await updateAgentState(d.paths,def.name,s=>({...s,reflection:fixed}));
 }
 let worktree=d.repoDir,created=false;
 let summary='',outcome='failed',error='standing run failed',actionCount=0,findingCount=0;
 // Spec 045 AC-1: the outage cause label of a transient attempt; `judged` marks an error thrown for the run's own judgement, already classified.
 let transient:string|null=null,judged=false;
 try {
  await updateAgentState(d.paths,def.name,s=>{const next={...s,running:{run_id:moved?runId+'-fallback':runId,started_at:now.toISOString()}};delete next.postponed_until;return next;});
  // Spec 059 AC-3: no run is launched into a full volume; the error is classified below like any thrown around the run.
  if(def.worktree!=='fresh')await checkHostSpace(d.paths,null,{freeSpace:d.freeSpace,log:d.log});
  if(def.worktree==='fresh') {
   worktree=join(d.paths.worktrees,`standing-${def.name}`);
   // A run never inherits the previous run's changes, including after an interrupted run.
   await removeWorktree(d.repoDir,worktree).catch(()=>{});
   await mkdir(d.paths.worktrees,{recursive:true});
   // The agent's own worktree does not exist yet: its parent is on the same volume.
   await checkHostSpace(d.paths,d.paths.worktrees,{freeSpace:d.freeSpace,log:d.log});
   await exec('git',['worktree','add','--detach',worktree,'origin/main'],{cwd:d.repoDir});created=true;
  }
  const reflectionInput=reflective?await buildReflectionInput({paths:d.paths,gh:d.gh,botLogin:d.botLogin,parameters:d.parameters,metrics:d.metrics??{},agentsDir:d.agentsDir,reflectionAgents:Object.values(d.registry??{[def.name]:def}).filter(x=>x.output==='reflection-result').map(x=>x.name),now:d.now},def,runId,new Date(reflection!.period_from),worktree):null;
  const input=reflectionInput??(def.output==='filer-result'?await buildFilerInput(filer):def.input==='audit-input'?await buildAuditInput(d.paths,state.last_run?.at??null,now):def.input==='credential-check-input'&&d.checkContext&&d.catalogue?await buildCredentialCheckInput({paths:d.paths,catalogue:d.catalogue,probe:d.checkContext,warnDays:d.cfg.credentials.warn_days,scope:d.scope??(async()=>({status:'failed' as const,reason:'no scope check wired'})),now},received,state.last_run?.at??null):def.input==='infra-health-input'?await buildInfraHealthInput({paths:d.paths,freeSpace:d.freeSpace},received,state.last_run?.at??null,now):null);
  if(def.input==='credential-check-input'&&(input as {scope?:{status:string;reason?:string}}|null)?.scope?.status==='failed')await d.notifier.notify({issue:0,gate:'infra',label:'contact-scope',text:`${(input as {scope:{reason:string}}).scope.reason}; ${SCOPE_FIX}`}).catch(()=>{});
  const parameters=await d.parameters.all();
  const inputCheck=validateSchema(def.input,input??{events:received,since:state.last_run?.at??null,parameters});
  if(!inputCheck.ok)throw new Error(`standing input: ${inputCheck.errors.join('; ')}`);
  const profile=def.profile==='none'?null:resolveProfile(d.agentsDir,def.profile);
  // Standing agents have no write or GitHub tool, even when a profile normally supplies one.
  const safeProfile=profile?{...profile,tools:['Read','Glob','Grep'],credentials:[]}:null;
  const req={def,input:{} as StageInput,standingInput:{agent:def.name,events:input?{events:received,input}:received,since:state.last_run?.at??null,parameters},issue:0,attempt,worktree,profile:safeProfile,runId,credentials:entriesFor(d.catalogue,def.credentials)};
  const context={paths:d.paths,adapter:d.adapterFor(def.harness),systemdScope:d.systemdScope,systemdRunBin:d.systemdRunBin,now:d.now,binDir:d.binDir,configPath:d.configPath,sessionWindowMs:quota.sessionWindowMs};
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
  const renewFailures:{name:string;reason:string}[]=[];
  const applyDirect=async()=>{
   await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},body.findings??[]);
   const lines:string[]=[];
   for(const action of body.actions??[]){
    const row=await applyAction(ctx,{...action,agent:def.name,run_id:runId},def.actions);
    // Level-2 requests are already queued by applyAction; other reflection policy refusals also need a reviewed follow-up (028 AC-8).
    if(reflective&&row.status==='refused'&&row.reason==='action not allowed')await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:d.now().toISOString()},[{what:`reflection action refused: ${action.kind}`,where:`agents/standing/${def.name}.md`,evidence:`${row.reason}: ${action.why}`,noticed_how:'reflection action policy enforcement'}]);
    lines.push(`${action.kind} ${JSON.stringify(action.args)}: ${row.status}${row.reason?` (${row.reason})`:''}`);
   }
   for(const f of renewFailures)await notifyCredential(f.name,null,d.catalogue?.[f.name]?.setup??[],`renewal failed: ${f.reason}`);
   for(const w of (body as {warnings?:{name:string;expires_at:string|null;steps:string[]}[]}).warnings??[])await notifyCredential(w.name,w.expires_at,d.catalogue?.[w.name]?.setup??w.steps,'needs renewal by hand');
   return lines;
  };
  // Spec 099 AC-12, AC-13: one `credential-expiry` notification per credential per day (tracked in expiry-state.json under `notified`).
  const notifyCredential=async(name:string,expires_at:string|null,steps:string[],why:string)=>{
   const raw=await readJsonFile<Record<string,unknown>>(d.paths.credentialsExpiryState,{});
   const notified=(raw.notified&&typeof raw.notified==='object'?raw.notified:{}) as Record<string,string>;
   const last=notified[name]?Date.parse(notified[name]!):NaN;
   if(!Number.isNaN(last)&&d.now().getTime()-last<86400000)return;
   await d.notifier.notify({issue:0,gate:'credential-expiry',label:name,text:`${name}: ${why}${expires_at?` (expires ${expires_at})`:''}\n${steps.map((x,i)=>`${i+1}. ${x}`).join('\n')}`});
   await writeJsonAtomic(d.paths.credentialsExpiryState,{...raw,notified:{...notified,[name]:d.now().toISOString()}});
  };
  const ctx={paths:d.paths,parameters:d.parameters,log:new ActionLog(d.paths.actionsLog,d.paths),levels:loadActionLevels(join(d.agentsDir,'actions.yaml')),gh:d.gh,now:d.now,repoDir:d.repoDir,serviceLog:d.log,
   ...(d.catalogue&&d.checkContext?{credentials:{store:d.checkContext.store,catalogue:d.catalogue,probe:d.checkContext,configPaths:{'github-app-key':d.cfg.app.private_key_path,'telegram-bot':d.cfg.telegram?.credentials_path??''},
    shim:{configPath:d.configPath??'',binDir:d.binDir,cataloguePath:d.cataloguePath,runDir:join(d.paths.runs,result.runId,'renew')},
    onRenewFailure:(name:string,reason:string)=>{renewFailures.push({name,reason});}}}:{})};
  if(reflective)await applyReflectionResult({paths:d.paths,gh:d.gh,botLogin:d.botLogin,classes:filer.classes,maxIssues:d.cfg.reflection_max_issues,now:d.now,log:d.log,applyDirect},{def,result:body as unknown as ReflectionResult,planKey:reflection!.plan_key,runId,input:reflectionInput as never});
  else await applyDirect();
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
  // Spec 100 AC-2: when the host cannot work the scheduler pauses; the agent keeps its failures, events and schedule and nothing is recorded on it.
  if(d.host&&await d.host.onTransient(cause,error)){d.log({kind:'standing-host-paused',agent:def.name,cause,error});return;}
  const count=(prev?.count??0)+1,since=prev?.since??at.toISOString(),last=error.slice(0,HISTORY_ENTRY_MAX);
  const until=new Date(nowMs+outageBackoffS(count)*1000).toISOString(),age=outageAgeMs(since,nowMs,d.host?.downtimeMs(since,nowMs)??0);
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
 await updateAgentState(d.paths,def.name,current=>{const n={...current,last_run:{at,run_id:runId,outcome},summary:summary||error,next_run:next,failures:0,pending_events:current.pending_events.filter(e=>!received.some(r=>JSON.stringify(r)===JSON.stringify(e)))};if(over)delete n.outage;if(outcome==='ok')delete n.reflection;return n;});
 // Spec 102 AC-6: a successful run clears the agent's standing and outage notices, so the next failure notifies at once.
 if(outcome==='ok'){
  const clearFailed=(e:unknown)=>d.log({kind:'error',error:`notify clear: ${(e as Error).message}`});
  await d.notifier.clear?.({issue:0,gate:'standing',labelPrefix:`${def.name}:`}).catch(clearFailed);
  await d.notifier.clear?.({issue:0,gate:'infra',label:`${def.name}:outage`}).catch(clearFailed);
 }
 if(outcome!=='ok') {
  await appendFindings(d.paths,{issue:0,stage:def.name,run_id:runId,timestamp:at},[{what:`standing agent ${def.name} failed twice: ${failureCause(error,transient)}`,where:`agents/standing/${def.name}.md`,evidence:error,noticed_how:'standing run retry exhausted'}],{exclude:def.name});
  await filer.notify(`Standing agent ${def.name} failed twice: ${error}`,`failed:${failureCause(error,transient)}`);
 }
}
