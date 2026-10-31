import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {initializeAgents,readAgentState,writeAgentState,pruneRemovedAgents} from '../src/standing/state.ts';
import {emit,EVENT_NAMES,watchMainChecks} from '../src/standing/events.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ParameterStore} from '../src/parameters/store.ts';
import {buildAuditInput} from '../src/standing/audit-input.ts';
import {registryActionsCheck} from '../src/actions/index.ts';
import type {GitHubClient} from '../src/github/client.ts';
import { loadRegistry, parseDuration, renderStandingPrompt } from '../src/standing/registry.ts';
const text = `---
name: test
kind: standing
trigger: {schedule: 1d, events: [merge]}
harness: claude
model: test
tier: strong
bounds: {timeout_min: 10, max_turns: 10, max_cost_usd: 1}
permission: no-prompt
worktree: none
profile: none
input: audit-input
output: standing-result
---
Hello {{agent}}
`;
describe('standing registry', () => {
  function load(s = text) { const dir = mkdtempSync(join(tmpdir(), 'registry-')); writeFileSync(join(dir, 'test.md'), s); return loadRegistry(dir, ['merge'], []); }
  it('loads and renders', () => { expect(load().test.actions).toEqual([]); expect(renderStandingPrompt('{{agent}}', {agent:'test'})).toBe('test'); });
  it.each([['kind: standing','kind: wrong'], ['schedule: 1d','schedule: 1m'], ['events: [merge]','events: [oops]'], ['name: test','name: other'], ['worktree: none','worktree: issue'], ['tier: strong','tier: strong\nfallback: other'], ['input: audit-input','input: audit-input\nunknown: true'], ['output: standing-result','output: plan-result'], ['profile: none\n',''], ['profile: none','profile: none\nactions: [oops]']])('rejects %s -> %s', (a,b) => expect(() => load(text.replace(a,b))).toThrow(/test.md/));
  it('rejects unknown placeholders', () => expect(() => renderStandingPrompt('{{oops}}', {})).toThrow());
  it('loads every real agent and cross-checks action code', () => {
    const kinds=registryActionsCheck('agents/actions.yaml');
    expect(Object.keys(loadRegistry('agents/standing',EVENT_NAMES,kinds)).sort()).toEqual(['action-audit','findings-filer']);
  });
  it('still loads an agent that names a kind raised to level 2', async()=>{
    const dir=await mkdtemp(join(tmpdir(),'level2-'));
    const actions=join(dir,'actions.yaml');await writeFile(actions,(await readFile('agents/actions.yaml','utf8')).replace('level: 1','level: 2'));
    const defs=join(dir,'standing');const {mkdir}=await import('node:fs/promises');await mkdir(defs);
    await writeFile(join(defs,'test.md'),text.replace('profile: none','profile: none\nactions: [set_parameter]'));
    expect(loadRegistry(defs,['merge'],registryActionsCheck(actions)).test.actions).toEqual(['set_parameter']);
  });
  it('parses durations', () => { expect(parseDuration('1h')).toBe(3600000); expect(parseDuration('2d')).toBe(172800000); expect(() => parseDuration('bad')).toThrow(); });
});
async function stateSetup(){
 const paths=statePaths(await mkdtemp(join(tmpdir(),'standing-')));await ensureStateDirs(paths);
 const registry=loadRegistry('agents/standing',EVENT_NAMES,registryActionsCheck('agents/actions.yaml'));
 const parameters=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},registry));
 const now=new Date('2026-10-01');await initializeAgents(paths,registry,parameters,now);return {paths,registry,parameters,now};
}
it('initializes one interval out, deduplicates events, preserves concurrent deliveries and history',async()=>{
 const {paths,registry,parameters,now}=await stateSetup();
 expect((await readAgentState(paths,'findings-filer'))?.next_run).toBe('2026-10-02T00:00:00.000Z');
 await Promise.all([emit(paths,registry,'finding_queued',{count:1},now),emit(paths,registry,'issue_abandoned',{issue:1},now)]);
 await emit(paths,registry,'finding_queued',{count:1},now);
 expect((await readAgentState(paths,'findings-filer'))?.pending_events).toHaveLength(2);
 await initializeAgents(paths,registry,parameters,new Date('2026-10-03'));
 expect((await readAgentState(paths,'findings-filer'))?.next_run).toBe('2026-10-02T00:00:00.000Z');
 await pruneRemovedAgents(paths,{},parameters,now);expect((await readAgentState(paths,'findings-filer'))?.removed_at).toBe(now.toISOString());
 await pruneRemovedAgents(paths,{},parameters,new Date('2026-11-02'));expect(await readAgentState(paths,'findings-filer')).toBeNull();
});
it('builds the action audit from the context window, grouped by kind and status',async()=>{
 const {paths}=await stateSetup();
 await writeFile(paths.actionsLog,[{at:'2026-08-01',kind:'set_parameter',status:'failed'},{at:'2026-10-01',kind:'set_parameter',status:'undone'},{at:'2026-10-20',kind:'set_parameter',status:'refused'}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 await writeFile(paths.parametersHistory,JSON.stringify({name:'slots',old:1,new:2})+'\n');
 const input=await buildAuditInput(paths,'2026-10-10T00:00:00Z',new Date('2026-10-27'));
 expect(input.kinds.set_parameter.entries).toHaveLength(2);expect(input.kinds.set_parameter.undone).toBe(1);expect(input.kinds.set_parameter.refused).toBe(1);expect(input.parameter_history).toHaveLength(1);
});
it('persists main check transitions without repeating after restart',async()=>{
 const {paths,registry,now}=await stateSetup();
 registry['findings-filer'].trigger.events!.push('ci_failure_main');
 const gh={checks:async()=>({runs:[{name:'test',id:9,status:'completed'}],failed:[{name:'test',id:9}]})} as unknown as GitHubClient;
 await watchMainChecks(gh,paths,registry,'sha',['test'],now);await watchMainChecks(gh,paths,registry,'sha',['test'],now);
 expect((await readAgentState(paths,'findings-filer'))?.pending_events).toHaveLength(1);
 expect(JSON.parse(await readFile(paths.mainChecks,'utf8'))).toEqual({$sha:'sha',test:'failed'});
 await watchMainChecks(gh,paths,registry,'new-sha',['test'],now);
 expect((await readAgentState(paths,'findings-filer'))?.pending_events).toHaveLength(2);
});
it('emit with an excluded agent delivers to every other subscriber and changes nothing else (spec 020 AC-1, AC-3, AC-4)',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'standing-')));await ensureStateDirs(paths);
 const registry=loadRegistry('agents/standing',EVENT_NAMES,registryActionsCheck('agents/actions.yaml'));
 registry['second-filer']={...registry['findings-filer'],name:'second-filer'};
 const parameters=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},registry));
 const now=new Date('2026-10-01');await initializeAgents(paths,registry,parameters,now);
 const events=async(name:string)=>(await readAgentState(paths,name))!.pending_events;
 await emit(paths,registry,'finding_queued',{count:1,offset:0},now,'findings-filer');
 expect(await events('findings-filer')).toEqual([]);
 expect(await events('second-filer')).toEqual([{event:'finding_queued',payload:{count:1,offset:0},at:now.toISOString()}]);
 await emit(paths,registry,'finding_queued',{count:1,offset:0},now);
 expect(await events('second-filer')).toHaveLength(1);expect(await events('findings-filer')).toHaveLength(1);
 await expect(emit(paths,registry,'nope',{},now,'findings-filer')).rejects.toThrow('unknown event nope');
});
