import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {withStateLock} from '../parameters/store.ts';
import type {StatePaths} from '../state/paths.ts';
import type {GitHubClient} from '../github/client.ts';
import type {Finding,IssueData} from '../types.ts';
export interface QueueRecord {ref:string; finding:Finding; repeat?:string; advisory_failed?:boolean; advisory_attempts?:number; [key:string]:unknown}
export interface AbandonedRecord {ref:string;issue:IssueData;comments:unknown[];ledgers:unknown[];retries:number}
/** `issue_classes`: the exact class labels an issue decision may carry, so the model need not guess them (spec 018 AC-1). */
export interface FilerInput {records:QueueRecord[];abandoned:AbandonedRecord[];open_issues:{number:number;title:string}[];cursor:number;issue_classes:string[]}
export interface TriageEntry {ref:string;outcome:string;reason:string;run_id:string;at:string;issue?:number;advisory?:string;failed?:boolean;finding?:Finding;attempt?:number;failure?:AdvisoryFailure;held?:boolean;capability_issue?:number}
/** `permission`: GitHub refused the App (403, the missing capability); `error`: anything else (spec 014 AC-5). */
export type AdvisoryFailure='permission'|'error';
/** Spec 014: a failed advisory is retried this many times in a row (per failure kind), then held. */
export const ADVISORY_ATTEMPTS=3;
/** A held ref is probed at most once per this interval, one ref per batch, while it stays held (spec 014 AC-5). */
export const PROBE_MS=86400000;
export const BATCH=20;
export const CAPABILITY_MARKER='<!-- panelator-capability:security-advisories -->';
export const CAPABILITY_TITLE='The GitHub App cannot create draft security advisories';
/** Carried by the scheduler's closing comment, so a close that failed after commenting does not comment twice. */
export const CAPABILITY_CLOSED_MARKER='<!-- panelator-capability-closed -->';
/** The capability issue is the bot's issue with the fixed title and the marker; model-written text cannot carry the marker (spec 014 AC-6). */
export const isCapabilityIssue=(i:{author:string;title:string;body:string},botLogin:string)=>i.author===botLogin&&i.title===CAPABILITY_TITLE&&i.body.includes(CAPABILITY_MARKER);
export const stripCapabilityMarkers=(text:string)=>text.replace(/<!--\s*panelator-capability[:-]/gi,'<!-- ');
export const isFailedAdvisory=(t:TriageEntry|undefined):t is TriageEntry=>!!t&&t.outcome==='security'&&!!t.failed;
/** Consecutive failed advisory attempts, of any kind. A held ref resumes one short of the bound, so its next failure of any kind holds it again (spec 014 AC-5). */
export function advisoryAttempts(t:TriageEntry|undefined):number {
 if(!isFailedAdvisory(t))return 0;
 return t.held?ADVISORY_ATTEMPTS-1:(t.attempt??1);
}
/** The stored cursor advanced past every consecutive settled queue ref (spec 014 AC-2, AC-4). */
export function settledCursor(cursor:number,triage:TriageEntry[]):number {
 const settled=new Set(triage.map(t=>t.ref));let line=cursor;while(settled.has(String(line+1)))line++;return line;
}
export async function readJsonLines<T>(path:string):Promise<T[]> {
 let text:string;try{text=await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 return text.split('\n').filter(Boolean).map(l=>JSON.parse(l) as T);
}
export interface FilerDeps {paths:StatePaths;gh:GitHubClient;botLogin:string;now:()=>Date;classes:string[];notify:(text:string,key?:string)=>Promise<void>;log?:(entry:Record<string,unknown>)=>void}
export async function buildFilerInput(d:FilerDeps):Promise<FilerInput> {
 let cursor=0;try{cursor=JSON.parse(await readFile(d.paths.findingsCursor,'utf8')).line;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const queue=await withStateLock(d.paths.findingsQueue,()=>readJsonLines<{finding:Finding}>(d.paths.findingsQueue)) as ({finding:Finding}|undefined)[],triage=await readJsonLines<TriageEntry>(d.paths.findingsTriage);
 const last=new Map<string,TriageEntry>();for(const t of triage)last.set(t.ref,t);
 const openBot=await d.gh.listOpenIssuesByAuthor(d.botLogin);
 const failed=[...last.values()].filter(t=>isFailedAdvisory(t)&&queue[Number(t.ref)-1]);
 // Not held: retried every batch. Held under a capability issue that is now closed: all released (the
 // maintainer answered, spec 014 AC-8). Otherwise held: one probe a day, oldest first (spec 014 AC-5).
 const due=failed.filter(t=>!t.held||(t.capability_issue!==undefined&&!openBot.some(i=>i.number===t.capability_issue)));
 const probe=failed.filter(t=>!due.includes(t)&&Date.parse(t.at)<=d.now().getTime()-PROBE_MS).sort((x,y)=>Date.parse(x.at)-Date.parse(y.at))[0];
 const records:QueueRecord[]=[...due,...(probe?[probe]:[])].slice(0,BATCH).map(t=>({...queue[Number(t.ref)-1]!,ref:t.ref,advisory_failed:true,advisory_attempts:advisoryAttempts(t)}));
 // Each ref once: a retry is its queue record, and a settled record is never re-sent (spec 014 AC-1, AC-2).
 cursor=settledCursor(cursor,triage);
 for(let i=cursor;i<queue.length&&records.length<BATCH;i++){const ref=String(i+1);if(!last.has(ref))records.push({...queue[i]!,ref});}
 for(const r of records){const old=triage.find(t=>t.outcome==='discard'&&t.finding?.what===r.finding.what&&t.finding?.where===r.finding.where&&Date.parse(t.at)>d.now().getTime()-30*86400000);if(old)r.repeat=old.reason;}
 const abandoned:AbandonedRecord[]=[];
 for(const issue of await d.gh.listOpenIssuesByLabel('abandoned')) {
  const ref=`issue:${issue.number}`,history=triage.filter(t=>t.ref===ref);
  if(history.some(t=>Date.parse(t.at)>d.now().getTime()-7*86400000))continue;
  const escalation=history.at(-1);
  if(escalation?.outcome==='escalate'&&openBot.some(i=>i.number===escalation.issue&&!i.labels.includes('abandoned')))continue;
  const ledgers=[];for(const f of await readdir(d.paths.escalations))if(f.startsWith(`${issue.number}.abandoned-`))ledgers.push(JSON.parse(await readFile(join(d.paths.escalations,f),'utf8')));
  abandoned.push({ref,issue,comments:await d.gh.listComments(issue.number),ledgers,retries:history.filter(t=>t.outcome==='retry').length});
 }
 return {records,abandoned,open_issues:openBot.map(i=>({number:i.number,title:i.title})),cursor,issue_classes:[...d.classes]};
}
