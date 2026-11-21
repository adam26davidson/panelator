import type {StatePaths} from '../state/paths.ts';
import {readJsonLines} from '../filer/input.ts';
import type {LogEntry} from '../actions/log.ts';
import {checkedPaths,statfsFreeSpace,type FreeSpace} from '../runner/host-space.ts';
import {readDiskSweep} from '../service/sweep.ts';
import {listAgentStates,type StandingEvent} from './state.ts';
import type {AwsContext} from '../aws/context.ts';
import {readCap} from '../aws/context.ts';
import {ensureOn} from '../aws/identity.ts';
import {readCost,readLedger,type AwsCost} from '../aws/book.ts';
export interface InfraAwsInput {on:boolean;off_reason?:string;cap_usd:number;cost:AwsCost|null;reservations:{id:string;what:string;expected_monthly_usd:number;by:string;at:string;scale?:unknown}[]}
/** Spec 068 AC-8: what infra health sees of the AWS account. With no block nothing is called. */
async function awsInput(aws:AwsContext|undefined):Promise<InfraAwsInput> {
 if(!aws?.config)return {on:false,off_reason:'no aws block',cap_usd:aws?await readCap(aws):0,cost:null,reservations:[]};
 if(aws.state.identityAt===null)await ensureOn(aws);
 const on=aws.state.on===true;
 const open=(await readLedger(aws.paths)).reservations.filter(r=>r.released_at===null);
 return {on,...(on||!aws.state.reason?{}:{off_reason:aws.state.reason}),cap_usd:await readCap(aws),cost:await readCost(aws.paths),
  reservations:open.map(r=>({id:r.id,what:r.what,expected_monthly_usd:r.expected_monthly_usd,by:r.by,at:r.at,...(r.scale?{scale:r.scale}:{})}))};
}
const DAY_MS=86400000;
/** Spec 064 AC-5: the service log lines the agent reads. */
const LOG_KINDS=(kind:unknown)=>typeof kind==='string'&&(['tick','stopped','resumed'].includes(kind)||kind.startsWith('disk-sweep'));
export async function buildInfraHealthInput(d:{paths:StatePaths;freeSpace?:(path:string)=>Promise<FreeSpace>;aws?:AwsContext},events:StandingEvent[],since:string|null,now:Date) {
 const read=d.freeSpace??statfsFreeSpace;
 const free_space:{path:string;free_bytes:number|null;free_inodes:number|null;error?:string}[]=[];
 for(const path of checkedPaths(d.paths,null)) {
  try{const f=await read(path);free_space.push({path,free_bytes:f.bytes,free_inodes:f.inodes});}
  catch(e){free_space.push({path,free_bytes:null,free_inodes:null,error:(e as Error).message});}
 }
 const day=now.getTime()-DAY_MS,week=now.getTime()-7*DAY_MS;
 const service_log=(await readJsonLines<{at:string;kind?:unknown}>(d.paths.serviceLog)).filter(r=>Date.parse(r.at)>=day&&LOG_KINDS(r.kind));
 const actions=(await readJsonLines<LogEntry>(d.paths.actionsLog)).filter(r=>Date.parse(r.at)>=week);
 return {since,events,disk_sweep:await readDiskSweep(d.paths),free_space,agents:await listAgentStates(d.paths),service_log,actions,aws:await awsInput(d.aws)};
}
