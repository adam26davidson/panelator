import {readFile,writeFile,rename,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {StatePaths} from '../state/paths.ts';
import type {StandingDefinition} from '../types.ts';
import {withStateLock,type ParameterStore} from '../parameters/store.ts';
import {parseDuration} from './registry.ts';
export interface StandingEvent {event:string; payload:unknown; at:string}
export interface AgentState {
 last_run:{at:string;run_id:string;outcome:string}|null; next_run:string|null;
 pending_events:StandingEvent[]; paused:boolean; paused_by:string|null; failures:number;
 summary?:string; removed_at?:string;
 running?:{run_id:string;started_at:string};
 last_success?:{at:string;run_id:string}|null;
 /** A reflection's period start and plan key, fixed before its first attempt so a retry reuses them. */
 reflection?:{period_from:string;plan_key:string};
}
export async function updateAgentState(paths:StatePaths,name:string,fn:(state:AgentState)=>AgentState):Promise<void> {
 if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('invalid agent name');
 await withStateLock(join(paths.agents,`${name}.json`),async()=>{
  const s=await readAgentState(paths,name);if(!s)throw new Error(`unknown agent ${name}`);
  await writeUnlocked(paths,name,fn(s));
 });
}
export async function readAgentState(paths:StatePaths,name:string):Promise<AgentState|null> {
 if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('invalid agent name');
 try{return JSON.parse(await readFile(join(paths.agents,`${name}.json`),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export async function writeAgentState(paths:StatePaths,name:string,state:AgentState):Promise<void> {
 if(!/^[a-z][a-z0-9-]*$/.test(name))throw new Error('invalid agent name');
 await withStateLock(join(paths.agents,`${name}.json`),()=>writeUnlocked(paths,name,state));
}
async function writeUnlocked(paths:StatePaths,name:string,state:AgentState):Promise<void> {
 const p=join(paths.agents,`${name}.json`);await writeFile(p+'.tmp',JSON.stringify(state,null,2));await rename(p+'.tmp',p);
}
export async function listAgentStates(paths:StatePaths):Promise<Record<string,AgentState>> {
 const out:Record<string,AgentState>={}; for(const f of await readdir(paths.agents)) if(f.endsWith('.json'))out[f.slice(0,-5)]=(await readAgentState(paths,f.slice(0,-5)))!; return out;
}
export async function initializeAgents(paths:StatePaths,registry:Record<string,StandingDefinition>,parameters:ParameterStore,now:Date):Promise<void> {
 await parameters.initialize();
 for(const def of Object.values(registry)) {
  const prev=await readAgentState(paths,def.name);
  if(prev) {if(prev.removed_at){delete prev.removed_at;await writeAgentState(paths,def.name,prev);} continue;}
  const next=def.trigger.schedule?new Date(now.getTime()+parseDuration(String((await parameters.read(`schedule.${def.name}`)).value))).toISOString():null;
  await writeAgentState(paths,def.name,{last_run:null,next_run:next,pending_events:[],paused:false,paused_by:null,failures:0});
 }
 await pruneRemovedAgents(paths,registry,parameters,now);
}
export async function pruneRemovedAgents(paths:StatePaths,registry:Record<string,StandingDefinition>,parameters:ParameterStore,now:Date):Promise<void> {
 for(const [name,state] of Object.entries(await listAgentStates(paths)))if(!registry[name]) {
  if(!state.removed_at)await writeAgentState(paths,name,{...state,removed_at:now.toISOString()});
  else if(now.getTime()-Date.parse(state.removed_at)>30*86400000){await unlink(join(paths.agents,`${name}.json`)); await parameters.prune(`schedule.${name}`);}
 }
}
