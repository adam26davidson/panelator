import {appendFile,writeFile,rename} from 'node:fs/promises';
import type {Question} from '../types.ts';
import {validate} from '../schema/validate.ts';
import {readJsonLines,settledCursor,advisoryAttempts,ADVISORY_ATTEMPTS,CAPABILITY_MARKER,type FilerDeps,type FilerInput,type TriageEntry} from './input.ts';
export interface Decision {ref:string;outcome:'discard'|'file'|'merge_into'|'escalate'|'security'|'retry'|'rewrite'|'close'|'defer';reason:string;issue?:{title:string;body:string;class:string};issue_number?:number;question?:Question;advisory?:{title:string;description:string;severity:'low'|'medium'|'high'|'critical'}}
export interface FilerResult {summary:string;decisions:Decision[]}
export async function applyFilerResult(d:FilerDeps,runId:string,input:FilerInput,result:FilerResult):Promise<void> {
 const valid=validate('filer-result',result);if(!valid.ok)throw new Error(valid.errors.join('; '));
 // One decision per distinct ref, even if an input ever held a ref twice (spec 014 AC-3).
 const refs=new Set([...input.records,...input.abandoned].map(r=>r.ref)),decided=new Set(result.decisions.map(r=>r.ref));
 if(decided.size!==result.decisions.length||decided.size!==refs.size||[...decided].some(r=>!refs.has(r)))throw new Error('decisions must cover each input ref exactly once');
 // Validate the entire batch before any effect or consumption.
 for(const dec of result.decisions) {
  const abandoned=dec.ref.startsWith('issue:');
  if(!(abandoned?['retry','rewrite','close','escalate','defer']:['discard','file','merge_into','escalate','security']).includes(dec.outcome))throw new Error(`invalid outcome for ${dec.ref}`);
  if(dec.issue && !d.classes.includes(dec.issue.class))throw new Error(`unknown issue class ${dec.issue.class}`);
  if(dec.question && !['product','technical'].includes(dec.question.kind))throw new Error('design flaw question must be product or technical');
 }
 const triage=await readJsonLines<TriageEntry>(d.paths.findingsTriage);
 // The cursor follows the triage log, so a batch aborted half way still moves it past what it applied (spec 014 AC-4).
 try{await applyDecisions(d,runId,input,result,triage);}
 finally{const line=settledCursor(input.cursor,triage);await writeFile(d.paths.findingsCursor+'.tmp',JSON.stringify({line}));await rename(d.paths.findingsCursor+'.tmp',d.paths.findingsCursor);}
}
const capabilityIssueBody=(error:string,held:number)=>`Capability needed (delivery-system design section 3, item 3: credentials and access).

The findings filer could not create a draft repository security advisory after ${ADVISORY_ATTEMPTS} attempts in a row. GitHub's last answer: \`${error.replace(/`/g,"'")}\`

${held} security finding(s) are held privately in the scheduler's state until an advisory can be created. None of their content is in this issue.

What agents cannot do: grant the panelator GitHub App the repository permission "Repository security advisories: Read and write" (spec 001 section 12, spec 008 AC-22) and accept the updated permissions on its installation.

For the spec stage: no spec or code change is needed. Return this as a question of kind \`capability\` through the question check, with the step above as the only option. Once the permission is granted, closing this issue releases the held findings at once; otherwise they are tried again after a week, and the first advisory that succeeds closes this issue (spec 014 AC-5, AC-6).

${CAPABILITY_MARKER}`;
async function openCapabilityIssue(d:FilerDeps):Promise<number|null> {
 return (await d.gh.searchOpenIssuesByMarker(CAPABILITY_MARKER)).find(i=>i.author===d.botLogin&&i.body.includes(CAPABILITY_MARKER))?.number??null;
}
async function applyDecisions(d:FilerDeps,runId:string,input:FilerInput,result:FilerResult,triage:TriageEntry[]):Promise<void> {
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
   return d.gh.createIssue(issue.title,`${body}\n\nFiler verification: ${dec.reason}\n\n${marker}`,[issue.class,'validated']);
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
   catch(e){
    const error=(e as Error).message;
    row.failed=true;row.reason=`advisory failed: ${error}`;row.attempt=advisoryAttempts(prior)+1;
    if(row.attempt>=ADVISORY_ATTEMPTS) {
     // Bounded: the record is held and the missing capability goes to the maintainer through the chain (spec 014 AC-5, AC-6).
     row.held=true;
     const lastRows=new Map(triage.map(t=>[t.ref,t]));lastRows.set(dec.ref,row);
     const held=[...lastRows.values()].filter(t=>t.held).length;
     row.capability_issue=(await openCapabilityIssue(d))??await d.gh.createIssue('The GitHub App cannot create draft security advisories',capabilityIssueBody(error,held),[d.classes.includes('class:tooling')?'class:tooling':d.classes[0],'validated']);
     row.reason+=` (held after ${row.attempt} attempts; capability issue #${row.capability_issue})`;
     await d.notify(`Security finding held after ${row.attempt} failed advisory attempts; capability issue #${row.capability_issue}: ${error}`,dec.ref);
    } else await d.notify(row.reason,dec.ref);
   }
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
  // Advisories work again, so the capability question is settled (spec 014 AC-6); done after the row is kept.
  if(row.outcome==='security'&&!row.failed) {
   const capability=await openCapabilityIssue(d);
   if(capability!==null)await d.gh.closeIssue(capability,'A draft security advisory was created: the App can write repository security advisories again, and held security findings are retried.');
  }
 }
}
