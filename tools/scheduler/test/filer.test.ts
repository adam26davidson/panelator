import {it,expect,vi} from 'vitest';
import {mkdtemp,appendFile,readFile,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {GitHubClient} from '../src/github/client.ts';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {buildFilerInput,readJsonLines,type FilerDeps,type FilerInput,type TriageEntry} from '../src/filer/input.ts';
import {applyFilerResult,resolveClass,type Decision} from '../src/filer/apply.ts';
// A pass-through, so a test can crash the triage log between two writes (spec 019 AC-2).
vi.mock('node:fs/promises',async(orig)=>{const m=await orig<typeof import('node:fs/promises')>();return {...m,appendFile:vi.fn(m.appendFile)};});
const finding={what:'A verified bug',where:'file.ts',evidence:'reproduced',noticed_how:'test'};
const issue={title:'Bug',body:'Verified details\nSpec: no-smuggled-spec',class:'class:bug'};
async function setup(){
 const paths=statePaths(await mkdtemp(join(tmpdir(),'filer-')));await ensureStateDirs(paths);
 const gh={listOpenIssuesByLabel:vi.fn(async()=>[]),listOpenIssuesByAuthor:vi.fn(async()=>[]),searchOpenIssuesByMarker:vi.fn(async()=>[]),listComments:vi.fn(async()=>[]),createIssue:vi.fn(async(_title:string,_body:string,_labels:string[])=>42),comment:vi.fn(async()=>({id:1})),removeLabel:vi.fn(async()=>{}),closeIssue:vi.fn(async()=>{}),findDraftSecurityAdvisory:vi.fn(async():Promise<string|null>=>null),createDraftSecurityAdvisory:vi.fn(async()=> 'GHSA-private')};
 const notify=vi.fn(async()=>{}),now=()=>new Date('2026-10-27T00:00:00Z');
 const d:FilerDeps={paths,gh:gh as unknown as GitHubClient,botLogin:'bot',classes:['class:bug'],notify,now};
 const input:FilerInput={records:[{ref:'1',finding}],abandoned:[],open_issues:[],cursor:0,issue_classes:['class:bug']};
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
const capIssue={number:42,author:'bot',title:'The GitHub App cannot create draft security advisories',body:'Capability needed\n\n<!-- panelator-capability:security-advisories -->'};
const denied=(extra='')=>Object.assign(new Error(`Resource not accessible by integration${extra}`),{status:403});
const advisory={title:'Secret title',description:'Secret description',severity:'high' as const};
const secret={...finding,what:'Token leaks in logs',evidence:'secret-evidence',security:true};
async function securitySetup(findings:object[]){
 const x=await setup();x.d.classes=['class:bug','class:tooling'];await queue(x.paths,findings);
 let at=new Date('2026-10-27T00:00:00Z');x.d.now=()=>at;
 const clock={plus:(ms:number)=>{at=new Date(at.getTime()+ms);}};
 const run=async(i:number|string,outcome:Decision['outcome']='security')=>{const input=await buildFilerInput(x.d);await applyFilerResult(x.d,`run-${i}`,input,{summary:'s',decisions:input.records.map(r=>({ref:r.ref,outcome,reason:'private',advisory,issue,issue_number:4,question:{kind:'technical' as const,question:'q?',options:[{label:'a',cost:'b'}],recommendation:'a'}}))});return input;};
 return {...x,clock,run};
}
it.each(['file','merge_into','escalate'] as const)('a retried advisory stays private when the filer now says %s (review 1)',async(outcome)=>{
 // The model judged it security without the queue flag; its advisory failed once.
 const {paths,gh,run}=await securitySetup([finding]);
 await appendFile(paths.findingsTriage,row('1',{outcome:'security',failed:true,attempt:1,failure:'permission'}));
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:4,title:'t',labels:[]}] as never);
 const input=await run(0,outcome);expect(input.records[0]).toMatchObject({ref:'1',advisory_failed:true});
 expect(gh.createIssue).not.toHaveBeenCalled();expect(gh.comment).not.toHaveBeenCalled();expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'1',outcome:'security',advisory:'GHSA-private'});
});
it('holds a permission failure after three attempts and raises one content-free capability issue (AC-5, AC-6)',async()=>{
 const {paths,gh,notify,run}=await securitySetup([secret,{...secret,what:'Second leak'}]);
 // A 403 whose message echoes payload text: only the status and a fixed phrase may go public (review 3).
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied(': Secret title'));
 expect((await run(0)).records.map(r=>r.ref)).toEqual(['1','2']);
 expect((await run(1)).records.map(r=>[r.ref,r.advisory_attempts])).toEqual([['1',1],['2',1]]);
 expect(gh.createIssue).not.toHaveBeenCalled();
 // The listing stays empty: the issue created for ref 1 is remembered for ref 2 in the same batch (review 4).
 gh.searchOpenIssuesByMarker.mockResolvedValue([]);
 await run(2);
 const triage=await readJsonLines<TriageEntry>(paths.findingsTriage);
 expect(triage.slice(-2)).toEqual([expect.objectContaining({ref:'1',failed:true,attempt:3,held:true,capability_issue:42}),expect.objectContaining({ref:'2',held:true,capability_issue:42})]);
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 const [title,body,labels]=gh.createIssue.mock.calls[0];
 const filedEvents=(await Promise.all((await readdir(paths.events)).filter(f=>f.endsWith('.jsonl')).map(f=>readFile(join(paths.events,f),'utf8')))).join('\n').split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(e=>e.kind==='issue.filed');
 expect(filedEvents).toHaveLength(1);expect(filedEvents[0].payload).toMatchObject({number:42,class:'class:tooling',marker:expect.stringContaining('panelator-capability')});
 expect(labels).toEqual(['class:tooling','validated']);expect(body).toContain('<!-- panelator-capability:security-advisories -->');expect(body).toMatch(/kind `capability`/);expect(body).toContain('HTTP 403');
 for(const text of ['Token leaks','Second leak','secret-evidence','Secret title','Secret description'])expect(title+body).not.toContain(text);
 const held=notify.mock.calls.map(c=>String((c as unknown[])[0])).filter(t=>t.includes('held'));
 expect(held).toHaveLength(2);expect(held[0]).toContain('Secret title');
});
it('holds other advisory errors privately, with no capability issue (review 3)',async()=>{
 const {paths,gh,notify,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValueOnce(denied()).mockRejectedValue(Object.assign(new Error('Validation failed: Secret title'),{status:422}));
 // Every failure counts toward the bound; the kind of the holding failure decides whether an issue is filed (round 2, 3).
 for(let i=0;i<3;i++)await run(i);
 const last=(await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1);
 expect(last).toMatchObject({ref:'1',attempt:3,held:true,failure:'error'});expect(last?.capability_issue).toBeUndefined();
 expect(gh.createIssue).not.toHaveBeenCalled();
 expect(String((notify.mock.calls.at(-1) as unknown[]|undefined)?.[0])).toMatch(/held.*Secret title/);
});
it('probes one held ref a day while the capability issue is open, re-holding on the first failure (review 2, 5)',async()=>{
 const {d,paths,gh,notify,clock,run}=await securitySetup([secret,{...secret,what:'Second leak'}]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)await run(i);
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:'cap',labels:[]}] as never);
 gh.searchOpenIssuesByMarker.mockResolvedValue([capIssue] as never);
 expect((await buildFilerInput(d)).records).toEqual([]);
 clock.plus(25*3600000);
 const probe=await buildFilerInput(d);expect(probe.records.map(r=>[r.ref,r.advisory_attempts])).toEqual([['1',2]]);
 const notes=notify.mock.calls.length;
 await applyFilerResult(d,'probe',probe,{summary:'s',decisions:[{ref:'1',outcome:'security',reason:'private',advisory}]});
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'1',attempt:3,held:true,capability_issue:42});
 expect(gh.createIssue).toHaveBeenCalledTimes(1);expect(notify.mock.calls.length).toBe(notes);
 // The next probe is the other ref; once the issue closes, every held ref is offered, each re-held by one failure.
 expect((await buildFilerInput(d)).records.map(r=>r.ref)).toEqual(['2']);
 gh.listOpenIssuesByAuthor.mockResolvedValue([]);
 expect((await buildFilerInput(d)).records.map(r=>[r.ref,r.advisory_attempts])).toEqual([['1',2],['2',2]]);
 // A probe that succeeds closes the capability issue once, listing it once per batch (review 6).
 gh.createDraftSecurityAdvisory.mockResolvedValue('GHSA-ok');gh.searchOpenIssuesByMarker.mockClear();
 await run('ok');
 expect(gh.searchOpenIssuesByMarker).toHaveBeenCalledTimes(1);expect(gh.closeIssue).toHaveBeenCalledTimes(1);expect(gh.closeIssue.mock.calls[0]).toEqual([42,'']);expect(gh.comment).toHaveBeenCalledWith(42,expect.stringMatching(/advisor/i));
 expect((await buildFilerInput(d)).records).toEqual([]);
});
it('a successful advisory with no held row does not list issues (review 6)',async()=>{
 const {gh,run}=await securitySetup([secret]);
 await run(0);expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);expect(gh.searchOpenIssuesByMarker).not.toHaveBeenCalled();
});
it('the last held ref succeeding still closes the capability issue (review 6)',async()=>{
 const {gh,clock,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)await run(i);
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:'cap',labels:[]}] as never);
 gh.searchOpenIssuesByMarker.mockResolvedValue([capIssue] as never);
 clock.plus(25*3600000);gh.createDraftSecurityAdvisory.mockResolvedValue('GHSA-ok');
 expect((await run('probe')).records.map(r=>r.ref)).toEqual(['1']);
 expect(gh.closeIssue).toHaveBeenCalledWith(42,'');expect(gh.comment).toHaveBeenCalledWith(42,expect.stringMatching(/advisor/i));
});
// Review round 2.
const failing=(status:number,message:string,headers:Record<string,string>={})=>Object.assign(new Error(message),{status,response:{headers}});
it('a held ref stays held when the failure kind changes, keeping its capability issue (round 2, 3)',async()=>{
 const {d,paths,gh,clock,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)await run(i);
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:capIssue.title,labels:[]}] as never);
 gh.searchOpenIssuesByMarker.mockResolvedValue([capIssue] as never);
 clock.plus(25*3600000);gh.createDraftSecurityAdvisory.mockRejectedValue(failing(502,'Bad gateway'));
 expect((await run('probe')).records.map(r=>r.ref)).toEqual(['1']);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'1',held:true,failure:'error',capability_issue:42,attempt:3});
 expect((await buildFilerInput(d)).records).toEqual([]);
});
it('alternating failure kinds still reach the hold (round 2, 3)',async()=>{
 const {paths,gh,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValueOnce(denied()).mockRejectedValueOnce(failing(502,'Bad gateway')).mockRejectedValueOnce(denied());
 for(let i=0;i<3;i++)await run(i);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'1',attempt:3,held:true,failure:'permission',capability_issue:42});
});
it.each([
 ['a secondary rate limit',failing(403,'You have exceeded a secondary rate limit')],
 ['a 403 with retry-after',failing(403,'Forbidden',{'retry-after':'60'})],
])('%s is not a missing permission (round 2, 5)',async(_name,error)=>{
 const {paths,gh,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(error);
 for(let i=0;i<3;i++)await run(i);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({held:true,failure:'error'});
 expect(gh.createIssue).not.toHaveBeenCalled();
});
it('the capability marker cannot be smuggled into filed issues or merge comments, and only the fixed title counts (round 2, 2)',async()=>{
 const {d,input,gh}=await setup();const smuggled='<!-- panelator-capability:security-advisories -->';
 input.records=[{ref:'1',finding:{...finding,what:`x ${smuggled}`}},{ref:'2',finding:{...finding,what:`y ${smuggled}`}}];
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:4}] as never);
 await applyFilerResult(d,'run',input,{summary:'s',decisions:[{ref:'1',outcome:'file',reason:`ok ${smuggled}`,issue:{...issue,body:`body ${smuggled}`}},{ref:'2',outcome:'merge_into',reason:`same ${smuggled}`,issue_number:4}]});
 expect(gh.createIssue.mock.calls[0][1]).not.toContain('<!-- panelator-capability:');expect(String((gh.comment.mock.calls[0] as unknown[])[1])).not.toContain('<!-- panelator-capability:');
 // A bot issue carrying the marker under another title is not the capability issue.
 const x=await securitySetup([secret]);x.gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 x.gh.searchOpenIssuesByMarker.mockResolvedValue([{...capIssue,number:9,title:'Some finding'}] as never);
 for(let i=0;i<3;i++)await x.run(i);
 expect(x.gh.createIssue).toHaveBeenCalledTimes(1);expect((await readJsonLines<TriageEntry>(x.paths.findingsTriage)).at(-1)?.capability_issue).toBe(42);
});
it('discarding the last held ref closes the capability issue; a close already commented is not commented again (round 2, nits)',async()=>{
 const {d,gh,clock,run}=await securitySetup([secret]);
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)await run(i);
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:capIssue.title,labels:[]}] as never);
 gh.searchOpenIssuesByMarker.mockResolvedValue([capIssue] as never);
 clock.plus(25*3600000);
 gh.listComments.mockResolvedValue([{body:'done <!-- panelator-capability-closed -->'}] as never);
 const probe=await buildFilerInput(d);
 await applyFilerResult(d,'discard',probe,{summary:'s',decisions:[{ref:'1',outcome:'discard',reason:'false positive'}]});
 expect(gh.closeIssue).toHaveBeenCalledWith(42,'');expect(gh.comment).not.toHaveBeenCalled();
});
// Spec 018: the filer's class labels.
const live=['class:product','class:bug','class:tooling','class:dependency'];
it('lists the accepted class labels in the filer input (AC-1)',async()=>{
 const {d,paths}=await setup();d.classes=live;await queue(paths,[finding]);
 expect((await buildFilerInput(d)).issue_classes).toEqual(live);
});
it('applies the live batch shape: "tooling" without the prefix on file and merge_into decisions (AC-2 regression)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;
 input.records=[{ref:'16',finding},{ref:'17',finding},{ref:'18',finding}];
 const tooling={title:'Tooling gap',body:'what, where, evidence',class:'tooling'};
 await applyFilerResult(d,'run',input,{summary:'live',decisions:[
  {ref:'16',outcome:'file',reason:'verified',issue:tooling},
  {ref:'17',outcome:'merge_into',reason:'same as #32',issue_number:32,issue:tooling},
  {ref:'18',outcome:'file',reason:'verified',issue:{...tooling,class:'Class:Dependency'}},
 ]});
 expect(gh.createIssue.mock.calls.map(c=>c[2])).toEqual([['class:tooling','validated'],['class:tooling','validated'],['class:dependency','validated']]);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>t.ref)).toEqual(['16','17','18']);
});
it('resolves case and whitespace differences, exact labels first (AC-2)',async()=>{
 const {d,input,gh}=await setup();d.classes=live;
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'v',issue:{...issue,class:' BUG '}}]});
 expect(gh.createIssue.mock.calls[0][2]).toEqual(['class:bug','validated']);
});
it('an unresolvable class falls back to class:bug, is logged, and the rest of the batch applies (AC-3)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;const log=vi.fn();d.log=log;
 input.records=[{ref:'1',finding},{ref:'2',finding}];
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[
  {ref:'1',outcome:'file',reason:'v',issue:{...issue,class:'class:security-ish'}},
  {ref:'2',outcome:'file',reason:'v',issue:{...issue,class:'class:tooling'}},
 ]});
 expect(gh.createIssue.mock.calls.map(c=>c[2][0])).toEqual(['class:bug','class:tooling']);
 expect(log).toHaveBeenCalledWith(expect.objectContaining({kind:'filer-class-fallback',ref:'1',class:'class:security-ish',used:'class:bug'}));
 expect(log).toHaveBeenCalledTimes(1);
 const rows=await readJsonLines<TriageEntry>(paths.findingsTriage);
 expect(rows[0].reason).toContain("class 'class:security-ish' is not configured");expect(rows).toHaveLength(2);
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(2);
});
it('without class:bug configured the fallback is the first configured class (AC-3)',async()=>{
 const {d,input,gh}=await setup();d.classes=['class:product','class:tooling'];
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'v',issue:{...issue,class:'bug'}}]});
 expect(gh.createIssue.mock.calls[0][2]).toEqual(['class:product','validated']);
});
it('a value matching two labels is not resolved; an exact match wins (AC-2, review)',()=>{
 const twins=['class:product','class:Tooling','class:tooling'];
 expect(resolveClass('TOOLING',twins)).toBeNull();
 expect(resolveClass('class:Tooling',twins)).toBe('class:Tooling');
 expect(resolveClass('class:tooling',twins)).toBe('class:tooling');
 expect(resolveClass('product',twins)).toBe('class:product');
});
it('an ambiguous class falls back on apply (AC-2, AC-3, review)',async()=>{
 const {d,input,gh}=await setup();d.classes=['class:product','class:Tooling','class:tooling'];
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'v',issue:{...issue,class:'TOOLING'}}]});
 expect(gh.createIssue.mock.calls[0][2]).toEqual(['class:product','validated']);
});
it('falls back on escalate and rewrite too, logging each (AC-3, review)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;const log=vi.fn();d.log=log;
 input.abandoned=[{ref:'issue:7',issue:{number:7} as never,comments:[],ledgers:[],retries:0}];
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[
  {ref:'1',outcome:'escalate',reason:'flaw',issue:{...issue,class:'nope'},question:{kind:'technical',question:'Which?',options:[{label:'a',cost:'small'}],recommendation:'a'}},
  {ref:'issue:7',outcome:'rewrite',reason:'rewrite it',issue:{...issue,class:'nope'}},
 ]});
 expect(gh.createIssue.mock.calls.map(c=>c[2][0])).toEqual(['class:bug','class:bug']);
 expect(log.mock.calls.map(c=>c[0].ref)).toEqual(['1','issue:7']);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).every(t=>t.reason.includes("class 'nope' is not configured"))).toBe(true);
});
it('a bad class on a discard, security or merge into an open issue is not used, annotated or logged (AC-3, review)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;const log=vi.fn();d.log=log;
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:32}] as never);
 // Distinct findings: a finding judged security once keeps every later record of it private (spec 019 AC-2).
 input.records=[{ref:'1',finding},{ref:'2',finding:{...finding,what:'two'}},{ref:'3',finding:{...finding,what:'three'}}];
 const bad={...issue,class:'nope'};
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[
  {ref:'1',outcome:'discard',reason:'no',issue:bad},
  {ref:'2',outcome:'security',reason:'private',issue:bad,advisory:{title:'S',description:'D',severity:'low'}},
  {ref:'3',outcome:'merge_into',reason:'same as #32',issue_number:32,issue:bad},
 ]});
 expect(log).not.toHaveBeenCalled();expect(gh.createIssue).not.toHaveBeenCalled();
 expect(gh.comment).toHaveBeenCalledTimes(1);expect((gh.comment.mock.calls[0] as unknown as [number,string])[1]).not.toContain('not configured');
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).some(t=>t.reason.includes('not configured'))).toBe(false);
});
it('a confidential record with an unresolvable class still gets its advisory, no issue and no fallback (AC-3, review)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;const log=vi.fn();d.log=log;
 input.records[0].finding={...finding,security:true};
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'v',issue:{...issue,class:'nope'}}]});
 expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);expect(gh.createIssue).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage))[0].reason).not.toContain('not configured');
});
it('logs a fallback only for decisions applied: not for settled refs nor after a mid-batch abort (AC-3, review)',async()=>{
 const {d,input,gh,paths}=await setup();d.classes=live;const log=vi.fn();d.log=log;
 input.records=[{ref:'1',finding},{ref:'2',finding},{ref:'3',finding}];
 await appendFile(paths.findingsTriage,row('1'));
 gh.createIssue.mockResolvedValueOnce(42).mockRejectedValueOnce(new Error('boom'));
 const bad={...issue,class:'nope'};
 await expect(applyFilerResult(d,'run',input,{summary:'x',decisions:['1','2','3'].map(ref=>({ref,outcome:'file' as const,reason:'v',issue:bad}))})).rejects.toThrow('boom');
 expect(log.mock.calls.map(c=>c[0].ref)).toEqual(['2']);
});
// Spec 019 (issue #63).
const loop={what:'standing agent findings-filer failed twice',where:'agents/standing/findings-filer.md',evidence:'rate limited (429)',noticed_how:'standing run retry exhausted'};
const queued=(f:object,i:number,extra:object={})=>JSON.stringify({issue:0,stage:'findings-filer',run_id:`run-${i}`,timestamp:new Date(Date.UTC(2026,9,28,0,i)).toISOString(),finding:f,...extra})+'\n';
it('collapses the live shape: hundreds of identical copies take one batch place (AC-1 regression)',async()=>{
 const {d,paths}=await setup();
 let text='';for(let i=0;i<300;i++)text+=queued(loop,i);for(let i=0;i<5;i++)text+=queued({...finding,what:`real ${i}`},300+i,{issue:13,stage:'review'});
 // A copy whose finding lists its fields in another order is still the same record.
 text+=queued({noticed_how:loop.noticed_how,evidence:loop.evidence,where:loop.where,what:loop.what},400);
 await appendFile(paths.findingsQueue,text);
 const input=await buildFilerInput(d);
 expect(input.records.map(r=>r.ref)).toEqual(['1','301','302','303','304','305']);
 expect(input.records[0].duplicate_refs).toEqual([...Array.from({length:299},(_,i)=>String(i+2)),'306']);
 expect(input.records[1].duplicate_refs).toBeUndefined();
 await applyFilerResult(d,'run',input,{summary:'x',decisions:input.records.map(r=>({ref:r.ref,outcome:'discard' as const,reason:'fixed by spec 013'}))});
 const triage=await readJsonLines<TriageEntry>(paths.findingsTriage);
 expect(triage).toHaveLength(306);expect(triage.find(t=>t.ref==='306')).toMatchObject({outcome:'discard',reason:'same record as ref 1: fixed by spec 013',run_id:'run'});
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(306);
 expect((await buildFilerInput(d)).records).toEqual([]);
});
it('records differing in anything but run and time stay separate; settled copies are not listed (AC-1)',async()=>{
 const {d,paths}=await setup();
 await appendFile(paths.findingsQueue,queued(loop,0)+queued({...loop,evidence:'other'},1)+queued(loop,2,{issue:7})+queued(loop,3)+queued(loop,4));
 await appendFile(paths.findingsTriage,row('4'));
 const input=await buildFilerInput(d);
 expect(input.records.map(r=>[r.ref,r.duplicate_refs])).toEqual([['1',['5']],['2',undefined],['3',undefined]]);
});
it('the batch fills with distinct records and copies past the batch still ride on their entry (AC-1)',async()=>{
 const {d,paths}=await setup();
 let text='';for(let i=0;i<25;i++)text+=queued({...finding,what:String(i)},i);text+=queued({...finding,what:'0'},25);
 await appendFile(paths.findingsQueue,text);
 const input=await buildFilerInput(d);
 expect(input.records).toHaveLength(20);expect(input.records[0].duplicate_refs).toEqual(['26']);expect(input.records.at(-1)!.ref).toBe('20');
});
it('a filed entry settles its copies onto the same issue with one GitHub issue (AC-2)',async()=>{
 const {d,paths,gh}=await setup();
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1)+queued(finding,2));
 const input=await buildFilerInput(d);
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'verified',issue}]});
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>[t.ref,t.outcome,t.issue])).toEqual([['1','file',42],['2','file',42],['3','file',42]]);
});
it('a failed advisory settles no copies; they ride on its retry and settle when it succeeds (AC-2)',async()=>{
 const {d,paths,gh}=await setup();
 await appendFile(paths.findingsQueue,queued(secret,0)+queued(secret,1));
 gh.createDraftSecurityAdvisory.mockRejectedValueOnce(new Error('boom'));
 const first=await buildFilerInput(d);expect(first.records[0].duplicate_refs).toEqual(['2']);
 await applyFilerResult(d,'run-1',first,{summary:'x',decisions:[{ref:'1',outcome:'security',reason:'private',advisory}]});
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>t.ref)).toEqual(['1']);
 const retry=await buildFilerInput(d);expect(retry.records).toHaveLength(1);expect(retry.records[0]).toMatchObject({ref:'1',advisory_failed:true,duplicate_refs:['2']});
 await applyFilerResult(d,'run-2',retry,{summary:'x',decisions:[{ref:'1',outcome:'security',reason:'private',advisory}]});
 expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(2);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'2',outcome:'security',advisory:'GHSA-private'});
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(2);
});
it('decisions cover entries only: a decision for a duplicate ref is refused (AC-3)',async()=>{
 const {d,paths}=await setup();await appendFile(paths.findingsQueue,queued(loop,0)+queued(loop,1));
 const input=await buildFilerInput(d);
 await expect(applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'1',outcome:'discard',reason:'a'},{ref:'2',outcome:'discard',reason:'b'}]})).rejects.toThrow(/each input/);
 expect(await readFile(join(import.meta.dirname,'../../../agents/standing/findings-filer.md'),'utf8')).toMatch(/duplicate_refs[\s\S]*settles them all/);
});
it('copies of a held advisory are not sent on their own; they ride on its probe and settle privately (AC-1, review 1)',async()=>{
 // The model judged the record security without the queue flag, so only its failed advisory keeps the copies private.
 const {paths,gh,clock,run}=await securitySetup([]);
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1)+queued(finding,2));
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)expect((await run(i)).records.map(r=>[r.ref,r.duplicate_refs])).toEqual([['1',['2','3']]]);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'1',held:true,capability_issue:42});
 gh.listOpenIssuesByAuthor.mockResolvedValue([{number:42,title:capIssue.title,labels:[]}] as never);
 gh.searchOpenIssuesByMarker.mockResolvedValue([capIssue] as never);
 expect((await run(3,'file')).records).toEqual([]);
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 clock.plus(25*3600000);gh.createDraftSecurityAdvisory.mockResolvedValue('GHSA-ok');
 expect((await run('probe','file')).records).toEqual([expect.objectContaining({ref:'1',advisory_failed:true,duplicate_refs:['2','3']})]);
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).slice(-3).map(t=>[t.ref,t.outcome,t.advisory,!!t.failed])).toEqual([['1','security','GHSA-ok',false],['2','security','GHSA-ok',false],['3','security','GHSA-ok',false]]);
 expect(JSON.parse(await readFile(paths.findingsCursor,'utf8')).line).toBe(3);
});
it('copies of a held advisory released with its capability issue ride on the release (AC-1, review 1)',async()=>{
 const {d,paths,gh,run}=await securitySetup([]);
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1));
 gh.createDraftSecurityAdvisory.mockRejectedValue(denied());
 for(let i=0;i<3;i++)await run(i);
 // The maintainer answered: the capability issue is closed and every held ref is released at once (spec 014 AC-8).
 expect((await buildFilerInput(d)).records).toEqual([expect.objectContaining({ref:'1',advisory_failed:true,duplicate_refs:['2']})]);
});
it('an entry and its copies are kept by one write, so a crash cannot split them (AC-2, review 2)',async()=>{
 const {d,paths,gh}=await setup();
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1)+queued(finding,2));
 const real=(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).appendFile;
 let writes=0;vi.mocked(appendFile).mockImplementation(async(...a:Parameters<typeof real>)=>{if(a[0]===paths.findingsTriage&&++writes>1)throw new Error('crash');return real(...a);});
 try{await applyFilerResult(d,'run',await buildFilerInput(d),{summary:'x',decisions:[{ref:'1',outcome:'file',reason:'verified',issue}]});}
 catch{/* the crash */}
 finally{vi.mocked(appendFile).mockImplementation(real);}
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>[t.ref,t.issue])).toEqual([['1',42],['2',42],['3',42]]);
 expect((await buildFilerInput(d)).records).toEqual([]);expect(gh.createIssue).toHaveBeenCalledTimes(1);
});
it('a record identical to one already judged security stays private (AC-2, review 2)',async()=>{
 // A copy queued after its entry settled is an entry of its own; it carries no flag and no failed advisory.
 const {d,paths,gh}=await setup();
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1));
 await appendFile(paths.findingsTriage,row('1',{outcome:'security',advisory:'GHSA-old',finding}));
 const input=await buildFilerInput(d);expect(input.records.map(r=>[r.ref,r.advisory_failed])).toEqual([['2',undefined]]);
 await applyFilerResult(d,'run',input,{summary:'x',decisions:[{ref:'2',outcome:'file',reason:'public?',issue}]});
 expect(gh.createIssue).not.toHaveBeenCalled();expect(gh.createDraftSecurityAdvisory).toHaveBeenCalledTimes(1);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).at(-1)).toMatchObject({ref:'2',outcome:'security',advisory:'GHSA-private'});
});
it('merge_into settles copies onto the open target, or onto the fallback issue when it is closed (AC-2, review 4)',async()=>{
 for(const open of [true,false]) {
  const {d,paths,gh}=await setup();
  await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1)+queued(finding,2));
  if(open)gh.listOpenIssuesByAuthor.mockResolvedValue([{number:4,title:'t',labels:[]}] as never);
  await applyFilerResult(d,'run',await buildFilerInput(d),{summary:'x',decisions:[{ref:'1',outcome:'merge_into',reason:'same bug',issue_number:4,issue}]});
  const want=open?['merge_into',4]:['file',42];
  expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>[t.ref,t.outcome,t.issue])).toEqual(['1','2','3'].map(r=>[r,...want]));
  expect(gh.comment).toHaveBeenCalledTimes(open?1:0);expect(gh.createIssue).toHaveBeenCalledTimes(open?0:1);
 }
});
it('an escalation settles its copies onto the one design-flaw issue (AC-2, review 4)',async()=>{
 const {d,paths,gh}=await setup();
 await appendFile(paths.findingsQueue,queued(finding,0)+queued(finding,1));
 await applyFilerResult(d,'run',await buildFilerInput(d),{summary:'x',decisions:[{ref:'1',outcome:'escalate',reason:'flaw',issue,question:{kind:'technical',question:'q?',options:[{label:'a',cost:'b'}],recommendation:'a'}}]});
 expect(gh.createIssue).toHaveBeenCalledTimes(1);
 expect((await readJsonLines<TriageEntry>(paths.findingsTriage)).map(t=>[t.ref,t.outcome,t.issue])).toEqual([['1','escalate',42],['2','escalate',42]]);
});
