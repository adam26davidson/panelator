// Spec 025: what the findings filer is told to return, the recorded shapes it returned, and discards resting on a PR.
import {describe,it,expect,vi} from 'vitest';
import {mkdtemp,appendFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {GitHubClient} from '../src/github/client.ts';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {validate} from '../src/schema/validate.ts';
import {EVENT_NAMES} from '../src/standing/events.ts';
import {registryActionsCheck} from '../src/actions/index.ts';
import {loadRegistry,renderStandingPrompt} from '../src/standing/registry.ts';
import {buildFilerInput,readJsonLines,PR_CHECKS,REOFFER_LIMIT,type FilerDeps,type FilerInput,type TriageEntry} from '../src/filer/input.ts';
import {applyFilerResult} from '../src/filer/apply.ts';
import {normalizeFilerResult,REASON_PLACEHOLDER} from '../src/filer/normalize.ts';
const filer=()=>loadRegistry('agents/standing',EVENT_NAMES,registryActionsCheck('agents/actions.yaml'))['findings-filer']!;
const issue={title:'Bug',body:'Verified details',class:'class:bug'};
const finding={what:'A verified bug',where:'file.ts',evidence:'reproduced',noticed_how:'test'};
const examples=()=>{
 const block=/```json\n([\s\S]*?)```/.exec(filer().prompt);
 expect(block).not.toBeNull();
 return block![1].trim().split('\n').map(l=>JSON.parse(l) as Record<string,unknown>);
};
async function setup(){
 const paths=statePaths(await mkdtemp(join(tmpdir(),'filer-results-')));await ensureStateDirs(paths);
 const prs=new Map<number,unknown>();
 const gh={listOpenIssuesByLabel:vi.fn(async()=>[]),listOpenIssuesByAuthor:vi.fn(async()=>[]),searchOpenIssuesByMarker:vi.fn(async()=>[]),listComments:vi.fn(async()=>[]),createIssue:vi.fn(async(_t:string,_b:string,_l:string[])=>42),comment:vi.fn(async()=>({id:1})),removeLabel:vi.fn(async()=>{}),closeIssue:vi.fn(async()=>{}),findDraftSecurityAdvisory:vi.fn(async():Promise<string|null>=>null),createDraftSecurityAdvisory:vi.fn(async()=>'GHSA-private'),
  pullRequest:vi.fn(async(n:number)=>{const p=prs.get(n);if(!p)throw Object.assign(new Error('Not Found'),{status:404});return p;})};
 const log=vi.fn();
 const d:FilerDeps={paths,gh:gh as unknown as GitHubClient,botLogin:'bot',classes:['class:bug'],notify:vi.fn(async()=>{}),now:()=>new Date('2026-10-27T00:00:00Z'),log};
 const open=(n:number)=>prs.set(n,{number:n,state:'open',merged:false}),merged=(n:number)=>prs.set(n,{number:n,state:'closed',merged:true}),closed=(n:number)=>prs.set(n,{number:n,state:'closed',merged:false});
 const queue=async(n:number,what=(i:number)=>`finding ${i}`)=>{for(let i=0;i<n;i++)await appendFile(paths.findingsQueue,JSON.stringify({run_id:`r${i}`,timestamp:'t',finding:{...finding,what:what(i)}})+'\n');};
 const discard=async(input:FilerInput,pr:(ref:string)=>number|undefined)=>applyFilerResult(d,'run-1',input,{summary:'x',decisions:input.records.map(r=>({ref:r.ref,outcome:'discard' as const,reason:'covered by the PR',...(pr(r.ref)!==undefined?{rests_on_pr:pr(r.ref)}:{})}))});
 return {paths,gh,d,log,open,merged,closed,queue,discard,triage:()=>readJsonLines<TriageEntry>(paths.findingsTriage)};
}
describe('the filer prompt (spec 025 AC-1)',()=>{
 it('gives a schema-valid example for every outcome',()=>{
  const decisions=examples();
  const ok=validate('filer-result',{summary:'x',decisions});
  expect(ok.ok?[]:ok.errors).toEqual([]);
  expect(new Set(decisions.map(d=>d.outcome))).toEqual(new Set(['discard','file','merge_into','escalate','security','retry','rewrite','close','defer']));
  expect(decisions.some(d=>d.outcome==='discard'&&Number.isInteger(d.rests_on_pr))).toBe(true);
  expect(decisions.find(d=>d.outcome==='merge_into')).toHaveProperty('issue');
 });
 it('names the keys, asks for the final message and no longer asks for a file',()=>{
  const p=filer().prompt;
  expect(p).toMatch(/final message/);expect(p).not.toContain('{{result_path}}');expect(p).not.toMatch(/\bwrite (the )?json\b/i);
  expect(p).toMatch(/`issue`/);expect(p).toMatch(/rests_on_pr/);expect(p).toMatch(/rests_on_pr_closed/);
 });
 it('rendering leaves the examples intact',()=>{
  const rendered=renderStandingPrompt(filer().prompt,{agent:'a',events:'e',since:'s',parameters:'p',profile_instructions:''});
  for(const e of examples())expect(rendered).toContain(JSON.stringify(e));
 });
});
describe('normalizeFilerResult (spec 025 AC-2)',()=>{
 const shape=(decisions:unknown[])=>({summary:'x',decisions});
 const check=(raw:unknown)=>{const n=normalizeFilerResult(raw);return {...n,v:validate('filer-result',n.result)};};
 it('moves fallback to issue on merge_into, as recorded',()=>{
  const n=check(shape([{ref:'2',outcome:'merge_into',reason:'same',issue_number:9,fallback:issue}]));
  expect(n.v.ok).toBe(true);expect((n.result as {decisions:unknown[]}).decisions[0]).toEqual({ref:'2',outcome:'merge_into',reason:'same',issue_number:9,issue});
  expect(n.notes).toEqual(['2: fallback moved to issue']);
 });
 it('gathers a flat title, body and class into issue and marks the missing reason, as recorded',()=>{
  const n=check(shape([{ref:'3',outcome:'file',...issue}]));
  expect(n.v.ok).toBe(true);expect((n.result as {decisions:unknown[]}).decisions[0]).toEqual({ref:'3',outcome:'file',issue,reason:REASON_PLACEHOLDER});
  expect(n.notes).toEqual(['3: flat title, body, class gathered into issue','3: missing reason replaced by a placeholder']);
  expect(REASON_PLACEHOLDER).toMatch(/placeholder/);
 });
 it('leaves a correct result alone and does not mutate its input',()=>{
  const raw=shape([{ref:'1',outcome:'file',reason:'r',issue},{ref:'2',outcome:'discard',reason:'r'}]);const copy=structuredClone(raw);
  const n=check(raw);expect(n.notes).toEqual([]);expect(n.result).toEqual(copy);expect(raw).toEqual(copy);
  const flat=shape([{ref:'3',outcome:'file',...issue}]);normalizeFilerResult(flat);expect(flat).toEqual(shape([{ref:'3',outcome:'file',...issue}]));
 });
 it.each([
  ['a partial flat issue',{ref:'1',outcome:'file',reason:'r',title:'only a title'}],
  ['flat keys beside an issue',{ref:'1',outcome:'file',reason:'r',issue,title:'t',body:'b',class:'c'}],
  ['both fallback and flat keys',{ref:'1',outcome:'file',reason:'r',fallback:issue,...issue}],
  ['fallback beside an issue',{ref:'1',outcome:'merge_into',reason:'r',issue_number:1,issue,fallback:issue}],
  ['a fallback that is not an issue',{ref:'1',outcome:'merge_into',reason:'r',issue_number:1,fallback:'none'}],
  ['fallback on a discard',{ref:'1',outcome:'discard',reason:'r',fallback:issue}],
  ['flat keys on a security decision',{ref:'1',outcome:'security',reason:'r',...issue}],
  ['a discard with no reason',{ref:'1',outcome:'discard'}],
  ['a close with no reason',{ref:'issue:1',outcome:'close'}],
  ['an unknown key',{ref:'1',outcome:'file',reason:'r',issue,extra:true}],
 ])('keeps %s invalid',(_name,decision)=>{expect(check(shape([decision])).v.ok).toBe(false);});
 it.each([[null],['text'],[{summary:'x'}],[{summary:'x',decisions:'none'}],[{summary:'x',decisions:[null,3]}]])('passes %j through unchanged',raw=>{expect(normalizeFilerResult(raw)).toEqual({result:raw,notes:[]});});
 it('a normalised batch passes batch validation, and merge_into with a closed target files the moved issue',async()=>{
  const {d,gh,paths}=await setup();
  const input:FilerInput={records:[{ref:'1',finding},{ref:'2',finding:{...finding,what:'other'}}],abandoned:[],open_issues:[],cursor:0,issue_classes:['class:bug']};
  const {result}=normalizeFilerResult({summary:'x',decisions:[{ref:'1',outcome:'file',title:'Flat',body:'Flat body',class:'class:bug'},{ref:'2',outcome:'merge_into',reason:'same',issue_number:99,fallback:{title:'Moved',body:'Moved body',class:'class:bug'}}]});
  await applyFilerResult(d,'run',input,result as never);
  expect(gh.createIssue.mock.calls.map(c=>c[0])).toEqual(['Flat','Moved']);
  expect(gh.createIssue.mock.calls[0][1]).toContain(REASON_PLACEHOLDER);
  expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>t.outcome)).toEqual(['file','file']);
 });
});
describe('a discard resting on a pull request (spec 025 AC-7 to AC-11)',()=>{
 it('accepts rests_on_pr on a discard only',()=>{
  const v=(decision:unknown)=>validate('filer-result',{summary:'x',decisions:[decision]}).ok;
  expect(v({ref:'1',outcome:'discard',reason:'r',rests_on_pr:73})).toBe(true);
  expect(v({ref:'1',outcome:'file',reason:'r',issue,rests_on_pr:73})).toBe(false);
  expect(v({ref:'1',outcome:'discard',reason:'r',rests_on_pr:0})).toBe(false);
  expect(v({ref:'1',outcome:'discard',reason:'r',rests_on_pr:'#73'})).toBe(false);
 });
 it('keeps it on the triage row',async()=>{
  const {queue,d,discard,triage}=await setup();await queue(1);
  await discard(await buildFilerInput(d),()=>73);
  expect((await triage())[0]).toMatchObject({ref:'1',outcome:'discard',rests_on_pr:73});
 });
 it('re-offers the ref once the PR closes unmerged; the decision applies and settles it',async()=>{
  const {queue,d,discard,closed,gh,paths,triage}=await setup();await queue(2);
  await discard(await buildFilerInput(d),ref=>ref==='1'?73:undefined);closed(73);
  const input=await buildFilerInput(d);
  expect(input.records).toHaveLength(1);
  expect(input.records[0]).toMatchObject({ref:'1',rests_on_pr_closed:73,repeat:'covered by the PR',finding:{what:'finding 0'}});
  await applyFilerResult(d,'run-2',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'the PR was closed',issue}]});
  expect(gh.createIssue).toHaveBeenCalledTimes(1);
  expect((await triage()).at(-1)).toMatchObject({ref:'1',outcome:'file',issue:42,reoffered:true});
  expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(2);
  expect((await buildFilerInput(d)).records).toEqual([]);
 });
 it('stays settled while the PR is open, and checks again next run',async()=>{
  const {queue,d,discard,open,gh}=await setup();await queue(1);
  await discard(await buildFilerInput(d),()=>73);open(73);
  expect((await buildFilerInput(d)).records).toEqual([]);expect((await buildFilerInput(d)).records).toEqual([]);
  expect(gh.pullRequest).toHaveBeenCalledTimes(2);
 });
 it('stays settled once merged and never asks about that PR again',async()=>{
  const {queue,d,discard,merged,gh,triage}=await setup();await queue(1);
  await discard(await buildFilerInput(d),()=>73);merged(73);
  expect((await buildFilerInput(d)).records).toEqual([]);expect((await buildFilerInput(d)).records).toEqual([]);
  expect(gh.pullRequest).toHaveBeenCalledTimes(1);
  expect((await triage()).at(-1)).toMatchObject({ref:'1',outcome:'discard',rests_on_pr:73,rests_on_pr_state:'merged'});
 });
 it('asks once per PR per run however many discards rest on it',async()=>{
  const {queue,d,discard,open,gh}=await setup();await queue(5);
  await discard(await buildFilerInput(d),()=>73);open(73);
  await buildFilerInput(d);expect(gh.pullRequest).toHaveBeenCalledTimes(1);
 });
 it('bounds the PRs asked about per run',async()=>{
  const {queue,d,discard,open,gh}=await setup();
  await queue(20);await discard(await buildFilerInput(d),ref=>Number(ref));
  await queue(10,i=>`later ${i}`);
  for(let n=1;n<=30;n++)open(n);
  await discard(await buildFilerInput(d),ref=>Number(ref));
  gh.pullRequest.mockClear();
  await buildFilerInput(d);expect(PR_CHECKS).toBe(20);expect(gh.pullRequest).toHaveBeenCalledTimes(PR_CHECKS);
 });
 it('a PR that does not exist counts as closed unmerged; any other GitHub error leaves it settled and fails nothing',async()=>{
  const {queue,d,discard,gh,log}=await setup();await queue(1);
  await discard(await buildFilerInput(d),()=>73);
  gh.pullRequest.mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN'));
  expect((await buildFilerInput(d)).records).toEqual([]);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({kind:'filer-pr-check-failed',pr:73}));
  expect((await buildFilerInput(d)).records[0]).toMatchObject({ref:'1',rests_on_pr_closed:73});
 });
 it('re-offers a ref at most REOFFER_LIMIT times, then records and logs that it stays settled',async()=>{
  const {queue,d,discard,closed,gh,log,triage}=await setup();await queue(1);closed(73);
  expect(REOFFER_LIMIT).toBe(2);
  await discard(await buildFilerInput(d),()=>73);
  for(let i=0;i<REOFFER_LIMIT;i++){const input=await buildFilerInput(d);expect(input.records).toHaveLength(1);await discard(input,()=>73);}
  expect((await buildFilerInput(d)).records).toEqual([]);
  expect((await triage()).at(-1)).toMatchObject({ref:'1',rests_on_pr_state:'reoffer_limit'});
  expect(log).toHaveBeenCalledWith(expect.objectContaining({kind:'filer-reoffer-limit',ref:'1',pr:73}));
  const calls=gh.pullRequest.mock.calls.length;await buildFilerInput(d);expect(gh.pullRequest).toHaveBeenCalledTimes(calls);
 });
 it('re-offered identical records collapse to one entry whose decision settles them all (spec 019)',async()=>{
  const {queue,d,discard,closed,triage}=await setup();await queue(3,()=>'same');
  const first=await buildFilerInput(d);expect(first.records).toHaveLength(1);expect(first.records[0].duplicate_refs).toEqual(['2','3']);
  await discard(first,()=>73);
  expect((await triage()).map(t=>t.rests_on_pr)).toEqual([73,73,73]);closed(73);
  const input=await buildFilerInput(d);expect(input.records).toHaveLength(1);expect(input.records[0]).toMatchObject({ref:'1',duplicate_refs:['2','3'],rests_on_pr_closed:73});
  await applyFilerResult(d,'run-2',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'real',issue}]});
  expect((await triage()).slice(3).map(t=>[t.ref,t.outcome,t.reoffered])).toEqual([['1','file',true],['2','file',true],['3','file',true]]);
  expect((await buildFilerInput(d)).records).toEqual([]);
 });
 it('re-offers count toward the batch of 20, and what does not fit waits',async()=>{
  const {queue,d,discard,closed}=await setup();await queue(20);
  await discard(await buildFilerInput(d),ref=>Number(ref)===1?73:undefined);closed(73);
  await queue(25,i=>`later ${i}`);
  const input=await buildFilerInput(d);expect(input.records).toHaveLength(20);expect(input.records[0].ref).toBe('1');expect(input.records[1].ref).toBe('21');
 });
 it('a re-offered security record stays private whatever the decision',async()=>{
  const {paths,d,discard,closed,gh}=await setup();await appendFile(paths.findingsQueue,JSON.stringify({finding:{...finding,security:true}})+'\n');
  await discard(await buildFilerInput(d),()=>73);closed(73);
  const input=await buildFilerInput(d);
  await applyFilerResult(d,'run-2',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'real',issue}]});
  expect(gh.createIssue).not.toHaveBeenCalled();expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);
 });
});
