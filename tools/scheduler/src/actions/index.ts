import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import type {GitHubClient} from '../github/client.ts';
import {withStateLock,ParameterLockedError,type ParameterStore} from '../parameters/store.ts';
import type {StatePaths} from '../state/paths.ts';
import {appendFindings} from '../state/findings.ts';
import {readAgentState,writeAgentState,updateAgentState,type AgentState} from '../standing/state.ts';
import {ActionLog,type ActionRequest,type LogEntry,type Inverse} from './log.ts';
import {setParameterKind} from './set-parameter.ts';
import {pauseAgentKind} from './pause-agent.ts';
import {resumeAgentKind} from './resume-agent.ts';
import {runAgentKind} from './run-agent.ts';
import {rerunWorkflowKind} from './rerun-workflow.ts';
import {undoKind} from './undo.ts';
export interface ActionContext {
 paths:StatePaths; parameters:ParameterStore; log:ActionLog; levels:Record<string,1|2>; gh:Pick<GitHubClient,'rerunWorkflowRun'|'cancelWorkflowRun'>;
 now:()=>Date; actor?:string; reversing?:boolean;
}
export interface ActionKind {
 changesMode:false;
 check(args:Record<string,unknown>,ctx:ActionContext):Promise<string|null>;
 apply(args:Record<string,unknown>,ctx:ActionContext):Promise<{undo:Inverse|null; undoes?:string}>;
}
export const KINDS:Record<string,ActionKind>={set_parameter:setParameterKind,pause_agent:pauseAgentKind,resume_agent:resumeAgentKind,run_agent:runAgentKind,rerun_workflow:rerunWorkflowKind,undo:undoKind};
export function loadActionLevels(path:string):Record<string,1|2> {
 const file=parse(readFileSync(path,'utf8')) as Record<string,{level:1|2;description:string}>;
 if(!file||typeof file!=='object'||Array.isArray(file))throw new Error(`${path}: expected action map`);
 for(const [name,d] of Object.entries(file))if(!d||![1,2].includes(d.level)||!d.description||Object.keys(d).some(k=>!['level','description'].includes(k)))throw new Error(`${path}: ${name}: invalid action definition`);
 return Object.fromEntries(Object.entries(file).map(([k,v])=>[k,v.level]));
}
export function registryActionsCheck(path:string):string[] {
 const names=Object.keys(loadActionLevels(path));
 for(const name of new Set([...names,...Object.keys(KINDS)]))if(!names.includes(name)||!Object.hasOwn(KINDS,name))throw new Error(`${path}: action ${name} has no matching code/entry`);
 return names;
}
export async function agentState(ctx:ActionContext,args:Record<string,unknown>):Promise<AgentState> {
 if(typeof args.name!=='string')throw new Error('name is required');
 const state=await readAgentState(ctx.paths,args.name); if(!state || state.removed_at)throw new Error(`unknown agent ${args.name}`);return state;
}
export {writeAgentState,updateAgentState};
export function exact(args:Record<string,unknown>,keys:string[]):void {if(Object.keys(args).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(args,k)))throw new Error(`args must contain ${keys.join(', ')}`);}
let tail:Promise<unknown>=Promise.resolve();
/** All effects and log rewrites have one writer, including concurrent standing results. */
export function applyAction(ctx:ActionContext,request:ActionRequest,allowed:string[]|'maintainer'):Promise<LogEntry> {
 const work=tail.then(()=>withStateLock(ctx.log.path+'.operation',()=>applyUnlocked(ctx,request,allowed)));tail=work.catch(()=>{});return work;
}
async function applyUnlocked(ctx:ActionContext,request:ActionRequest,allowed:string[]|'maintainer'):Promise<LogEntry> {
 const actionTime=ctx.now();
 const c={...ctx,now:()=>actionTime,actor:allowed==='maintainer'?'maintainer':request.agent};
 // Actor is assigned by the caller, never read from a result's args.
 let reason:string|null=null; const handler=Object.hasOwn(KINDS,request.kind)?KINDS[request.kind]:undefined;
 if(allowed!=='maintainer' && request.agent==='maintainer')reason='reserved agent identity';
 else if(!handler || !Object.hasOwn(ctx.levels,request.kind))reason='unknown action kind';
 else if(allowed!=='maintainer'&&!allowed.includes(request.kind))reason='action not allowed';
 else if(ctx.levels[request.kind]===2)reason='level 2';
 else if(typeof request.why!=='string'||request.why.length<20)reason='why must have at least 20 characters';
 else if(!request.args||typeof request.args!=='object'||Array.isArray(request.args))reason='args must be an object';
 else try {reason=await handler.check(request.args,c);}catch(e){reason=(e as Error).message;}
 let inverse:Inverse|null=null;
 if(!reason) {
  if(request.kind==='set_parameter')inverse={kind:'set_parameter',args:{name:request.args.name,value:(await ctx.parameters.read(String(request.args.name))).value}};
  if(request.kind==='pause_agent'||request.kind==='resume_agent')inverse={kind:request.kind==='pause_agent'?'resume_agent':'pause_agent',args:{name:request.args.name}};
  if(request.kind==='rerun_workflow')inverse={kind:'rerun_workflow',args:{run_id:request.args.run_id,cancel:true}};
  if(request.kind==='run_agent') {const s=await agentState(c,request.args);inverse={kind:'run_agent',args:{name:request.args.name,previous:s.next_run,marked:actionTime.toISOString(),last_run:s.last_run?.run_id??null}};}
 }
 const pending=await ctx.log.writePending({...request,agent:c.actor!,undo:inverse,...(request.kind==='undo'&&typeof request.args?.action_id==='string'?{undoes:request.args.action_id}:{})},actionTime.toISOString());
 if(reason) {
  const row=await ctx.log.settle(pending.id,'refused',reason);
  if(reason==='level 2')await appendFindings(ctx.paths,{issue:0,stage:request.agent,run_id:request.run_id,timestamp:ctx.now().toISOString()},[{what:`level 2 action requested: ${request.kind}`,where:request.agent,evidence:request.why,noticed_how:'action policy enforcement'}]);
  return row;
 }
 try {
  const result=await handler!.apply(request.args,c);
  const row=await ctx.log.settle(pending.id,'applied',undefined,result.undo);
  if(result.undoes)await ctx.log.markUndone(result.undoes);
  return row;
 }catch(e){return ctx.log.settle(pending.id,e instanceof ParameterLockedError?'refused':'failed',(e as Error).message);}
}
