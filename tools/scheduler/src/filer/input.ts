import {appendFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {withStateLock} from '../parameters/store.ts';
import type {StatePaths} from '../state/paths.ts';
import type {GitHubClient} from '../github/client.ts';
import type {Finding,IssueData} from '../types.ts';
/**
 * `duplicate_refs`: later unsettled records identical to this one; its decision settles them too (spec 019 AC-1, AC-2).
 * `rests_on_pr_closed`: an earlier discard of this ref rested on this PR, which closed unmerged (spec 025 AC-9).
 */
export interface QueueRecord {ref:string; finding:Finding; repeat?:string; advisory_failed?:boolean; advisory_attempts?:number; duplicate_refs?:string[]; rests_on_pr_closed?:number; [key:string]:unknown}
export interface AbandonedRecord {ref:string;issue:IssueData;comments:unknown[];ledgers:unknown[];retries:number}
/** `issue_classes`: the exact class labels an issue decision may carry, so the model need not guess them (spec 018 AC-1). */
export interface FilerInput {records:QueueRecord[];abandoned:AbandonedRecord[];open_issues:{number:number;title:string}[];cursor:number;issue_classes:string[]}
export interface TriageEntry {ref:string;outcome:string;reason:string;run_id:string;at:string;issue?:number;advisory?:string;failed?:boolean;finding?:Finding;attempt?:number;failure?:AdvisoryFailure;held?:boolean;capability_issue?:number;rests_on_pr?:number;rests_on_pr_state?:'merged'|'reoffer_limit';reoffered?:boolean}
/** `permission`: GitHub refused the App (403, the missing capability); `error`: anything else (spec 014 AC-5). */
export type AdvisoryFailure='permission'|'error';
/** Spec 014: a failed advisory is retried this many times in a row (per failure kind), then held. */
export const ADVISORY_ATTEMPTS=3;
/** A held ref is probed at most once per this interval, one ref per batch, while it stays held (spec 014 AC-5). */
export const PROBE_MS=86400000;
export const BATCH=20;
/** Spec 025 AC-10, AC-11: how many distinct PRs one input build asks GitHub about, and how often one ref is re-offered. */
export const PR_CHECKS=20,REOFFER_LIMIT=2;
/** A discard waiting on a PR: its last row, resting on a PR not yet resolved one way or the other (spec 025 AC-8). */
export const isRestingDiscard=(t:TriageEntry|undefined):t is TriageEntry=>!!t&&t.outcome==='discard'&&t.rests_on_pr!==undefined&&!t.rests_on_pr_state;
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
/** What makes two queue records the same record: every field but the producing run and its time (spec 019 AC-1). */
export function recordKey(q:Record<string,unknown>):string {
 const canon=(v:unknown):unknown=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon((v as Record<string,unknown>)[k])])):Array.isArray(v)?v.map(canon):v;
 const rest={...q};for(const k of ['ref','run_id','timestamp','repeat','advisory_failed','advisory_attempts','duplicate_refs','rests_on_pr_closed'])delete rest[k];
 return JSON.stringify(canon(rest));
}
export async function readJsonLines<T>(path:string):Promise<T[]> {
 let text:string;try{text=await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 return text.split('\n').filter(Boolean).map(l=>JSON.parse(l) as T);
}
export interface FilerDeps {paths:StatePaths;gh:GitHubClient;botLogin:string;now:()=>Date;classes:string[];notify:(text:string,key?:string)=>Promise<void>;log?:(entry:Record<string,unknown>)=>void}
/** A PR's state, or null when GitHub could not say. A number that is no PR leaves the discard resting on nothing, so it counts as closed. */
async function restingPrState(d:FilerDeps,pr:number):Promise<'open'|'merged'|'closed'|null> {
 try{const p=await d.gh.pullRequest(pr);return p.merged?'merged':p.state==='closed'?'closed':'open';}
 catch(e){
  if((e as {status?:unknown}).status===404)return 'closed';
  d.log?.({kind:'filer-pr-check-failed',pr,error:(e as Error).message});return null;
 }
}
/**
 * The discards whose PR closed unmerged, oldest first (spec 025 AC-9). Each PR is asked about once per build and at most
 * PR_CHECKS per build; a final answer (merged, or the re-offer limit reached) goes on a triage row, so it is never asked again.
 */
async function discardsToReoffer(d:FilerDeps,queue:unknown[],triage:TriageEntry[],last:Map<string,TriageEntry>):Promise<TriageEntry[]> {
 const resting=[...last.values()].filter(t=>isRestingDiscard(t)&&queue[Number(t.ref)-1]).sort((x,y)=>Date.parse(x.at)-Date.parse(y.at));
 const states=new Map<number,Awaited<ReturnType<typeof restingPrState>>>(),reoffer:TriageEntry[]=[],final:TriageEntry[]=[];
 for(const t of resting) {
  const pr=t.rests_on_pr!;
  if(!states.has(pr)){if(states.size>=PR_CHECKS)continue;states.set(pr,await restingPrState(d,pr));}
  const state=states.get(pr);
  if(state==='merged')final.push({...t,rests_on_pr_state:'merged'});
  else if(state==='closed') {
   if(triage.filter(r=>r.ref===t.ref&&r.reoffered).length<REOFFER_LIMIT)reoffer.push(t);
   else{final.push({...t,rests_on_pr_state:'reoffer_limit'});d.log?.({kind:'filer-reoffer-limit',ref:t.ref,pr});}
  }
 }
 if(final.length) {
  await appendFile(d.paths.findingsTriage,final.map(t=>JSON.stringify(t)+'\n').join(''));
  for(const t of final){triage.push(t);last.set(t.ref,t);}
 }
 return reoffer;
}
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
 // Identical unsettled records, anywhere after the cursor, ride on the first entry of their kind instead of taking
 // batch places of their own, so one investigation settles every copy (spec 019 AC-1). Copies of a failed advisory
 // not in this batch (held, not probed today) wait for it: as entries of their own they would lose its privacy.
 const byKey=new Map<string,QueueRecord|null>();for(const r of records)if(!byKey.has(recordKey(r)))byKey.set(recordKey(r),r);
 for(const t of failed){const key=recordKey(queue[Number(t.ref)-1] as Record<string,unknown>);if(!byKey.has(key))byKey.set(key,null);}
 // A discard whose PR closed unmerged is decided again, ahead of new records; a copy rides on its entry (spec 025 AC-9).
 for(const t of await discardsToReoffer(d,queue,triage,last)) {
  const q=queue[Number(t.ref)-1]!,key=recordKey(q as Record<string,unknown>),same=byKey.get(key);
  if(same)(same.duplicate_refs??=[]).push(t.ref);
  else if(same===null)continue;
  else if(records.length<BATCH){const r:QueueRecord={...q,ref:t.ref,repeat:t.reason,rests_on_pr_closed:t.rests_on_pr};records.push(r);byKey.set(key,r);}
 }
 for(let i=cursor;i<queue.length;i++) {
  const ref=String(i+1);if(last.has(ref)||!queue[i])continue;
  const key=recordKey(queue[i] as Record<string,unknown>),same=byKey.get(key);
  if(same)(same.duplicate_refs??=[]).push(ref);
  else if(same===null)continue;
  else if(records.length<BATCH){const r={...queue[i]!,ref};records.push(r);byKey.set(key,r);}
 }
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
