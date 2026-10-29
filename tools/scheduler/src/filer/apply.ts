import {appendFile,writeFile,rename} from 'node:fs/promises';
import type {Question} from '../types.ts';
import {validate} from '../schema/validate.ts';
import {readJsonLines,settledCursor,advisoryAttempts,isCapabilityIssue,stripCapabilityMarkers,ADVISORY_ATTEMPTS,CAPABILITY_MARKER,CAPABILITY_TITLE,CAPABILITY_CLOSED_MARKER,type AdvisoryFailure,type FilerDeps,type FilerInput,type TriageEntry} from './input.ts';
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
/**
 * GitHub refusing the App is the missing capability: "Resource not accessible by integration", or a 403 that is not
 * a (secondary) rate limit, which also answers 403 but says so or carries retry-after. Anything else is an error (spec 014 AC-5).
 */
function classify(e:unknown):{kind:AdvisoryFailure;status:number|null;message:string} {
 const err=e as {status?:unknown;message?:string;response?:{headers?:Record<string,unknown>}};
 const status=typeof err?.status==='number'?err.status:null,message=err?.message??String(e);
 const limited=/rate limit/i.test(message)||err?.response?.headers?.['retry-after']!==undefined;
 return {kind:/Resource not accessible by integration/.test(message)||(status===403&&!limited)?'permission':'error',status,message};
}
/** Public text: only the status and fixed phrases, never GitHub's message, which can echo the advisory payload (spec 014 AC-6). */
const capabilityIssueBody=(status:number|null,held:number)=>`Capability needed (delivery-system design section 3, item 3: credentials and access).

The findings filer could not create a draft repository security advisory after ${ADVISORY_ATTEMPTS} attempts in a row: GitHub answered HTTP ${status??403} (the App is not permitted to write repository security advisories).

${held} security finding(s) are held privately in the scheduler's state until an advisory can be created. None of their content is in this issue.

What agents cannot do: grant the panelator GitHub App the repository permission "Repository security advisories: Read and write" (spec 001 section 12, spec 008 AC-22) and accept the updated permissions on its installation.

For the spec stage: no spec or code change is needed. Return this as a question of kind \`capability\` through the question check, with granting the permission as the only option. When the maintainer answers, the scheduler closes this issue instead of resuming the chain and retries the held findings at once; a failure then holds them again under a new issue. While this issue is open, one held finding is tried once a day, and the first advisory that succeeds closes this issue (spec 014 AC-5, AC-6, AC-8).

${CAPABILITY_MARKER}`;
async function applyDecisions(d:FilerDeps,runId:string,input:FilerInput,result:FilerResult,triage:TriageEntry[]):Promise<void> {
 // The open capability issue, looked up at most once per batch and only while something is held (spec 014 AC-6).
 let capability:number|null|undefined;
 const capabilityIssue=async()=>capability!==undefined?capability:(capability=(await d.gh.searchOpenIssuesByMarker(CAPABILITY_MARKER)).find(i=>isCapabilityIssue(i,d.botLogin))?.number??null);
 const lastRows=()=>{const m=new Map<string,TriageEntry>();for(const t of triage)m.set(t.ref,t);return [...m.values()];};
 const heldUnderIssue=()=>lastRows().some(t=>t.held&&t.capability_issue!==undefined);
 // The closing comment carries a marker, so a close that failed after commenting does not comment again.
 const closeCapability=async(n:number,text:string)=>{
  if(!(await d.gh.listComments(n)).some(c=>c.body.includes(CAPABILITY_CLOSED_MARKER)))await d.gh.comment(n,`${text}\n\n${CAPABILITY_CLOSED_MARKER}`);
  await d.gh.closeIssue(n,'');capability=null;
 };
 let touchedHeld=false;
 for(const dec of result.decisions) {
  const abandoned=input.abandoned.find(r=>r.ref===dec.ref),record=input.records.find(r=>r.ref===dec.ref);
  const prior=triage.filter(t=>t.ref===dec.ref).at(-1);
  if(prior&&!prior.failed&&(!abandoned||Date.parse(prior.at)>d.now().getTime()-7*86400000))continue;
  if(prior?.held&&prior.capability_issue!==undefined)touchedHeld=true;
  const row:TriageEntry={ref:dec.ref,outcome:dec.outcome,reason:dec.reason,run_id:runId,at:d.now().toISOString(),...(record?{finding:record.finding}:{})};
  const marker=`<!-- panelator-finding:${runId}:${dec.ref} -->`;
  const file=async()=>{
   const issue=dec.issue??{title:record?.finding.what??abandoned!.issue.title,body:JSON.stringify(record?.finding??abandoned!.issue,null,2),class:d.classes.includes('class:bug')?'class:bug':d.classes[0]};
   const existing=(await d.gh.searchOpenIssuesByMarker('<!-- panelator-finding:')).find(i=>i.author===d.botLogin&&new RegExp(`<!-- panelator-finding:[^:]+:${dec.ref.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} -->`).test(i.body));
   if(existing)return existing.number;
   // Spec creation belongs to the chain; an input cannot smuggle a Spec line into intake.
   // Nor can it carry the capability issue's marker (spec 014 AC-6).
   let body=stripCapabilityMarkers(issue.body.replace(/^\s*Spec:.*$/gm,''));
   if(dec.outcome==='escalate')body=`Possible design flaw\n\n${body}\n\nQuestion for the spec stage:\n${JSON.stringify(dec.question,null,2)}`;
   return d.gh.createIssue(stripCapabilityMarkers(issue.title),stripCapabilityMarkers(`${body}\n\nFiler verification: ${dec.reason}`)+`\n\n${marker}`,[issue.class,'validated']);
  };
  // A security flag overrides every public outcome; a discard is private and stays a discard (AC-19). A record
  // already judged security once (a retried advisory) is as private as a flagged one (spec 014 AC-9).
  const confidential=!!record&&(record.finding.security||record.advisory_failed||triage.some(t=>t.ref===dec.ref&&t.outcome==='security'));
  if(dec.outcome==='security'||(confidential&&dec.outcome!=='discard')) {
   row.outcome='security';
   try {
    const advisory=dec.advisory??{title:dec.issue?.title??record!.finding.what,description:dec.issue?.body??JSON.stringify(record!.finding),severity:'high' as const};
    const privateMarker=`<!-- panelator-security-finding:${dec.ref} -->`;
    row.advisory=(await d.gh.findDraftSecurityAdvisory(privateMarker))??await d.gh.createDraftSecurityAdvisory({...advisory,description:`${advisory.description}\n\n${privateMarker}`});
    await d.notify(`Security advisory ${row.advisory}`,dec.ref);
   }
   catch(e){
    const {kind,status,message}=classify(e);
    row.failed=true;row.failure=kind;row.reason=`advisory failed: ${message}`;row.attempt=advisoryAttempts(prior)+1;
    const wasHeld=!!prior?.held;
    if(row.attempt>=ADVISORY_ATTEMPTS) {
     // Bounded: the record is held whatever the kind of failure; the kind only decides whether a missing permission
     // is raised with the maintainer through the chain. Any held ref stays linked to an open capability issue (spec 014 AC-5, AC-6).
     row.held=true;
     let filed=false,n=await capabilityIssue();
     if(n===null&&kind==='permission'){const held=lastRows().filter(t=>t.held&&t.ref!==dec.ref).length+1;n=capability=await d.gh.createIssue(CAPABILITY_TITLE,capabilityIssueBody(status,held),[d.classes.includes('class:tooling')?'class:tooling':d.classes[0],'validated']);filed=true;}
     if(n!==null)row.capability_issue=n;
     row.reason+=` (held after ${row.attempt} attempts${row.capability_issue?`; capability issue #${row.capability_issue}`:''})`;
     // A daily probe that fails again under the same open question stays quiet; the full error stays private.
     if(!wasHeld||filed)await d.notify(`Security finding held after ${row.attempt} failed advisory attempts${row.capability_issue?`; capability issue #${row.capability_issue}`:''}: ${message}`,dec.ref);
    } else await d.notify(row.reason,dec.ref);
   }
  } else switch(dec.outcome) {
   case 'file':case 'escalate': row.issue=await file();break;
   case 'merge_into': {
    const target=(await d.gh.listOpenIssuesByAuthor(d.botLogin)).find(i=>i.number===dec.issue_number);
    if(!target){row.outcome='file';row.reason+=' (merge target closed or not bot-authored)';row.issue=await file();}
    else {const comments=await d.gh.listComments(target.number);if(!comments.some(c=>c.body.includes(`:${dec.ref} -->`)))await d.gh.comment(target.number,stripCapabilityMarkers(`${JSON.stringify(record?.finding,null,2)}\n\n${dec.reason}`)+`\n\n${marker}`);row.issue=target.number;}break;
   }
   case 'retry':
    if(triage.filter(t=>t.ref===dec.ref&&t.outcome==='retry').length>=2){row.outcome='defer';row.reason='retry limit of two exhausted';break;}
    await d.gh.comment(abandoned!.issue.number,stripCapabilityMarkers(`Retry: ${dec.reason}`)+`\n\n${marker}`);await d.gh.removeLabel(abandoned!.issue.number,'abandoned');row.issue=abandoned!.issue.number;break;
   case 'rewrite': row.issue=await file();await d.gh.closeIssue(abandoned!.issue.number,stripCapabilityMarkers(`Superseded by #${row.issue}: ${dec.reason}`));break;
   case 'close':await d.gh.closeIssue(abandoned!.issue.number,stripCapabilityMarkers(dec.reason));row.issue=abandoned!.issue.number;break;
   case 'discard':case 'defer':break;
  }
  await appendFile(d.paths.findingsTriage,JSON.stringify(row)+'\n');triage.push(row);
  // Advisories work again, so the capability question is settled (spec 014 AC-6); done after the row is kept, and
  // only when something was held under a permission failure.
  if(row.outcome==='security'&&!row.failed&&(touchedHeld||heldUnderIssue())) {
   const n=await capabilityIssue();
   if(n!==null)await closeCapability(n,'A draft security advisory was created: the App can write repository security advisories again, and held security findings are retried.');
  }
 }
 // A batch that settled the last held ref some other way (a discard) leaves nothing to probe: the question is moot.
 if(touchedHeld&&!heldUnderIssue()) {
  const n=await capabilityIssue();
  if(n!==null)await closeCapability(n,'No security finding is held any more, so this capability question is closed. A new failure files a new issue.');
 }
}
