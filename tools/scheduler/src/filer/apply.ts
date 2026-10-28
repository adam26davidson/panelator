import {appendFile,writeFile,rename} from 'node:fs/promises';
import type {Question} from '../types.ts';
import {validate} from '../schema/validate.ts';
import {record as recordEvt} from '../events/store.ts';
import {createIssueRecorded} from '../events/filed.ts';
import {readJsonLines,type FilerDeps,type FilerInput,type TriageEntry} from './input.ts';
export interface Decision {ref:string;outcome:'discard'|'file'|'merge_into'|'escalate'|'security'|'retry'|'rewrite'|'close'|'defer';reason:string;issue?:{title:string;body:string;class:string};issue_number?:number;question?:Question;advisory?:{title:string;description:string;severity:'low'|'medium'|'high'|'critical'}}
export interface FilerResult {summary:string;decisions:Decision[]}
export async function applyFilerResult(d:FilerDeps,runId:string,input:FilerInput,result:FilerResult):Promise<void> {
 const valid=validate('filer-result',result);if(!valid.ok)throw new Error(valid.errors.join('; '));
 const refs=[...input.records,...input.abandoned].map(r=>r.ref);
 if(new Set(result.decisions.map(r=>r.ref)).size!==refs.length||result.decisions.length!==refs.length||result.decisions.some(r=>!refs.includes(r.ref)))throw new Error('decisions must cover each input ref exactly once');
 // Validate the entire batch before any effect or consumption.
 for(const dec of result.decisions) {
  const abandoned=dec.ref.startsWith('issue:');
  if(!(abandoned?['retry','rewrite','close','escalate','defer']:['discard','file','merge_into','escalate','security']).includes(dec.outcome))throw new Error(`invalid outcome for ${dec.ref}`);
  if(dec.issue && !d.classes.includes(dec.issue.class))throw new Error(`unknown issue class ${dec.issue.class}`);
  if(dec.question && !['product','technical'].includes(dec.question.kind))throw new Error('design flaw question must be product or technical');
 }
 let triage=await readJsonLines<TriageEntry>(d.paths.findingsTriage);
 for(const dec of result.decisions) {
  const abandoned=input.abandoned.find(r=>r.ref===dec.ref),record=input.records.find(r=>r.ref===dec.ref);
  const prior=triage.filter(t=>t.ref===dec.ref).at(-1);
  if(prior&&!prior.failed&&(!abandoned||Date.parse(prior.at)>d.now().getTime()-7*86400000))continue;
  const row:TriageEntry={ref:dec.ref,outcome:dec.outcome,reason:dec.reason,run_id:runId,at:d.now().toISOString(),...(record?{finding:record.finding}:{})};
  const marker=`<!-- panelator-finding:${runId}:${dec.ref} -->`;
  const file=async()=>{
   const issue=dec.issue??{title:record?.finding.what??abandoned!.issue.title,body:JSON.stringify(record?.finding??abandoned!.issue,null,2),class:d.classes.includes('class:bug')?'class:bug':d.classes[0]};
   const existing=(await d.gh.searchOpenIssuesByMarker('<!-- panelator-finding:')).find(i=>i.author===d.botLogin&&new RegExp(`<!-- panelator-finding:[^:]+:${dec.ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} -->`).test(i.body));
   if(existing)return existing.number;
   // Spec creation belongs to the chain; an input cannot smuggle a Spec line into intake.
   let body=issue.body.replace(/^\s*Spec:.*$/gm,'');
   if(dec.outcome==='escalate')body=`Possible design flaw\n\n${body}\n\nQuestion for the spec stage:\n${JSON.stringify(dec.question,null,2)}`;
   return createIssueRecorded(d.paths,d.gh,d.now(),{title:issue.title,body:`${body}\n\nFiler verification: ${dec.reason}\n\n${marker}`,labels:[issue.class,'validated'],by:d.botLogin,class:issue.class,marker});
  };
  // A security flag overrides every public outcome; a discard is private and stays a discard (AC-19).
  if(dec.outcome==='security'||(record?.finding.security&&dec.outcome!=='discard')) {
   row.outcome='security';
   try {
    const advisory=dec.advisory??{title:dec.issue?.title??record!.finding.what,description:dec.issue?.body??JSON.stringify(record!.finding),severity:'high' as const};
    const privateMarker=`<!-- panelator-security-finding:${dec.ref} -->`;
    row.advisory=(await d.gh.findDraftSecurityAdvisory(privateMarker))??await d.gh.createDraftSecurityAdvisory({...advisory,description:`${advisory.description}\n\n${privateMarker}`});
    await d.notify(`Security advisory ${row.advisory}`,dec.ref);
   }
   catch(e){row.failed=true;row.reason=`advisory failed: ${(e as Error).message}`;await d.notify(row.reason,dec.ref);}
  } else switch(dec.outcome) {
   case 'file':case 'escalate': row.issue=await file();break;
   case 'merge_into': {
    const target=(await d.gh.listOpenIssuesByAuthor(d.botLogin)).find(i=>i.number===dec.issue_number);
    if(!target){row.outcome='file';row.reason+=' (merge target closed or not bot-authored)';row.issue=await file();}
    else {const comments=await d.gh.listComments(target.number);if(!comments.some(c=>c.body.includes(`:${dec.ref} -->`)))await d.gh.comment(target.number,`${JSON.stringify(record?.finding,null,2)}\n\n${dec.reason}\n\n${marker}`);row.issue=target.number;}break;
   }
   case 'retry':
    if(triage.filter(t=>t.ref===dec.ref&&t.outcome==='retry').length>=2){row.outcome='defer';row.reason='retry limit of two exhausted';break;}
    await d.gh.comment(abandoned!.issue.number,`Retry: ${dec.reason}\n\n${marker}`);await d.gh.removeLabel(abandoned!.issue.number,'abandoned');row.issue=abandoned!.issue.number;break;
   case 'rewrite': row.issue=await file();await d.gh.closeIssue(abandoned!.issue.number,`Superseded by #${row.issue}: ${dec.reason}`);break;
   case 'close':await d.gh.closeIssue(abandoned!.issue.number,dec.reason);row.issue=abandoned!.issue.number;break;
   case 'discard':case 'defer':break;
  }
  await appendFile(d.paths.findingsTriage,JSON.stringify(row)+'\n');triage.push(row);
  await recordEvt(d.paths,'finding.triaged',row.at,row as unknown as Record<string,unknown>,{run_id:runId});
 }
 const line=Math.max(input.cursor,...input.records.filter(r=>!r.advisory_failed).map(r=>Number(r.ref)));
 await writeFile(d.paths.findingsCursor+'.tmp',JSON.stringify({line}));await rename(d.paths.findingsCursor+'.tmp',d.paths.findingsCursor);
}
