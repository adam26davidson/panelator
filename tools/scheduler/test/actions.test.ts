import {it,expect} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {ParameterStore} from '../src/parameters/store.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ActionLog} from '../src/actions/log.ts';
import {readAgentState,writeAgentState} from '../src/standing/state.ts';
import {readJsonLines} from '../src/filer/input.ts';
import {readdirSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {buildAuditInput} from '../src/standing/audit-input.ts';
import {applyAction,KINDS,registryActionsCheck,loadActionLevels,type ActionContext} from '../src/actions/index.ts';
it('logs allowed actions, refuses locks and permissions, undoes and recovers pending',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'actions-'))); await ensureStateDirs(paths);
 const log=new ActionLog(paths.actionsLog,paths); const parameters=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},{}));
 const ctx={paths,parameters,log,levels:{set_parameter:1,undo:1},now:()=>new Date(),gh:{rerunWorkflowRun:async()=>{},cancelWorkflowRun:async()=>{}}} as ActionContext;
 const req={agent:'test',run_id:'run',kind:'set_parameter',args:{name:'system_work_share',value:0.5},why:'Adjust the balance of system work'};
 const a=await applyAction(ctx,req,['set_parameter']); expect(a.status).toBe('applied');
 expect((await parameters.read('system_work_share')).value).toBe(0.5);
 const u=await applyAction(ctx,{...req,kind:'undo',args:{action_id:a.id}},['undo']); expect(u.status).toBe('applied');
 expect((await parameters.read('system_work_share')).value).toBe(0.75);
 expect((await applyAction(ctx,{...req,kind:'undo',args:{action_id:a.id}},['undo'])).status).toBe('refused');
 expect((await applyAction(ctx,{...req,args:{name:'aws_cap_usd',value:5}},['set_parameter'])).status).toBe('refused');
 expect((await applyAction(ctx,req,[])).status).toBe('refused');
 const pending=await log.writePending({...req,undo:null}); await log.markStalePending(); expect((await log.list()).find(x=>x.id===pending.id)?.status).toBe('failed');
 expect(registryActionsCheck('agents/actions.yaml').sort()).toEqual(Object.keys(KINDS).sort());
 expect(Object.values(KINDS).every(k=>k.changesMode===false)).toBe(true);
});
it('enforces maintainer pauses, run marks, levels, rerun limits and inverse policy',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'actions-')));await ensureStateDirs(paths);
 const log=new ActionLog(paths.actionsLog,paths),parameters=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},{}));
 const calls:string[]=[];const ctx:ActionContext={paths,log,parameters,levels:Object.fromEntries(Object.keys(KINDS).map(k=>[k,1])),now:()=>new Date(),gh:{rerunWorkflowRun:async()=>{calls.push('rerun');},cancelWorkflowRun:async()=>{calls.push('cancel');}}};
 await writeAgentState(paths,'audit',{last_run:null,next_run:null,pending_events:[],paused:false,paused_by:null,failures:0});
 const request=(kind:string,args:Record<string,unknown>,maintainer=false)=>applyAction(ctx,{agent:maintainer?'maintainer':'test',run_id:'run',kind,args,why:'An independently verified operational change'},maintainer?'maintainer':Object.keys(KINDS));
 const paused=await request('pause_agent',{name:'audit'},true);expect(paused.undo).not.toBeNull();
 expect((await request('resume_agent',{name:'audit'})).reason).toContain('maintainer');
 expect((await request('undo',{action_id:paused.id})).status).toBe('refused');
 expect((await request('undo',{action_id:paused.id},true)).status).toBe('applied');
 expect((await readAgentState(paths,'audit'))?.paused).toBe(false);
 const run=await request('run_agent',{name:'audit'});expect(run.status).toBe('applied');expect((await request('undo',{action_id:run.id})).status).toBe('applied');expect((await readAgentState(paths,'audit'))?.next_run).toBeNull();
 const workflow=await request('rerun_workflow',{run_id:7});expect(workflow.status).toBe('applied');expect((await request('rerun_workflow',{run_id:7})).status).toBe('refused');
 expect((await request('undo',{action_id:workflow.id})).status).toBe('applied');expect(calls).toEqual(['rerun','cancel']);
 ctx.levels.set_parameter=2;
 const level=await request('set_parameter',{name:'system_work_share',value:0.4});expect(level.reason).toBe('level 2');expect(await readJsonLines(paths.findingsQueue)).toHaveLength(1);
 expect((await request('unknown',{})).status).toBe('refused');
 expect((await request('run_agent',{name:'audit',previous:'forged'})).status).toBe('refused');
});
it('applyAction is the only writer of the action log',()=>{
 const files:string[]=[];
 for(const dir of ['tools/scheduler/src','tools/scheduler/bin'])for(const f of readdirSync(dir,{recursive:true,encoding:'utf8'})){
  const rel=`${dir}/${f}`;if(rel.endsWith('.ts')&&readFileSync(rel,'utf8').includes('writePending('))files.push(rel);
 }
 expect(files.sort()).toEqual(['tools/scheduler/src/actions/index.ts','tools/scheduler/src/actions/log.ts']);
});
it('audit input: effects carry defined kinds, refusals carry what was asked',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'actions-')));await ensureStateDirs(paths);
 const log=new ActionLog(paths.actionsLog,paths),parameters=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},{}));
 const levels=loadActionLevels('agents/actions.yaml');
 const ctx={paths,parameters,log,levels,now:()=>new Date(),gh:{rerunWorkflowRun:async()=>{},cancelWorkflowRun:async()=>{}}} as ActionContext;
 const req={agent:'test',run_id:'run',kind:'set_parameter',args:{name:'system_work_share',value:0.5},why:'Adjust the balance of system work'};
 const a=await applyAction(ctx,req,['set_parameter']);expect(a.status).toBe('applied');
 expect((await applyAction(ctx,{...req,kind:'undo',args:{action_id:a.id}},['undo'])).status).toBe('applied');
 expect((await applyAction(ctx,{...req,kind:'parameter_mode',args:{name:'system_work_share',mode:'locked'}},['set_parameter'])).status).toBe('refused');
 const input=await buildAuditInput(paths,null,new Date());
 for(const [kind,g] of Object.entries(input.kinds as Record<string,any>))if(g.applied+g.failed+g.undone>0)expect(Object.hasOwn(levels,kind)).toBe(true);
 const g=(input.kinds as any).parameter_mode;
 expect(g).toMatchObject({refused:1,applied:0,failed:0,undone:0});
 expect(g.entries[0].reason).toBe('unknown action kind');
 expect((input.kinds as any).set_parameter.undone).toBe(1);expect((input.kinds as any).undo.applied).toBe(1);
});

it('refuses to log a malformed action row and records nothing (spec 086 AC-8)',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'actions-'))); await ensureStateDirs(paths);
 const log=new ActionLog(paths.actionsLog,paths);
 const req={agent:'test',run_id:'run',kind:'k',args:{},why:'a reason long enough to log'};
 await expect(log.writePending({...req,undo:{kind:'k'} as never})).rejects.toThrow(/^invalid action log entry: \/undo must be null/);
 expect(existsSync(paths.actionsLog)).toBe(false);
 const row=await log.writePending({...req,undo:null});
 const before=readFileSync(paths.actionsLog,'utf8');
 await expect(log.settle(row.id,'applied',undefined,{kind:'k'} as never)).rejects.toThrow(/^invalid action log entry: \/undo must be null/);
 expect(readFileSync(paths.actionsLog,'utf8')).toBe(before);
});

it('settles a pending row that follows a torn line and reports the torn line (spec 103 AC-5)',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'actions-')));await ensureStateDirs(paths);
 const log=new ActionLog(paths.actionsLog,paths);
 writeFileSync(paths.actionsLog,'\u0000'.repeat(25)+'\n');
 const pending=await log.writePending({agent:'test',run_id:'run',kind:'set_parameter',args:{name:'system_work_share',value:0.5},why:'Adjust the balance of system work',undo:null});
 await log.markStalePending();
 expect((await log.list()).find(x=>x.id===pending.id)?.status).toBe('failed');
 const reports=(await readJsonLines<{kind:string;file:string}>(paths.serviceLog)).filter(r=>r.kind==='jsonl-skipped-lines');
 expect(reports.length).toBeGreaterThan(0);expect(reports.every(r=>r.file===paths.actionsLog)).toBe(true);
});
