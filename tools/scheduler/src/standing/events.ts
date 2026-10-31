import {readFile,writeFile,rename} from 'node:fs/promises';
import type {StatePaths} from '../state/paths.ts';
import type {StandingDefinition} from '../types.ts';
import type {GitHubClient} from '../github/client.ts';
import {updateAgentState} from './state.ts';
export const EVENT_NAMES=['merge','finding_queued','issue_abandoned','maintainer_reply','ci_failure_main','infra_alarm','credential_expiry','capability_answered'] as const;
export async function emit(paths:StatePaths,registry:Record<string,StandingDefinition>,event:string,payload:unknown,now=new Date(),exclude?:string):Promise<void> {
 if(!(EVENT_NAMES as readonly string[]).includes(event))throw new Error(`unknown event ${event}`);
 for(const d of Object.values(registry))if(d.name!==exclude&&d.trigger.events?.includes(event)) {
  await updateAgentState(paths,d.name,s=>s.pending_events.some(e=>e.event===event&&JSON.stringify(e.payload)===JSON.stringify(payload))?s:{...s,pending_events:[...s.pending_events,{event,payload,at:now.toISOString()}]});
 }
}
export async function watchMainChecks(gh:GitHubClient,paths:StatePaths,registry:Record<string,StandingDefinition>,sha:string,required:string[],now=new Date()):Promise<void> {
 let previous:Record<string,string>={};try{previous=JSON.parse(await readFile(paths.mainChecks,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const checks=await gh.checks(sha,required);const next:Record<string,string>={$sha:sha};
 for(const r of checks.runs.filter(r=>!required.length||required.includes(r.name))) {
  const failed=checks.failed.some(f=>f.id===r.id);next[r.name]=failed?'failed':r.status==='completed'?'passing':'pending';
  if(failed&&(previous.$sha!==sha||previous[r.name]!=='failed'))await emit(paths,registry,'ci_failure_main',{check:r.name,run_id:r.id,sha},now);
 }
 await writeFile(paths.mainChecks+'.tmp',JSON.stringify(next));await rename(paths.mainChecks+'.tmp',paths.mainChecks);
}
