import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {withStateLock} from '../parameters/store.ts';
import type {StatePaths} from '../state/paths.ts';
import type {GitHubClient} from '../github/client.ts';
import type {Finding,IssueData} from '../types.ts';
export interface QueueRecord {ref:string; finding:Finding; repeat?:string; advisory_failed?:boolean; [key:string]:unknown}
export interface AbandonedRecord {ref:string;issue:IssueData;comments:unknown[];ledgers:unknown[];retries:number}
export interface FilerInput {records:QueueRecord[];abandoned:AbandonedRecord[];open_issues:{number:number;title:string}[];cursor:number}
export interface TriageEntry {ref:string;outcome:string;reason:string;run_id:string;at:string;issue?:number;advisory?:string;failed?:boolean;finding?:Finding}
export async function readJsonLines<T>(path:string):Promise<T[]> {
 let text:string;try{text=await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 return text.split('\n').filter(Boolean).map(l=>JSON.parse(l) as T);
}
export interface FilerDeps {paths:StatePaths;gh:GitHubClient;botLogin:string;now:()=>Date;classes:string[];notify:(text:string,key?:string)=>Promise<void>}
export async function buildFilerInput(d:FilerDeps):Promise<FilerInput> {
 let cursor=0;try{cursor=JSON.parse(await readFile(d.paths.findingsCursor,'utf8')).line;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const queue=await withStateLock(d.paths.findingsQueue,()=>readJsonLines<{finding:Finding}>(d.paths.findingsQueue)),triage=await readJsonLines<TriageEntry>(d.paths.findingsTriage);
 const last=new Map<string,TriageEntry>();for(const t of triage)last.set(t.ref,t);
 const retries=[...last.values()].filter(t=>t.failed&&t.outcome==='security').map(t=>({...queue[Number(t.ref)-1],ref:t.ref,advisory_failed:true}));
 const records:QueueRecord[]=[...retries,...queue.slice(cursor,cursor+Math.max(0,20-retries.length)).map((q,i)=>({...q,ref:String(cursor+i+1)}))].slice(0,20);
 for(const r of records){const old=triage.find(t=>t.outcome==='discard'&&t.finding?.what===r.finding.what&&t.finding?.where===r.finding.where&&Date.parse(t.at)>d.now().getTime()-30*86400000);if(old)r.repeat=old.reason;}
 const abandoned:AbandonedRecord[]=[];
 const openBot=await d.gh.listOpenIssuesByAuthor(d.botLogin);
 for(const issue of await d.gh.listOpenIssuesByLabel('abandoned')) {
  const ref=`issue:${issue.number}`,history=triage.filter(t=>t.ref===ref);
  if(history.some(t=>Date.parse(t.at)>d.now().getTime()-7*86400000))continue;
  const escalation=history.at(-1);
  if(escalation?.outcome==='escalate'&&openBot.some(i=>i.number===escalation.issue&&!i.labels.includes('abandoned')))continue;
  const ledgers=[];for(const f of await readdir(d.paths.escalations))if(f.startsWith(`${issue.number}.abandoned-`))ledgers.push(JSON.parse(await readFile(join(d.paths.escalations,f),'utf8')));
  abandoned.push({ref,issue,comments:await d.gh.listComments(issue.number),ledgers,retries:history.filter(t=>t.outcome==='retry').length});
 }
 return {records,abandoned,open_issues:openBot.map(i=>({number:i.number,title:i.title})),cursor};
}
