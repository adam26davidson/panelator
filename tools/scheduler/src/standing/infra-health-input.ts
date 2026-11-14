import type {StatePaths} from '../state/paths.ts';
import {readJsonLines} from '../filer/input.ts';
import type {LogEntry} from '../actions/log.ts';
import {checkedPaths,statfsFreeSpace,type FreeSpace} from '../runner/host-space.ts';
import {readDiskSweep} from '../service/sweep.ts';
import {listAgentStates,type StandingEvent} from './state.ts';
const DAY_MS=86400000;
/** Spec 064 AC-5: the service log lines the agent reads. */
const LOG_KINDS=(kind:unknown)=>typeof kind==='string'&&(['tick','stopped','resumed'].includes(kind)||kind.startsWith('disk-sweep'));
export async function buildInfraHealthInput(d:{paths:StatePaths;freeSpace?:(path:string)=>Promise<FreeSpace>},events:StandingEvent[],since:string|null,now:Date) {
 const read=d.freeSpace??statfsFreeSpace;
 const free_space:{path:string;free_bytes:number|null;free_inodes:number|null;error?:string}[]=[];
 for(const path of checkedPaths(d.paths,null)) {
  try{const f=await read(path);free_space.push({path,free_bytes:f.bytes,free_inodes:f.inodes});}
  catch(e){free_space.push({path,free_bytes:null,free_inodes:null,error:(e as Error).message});}
 }
 const day=now.getTime()-DAY_MS,week=now.getTime()-7*DAY_MS;
 const service_log=(await readJsonLines<{at:string;kind?:unknown}>(d.paths.serviceLog)).filter(r=>Date.parse(r.at)>=day&&LOG_KINDS(r.kind));
 const actions=(await readJsonLines<LogEntry>(d.paths.actionsLog)).filter(r=>Date.parse(r.at)>=week);
 return {since,events,disk_sweep:await readDiskSweep(d.paths),free_space,agents:await listAgentStates(d.paths),service_log,actions};
}
