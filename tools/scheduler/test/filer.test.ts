import {it,expect,vi} from 'vitest';
import {mkdtemp,appendFile,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {GitHubClient} from '../src/github/client.ts';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {buildFilerInput,readJsonLines,type FilerDeps,type FilerInput,type TriageEntry} from '../src/filer/input.ts';
import {applyFilerResult,type Decision} from '../src/filer/apply.ts';
const finding={what:'A verified bug',where:'file.ts',evidence:'reproduced',noticed_how:'test'};
const issue={title:'Bug',body:'Verified details\nSpec: no-smuggled-spec',class:'class:bug'};
async function setup(){
 const paths=statePaths(await mkdtemp(join(tmpdir(),'filer-')));await ensureStateDirs(paths);
 const gh={listOpenIssuesByLabel:vi.fn(async()=>[]),listOpenIssuesByAuthor:vi.fn(async()=>[]),searchOpenIssuesByMarker:vi.fn(async()=>[]),listComments:vi.fn(async()=>[]),createIssue:vi.fn(async(_title:string,_body:string,_labels:string[])=>42),comment:vi.fn(async()=>({id:1})),removeLabel:vi.fn(async()=>{}),closeIssue:vi.fn(async()=>{}),findDraftSecurityAdvisory:vi.fn(async():Promise<string|null>=>null),createDraftSecurityAdvisory:vi.fn(async()=> 'GHSA-private')};
 const notify=vi.fn(async()=>{}),now=()=>new Date('2026-10-27T00:00:00Z');
 const d:FilerDeps={paths,gh:gh as unknown as GitHubClient,botLogin:'bot',classes:['class:bug'],notify,now};
 const input:FilerInput={records:[{ref:'1',finding}],abandoned:[],open_issues:[],cursor:0};
 return {paths,gh,d,input,notify};
}
it('bounds and orders batches, records decisions before cursor; rejects incomplete or extra decisions',async()=>{
 const {paths,d}=await setup();for(let i=0;i<25;i++)await appendFile(paths.findingsQueue,JSON.stringify({finding:{...finding,what:String(i)}})+'\n');
 const input=await buildFilerInput(d);expect(input.records).toHaveLength(20);expect(input.records[0].ref).toBe('1');expect(input.records[19].ref).toBe('20');
 await expect(applyFilerResult(d,'run',input,{summary:'x',decisions:[]})).rejects.toThrow(/each input/);
 expect(await readJsonLines(paths.findingsTriage)).toEqual([]);
 await applyFilerResult(d,'run',input,{summary:'x',decisions:input.records.map(r=>({ref:r.ref,outcome:'discard',reason:'not an issue'}))});
 expect(await readJsonLines(paths.findingsTriage)).toHaveLength(20);expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(20);
});
it('files validated bot issues without a Spec line and does not apply twice after a cursor crash',async()=>{
 const {d,input,gh,paths}=await setup();const result={summary:'file',decisions:[{ref:'1',outcome:'file' as const,reason:'verified',issue}]};
 await applyFilerResult(d,'run',input,result);expect(gh.createIssue).toHaveBeenCalledWith('Bug',expect.stringContaining('<!-- panelator-finding:run:1 -->'),['class:bug','validated']);expect(gh.createIssue.mock.calls[0][1]).not.toContain('Spec:');
 await unlink(paths.findingsCursor);await applyFilerResult(d,'new-run',input,result);expect(gh.createIssue).toHaveBeenCalledTimes(1);
});
it.each(['file','merge_into','escalate'] as const)('never publishes a security record even for %s',async(outcome)=>{
 const {d,input,gh,paths}=await setup();input.records[0].finding={...finding,security:true};
 await applyFilerResult(d,'run',input,{summary:'private',decisions:[{ref:'1',outcome,reason:'verified security',issue,issue_number:1,question:{kind:'technical',question:'Is this a flaw?',options:[{label:'fix',cost:'small'}],recommendation:'fix'}}]});
 expect(gh.createIssue).not.toHaveBeenCalled();expect(gh.comment).not.toHaveBeenCalled();expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);expect((await readJsonLines<TriageEntry>(paths.findingsTriage))[0].advisory).toBe('GHSA-private');
});
it('a discarded security-flagged record stays a discard with no advisory',async()=>{
 const {d,input,gh,paths}=await setup();input.records[0].finding={...finding,security:true};
 await applyFilerResult(d,'run',input,{summary:'no',decisions:[{ref:'1',outcome:'discard',reason:'false positive'}]});
 expect(gh.createDraftSecurityAdvisory).not.toHaveBeenCalled();expect(gh.createIssue).not.toHaveBeenCalled();expect((await readJsonLines<TriageEntry>(paths.findingsTriage))[0].outcome).toBe('discard');
});
it('advisory failure is consumed privately and offered again',async()=>{
 const {d,input,gh,paths,notify}=await setup();await appendFile(paths.findingsQueue,JSON.stringify({finding:{...finding,security:true}})+'\n');
 gh.createDraftSecurityAdvisory.mockRejectedValueOnce(new Error('403'));
 await applyFilerResult(d,'run',input,{summary:'security',decisions:[{ref:'1',outcome:'security',reason:'private',advisory:{title:'Secret',description:'Details',severity:'high'}}]});
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(1);expect((await buildFilerInput(d)).records[0].advisory_failed).toBe(true);expect(notify).toHaveBeenCalledTimes(1);expect(gh.createIssue).not.toHaveBeenCalled();
});
it('merge_into comments on a bot issue, or files a fallback for missing targets',async()=>{
 const {d,input,gh}=await setup();await applyFilerResult(d,'run',input,{summary:'merge',decisions:[{ref:'1',outcome:'merge_into',reason:'same issue',issue_number:4}]});expect(gh.createIssue).toHaveBeenCalledTimes(1);
 const x=await setup();x.gh.listOpenIssuesByAuthor.mockResolvedValue([{number:4}] as never);
 await applyFilerResult(x.d,'run',x.input,{summary:'merge',decisions:[{ref:'1',outcome:'merge_into',reason:'same issue',issue_number:4}]});expect(x.gh.comment).toHaveBeenCalledTimes(1);expect(x.gh.createIssue).not.toHaveBeenCalled();
});
it('uses stable source markers after a crash between issue creation and triage',async()=>{
 const {d,input,gh}=await setup();gh.searchOpenIssuesByMarker.mockResolvedValue([{number:9,author:'bot',body:'<!-- panelator-finding:old-run:1 -->'}] as never);
 await applyFilerResult(d,'new-run',input,{summary:'file',decisions:[{ref:'1',outcome:'file',reason:'verified',issue}]});expect(gh.createIssue).not.toHaveBeenCalled();
});
it('escalations are design-flaw issues for spec/question-check, not direct questions',async()=>{
 const {d,input,gh}=await setup();await applyFilerResult(d,'run',input,{summary:'flaw',decisions:[{ref:'1',outcome:'escalate',reason:'design conflict',issue,question:{kind:'technical',question:'Which design?',options:[{label:'fix',cost:'one day'}],recommendation:'fix'}}]});
 expect(gh.createIssue.mock.calls[0]?.[1]).toMatch(/^Possible design flaw/);expect(gh.createIssue.mock.calls[0]?.[1]).toContain('one day');
});
it('allows two abandoned retries, then defers; supports defer, close and rewrite',async()=>{
 const {d,input,paths,gh}=await setup();input.records=[];input.abandoned=[{ref:'issue:7',issue:{number:7} as never,comments:[],ledgers:[],retries:0}];
 let at=new Date('2026-10-01');d.now=()=>at;
 for(let i=0;i<3;i++){await applyFilerResult(d,`run-${i}`,input,{summary:'retry',decisions:[{ref:'issue:7',outcome:'retry',reason:'Use the new design this time'}]});at=new Date(at.getTime()+8*86400000);}
 expect(gh.removeLabel).toHaveBeenCalledTimes(2);expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>t.outcome)).toEqual(['retry','retry','defer']);
 for(const outcome of ['defer','close','rewrite'] as const){at=new Date(at.getTime()+8*86400000);await applyFilerResult(d,outcome,input,{summary:outcome,decisions:[{ref:'issue:7',outcome,reason:'reason',issue}]});}
 expect(gh.closeIssue).toHaveBeenCalledTimes(2);
});
it('marks repeat discards with the earlier reason',async()=>{
 const {d,input,paths}=await setup();await applyFilerResult(d,'run',input,{summary:'discard',decisions:[{ref:'1',outcome:'discard',reason:'already fixed'}]});
 await appendFile(paths.findingsQueue,JSON.stringify({finding})+'\n'+JSON.stringify({finding})+'\n');
 const next=await buildFilerInput(d);expect(next.records[0].ref).toBe('2');expect(next.records[0].repeat).toBe('already fixed');
});
