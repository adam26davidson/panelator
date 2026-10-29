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
// Spec 014 (issues #33 and #26).
const queue=async(paths:{findingsQueue:string},findings:object[])=>{for(const f of findings)await appendFile(paths.findingsQueue,JSON.stringify({finding:f})+'\n');};
const row=(ref:string,extra:Partial<TriageEntry>={})=>JSON.stringify({ref,outcome:'discard',reason:'r',run_id:'old',at:'2026-10-26T00:00:00Z',...extra})+'\n';
it('lists a failed advisory still inside the cursor window once (#33 regression, AC-1, AC-2)',async()=>{
 const {d,paths}=await setup();
 await queue(paths,Array.from({length:25},(_,i)=>({...finding,what:String(i),security:i===2})));
 // Refs 1 to 3 were settled by a batch that aborted before the cursor was written; ref 3's advisory failed.
 await appendFile(paths.findingsTriage,row('1')+row('2')+row('3',{outcome:'security',failed:true,attempt:1,reason:'advisory failed: Resource not accessible by integration'}));
 const input=await buildFilerInput(d);const refs=input.records.map(r=>r.ref);
 expect(new Set(refs).size).toBe(refs.length);expect(refs).toHaveLength(20);
 expect(refs.filter(r=>r==='3')).toHaveLength(1);expect(refs).not.toContain('1');expect(refs).not.toContain('2');
 expect(input.records.find(r=>r.ref==='3')).toMatchObject({advisory_failed:true,advisory_attempts:1});
 expect(input.cursor).toBe(3);expect(refs.slice(1)).toEqual(Array.from({length:19},(_,i)=>String(i+4)));
 await applyFilerResult(d,'run',input,{summary:'x',decisions:refs.map(ref=>({ref,outcome:'discard' as const,reason:'not an issue'}))});
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(22);
});
it('accepts one decision per distinct ref and refuses a repeated decision (AC-3)',async()=>{
 const {d,input}=await setup();input.records=[{ref:'1',finding},{ref:'1',finding,advisory_failed:true}];
 await expect(applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'discard',reason:'a'},{ref:'1',outcome:'discard',reason:'b'}]})).rejects.toThrow(/each input/);
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'discard',reason:'a'}]});
});
it('moves the cursor past the applied part of a batch aborted half way (AC-4)',async()=>{
 const {d,paths,gh}=await setup();await queue(paths,[finding,{...finding,what:'b'},{...finding,what:'c'}]);
 gh.createIssue.mockResolvedValueOnce(42).mockRejectedValueOnce(new Error('issue list incomplete: got 6, server reports 7'));
 const input=await buildFilerInput(d);
 await expect(applyFilerResult(d,'run',input,{summary:'x',decisions:input.records.map(r=>({ref:r.ref,outcome:'file' as const,reason:'verified',issue}))})).rejects.toThrow(/incomplete/);
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(1);
 expect((await buildFilerInput(d)).records.map(r=>r.ref)).toEqual(['2','3']);
});
it('holds an advisory after three failures and raises one content-free capability issue (AC-5, AC-6)',async()=>{
 const {d,paths,gh,notify}=await setup();d.classes=['class:bug','class:tooling'];
 const secret={...finding,what:'Token leaks in logs',evidence:'secret-evidence',security:true};await queue(paths,[secret,{...secret,what:'Second leak'}]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(new Error('Resource not accessible by integration'));
 let at=new Date('2026-10-27T00:00:00Z');d.now=()=>at;
 const advisory={title:'Secret title',description:'Secret description',severity:'high' as const};
 const run=async(i:number)=>{const input=await buildFilerInput(d);await applyFilerResult(d,`run-${i}`,input,{summary:'s',decisions:input.records.map(r=>({ref:r.ref,outcome:'security' as const,reason:'private',advisory}))});return input;};
 const first=await run(0);expect(first.records.map(r=>r.ref)).toEqual(['1','2']);
 expect((await run(1)).records.map(r=>[r.ref,r.advisory_attempts])).toEqual([['1',1],['2',1]]);
 expect(gh.createIssue).not.toHaveBeenCalled();
 // The first hold files the capability issue; the second finds it by its marker.
 gh.searchOpenIssuesByMarker.mockImplementation(async()=>gh.createIssue.mock.calls.length&&!gh.closeIssue.mock.calls.length?[{number:42,author:'bot',body:'<!-- panelator-capability:security-advisories -->'}] as never:[]);
 await run(2);
 const triage=await readJsonLines<TriageEntry>(paths.findingsTriage);
 expect(triage.slice(-2)).toEqual([expect.objectContaining({ref:'1',failed:true,attempt:3,held:true,capability_issue:42}),expect.objectContaining({ref:'2',held:true,capability_issue:42})]);
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 const [title,body,labels]=gh.createIssue.mock.calls[0];
 expect(labels).toEqual(['class:tooling','validated']);expect(body).toContain('<!-- panelator-capability:security-advisories -->');expect(body).toMatch(/kind `capability`/);expect(body).toContain('Resource not accessible by integration');
 for(const text of ['Token leaks','Second leak','secret-evidence','Secret title','Secret description'])expect(title+body).not.toContain(text);
 expect(notify.mock.calls.filter(c=>String((c as unknown[])[0]).includes('held'))).toHaveLength(2);
 // While the capability issue is open and the hold is fresh, the refs are not offered.
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:'cap',labels:[]}] as never);
 expect((await buildFilerInput(d)).records).toEqual([]);
 at=new Date(at.getTime()+8*86400000);
 expect((await buildFilerInput(d)).records.map(r=>[r.ref,r.advisory_attempts])).toEqual([['1',0],['2',0]]);
 at=new Date(at.getTime()-8*86400000);gh.listOpenIssuesByAuthor.mockResolvedValue([]);
 const released=await buildFilerInput(d);expect(released.records.map(r=>r.ref)).toEqual(['1','2']);
 // A success while the issue is open closes it.
 gh.createDraftSecurityAdvisory.mockResolvedValue('GHSA-ok');
 await applyFilerResult(d,'run-ok',released,{summary:'s',decisions:released.records.map(r=>({ref:r.ref,outcome:'security' as const,reason:'private',advisory}))});
 expect(gh.closeIssue).toHaveBeenCalledTimes(1);expect(gh.closeIssue.mock.calls[0]).toEqual([42,expect.stringMatching(/advisor/i)]);
 expect((await buildFilerInput(d)).records).toEqual([]);
});
