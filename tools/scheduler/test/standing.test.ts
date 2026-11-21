import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {statePaths,ensureStateDirs} from '../src/state/paths.ts';
import {initializeAgents,readAgentState,writeAgentState,updateAgentState,pruneRemovedAgents} from '../src/standing/state.ts';
import {emit,EVENT_NAMES,watchMainChecks} from '../src/standing/events.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ParameterStore} from '../src/parameters/store.ts';
import {buildAuditInput} from '../src/standing/audit-input.ts';
import {registryActionsCheck,KINDS} from '../src/actions/index.ts';
import type {GitHubClient} from '../src/github/client.ts';
import { loadRegistry, parseDuration, renderStandingPrompt } from '../src/standing/registry.ts';
import { agentsDir } from '../src/config.ts';
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
it('the filer prompt carries the stops_pipeline rule and input name (spec 063 AC-3)',()=>{
 const text=readFileSync(join(agentsDir,'standing','findings-filer.md'),'utf8');
 expect(text).toContain('issue.stops_pipeline');expect(text).toContain('stops every run or every PR');expect(text).toContain('stops_pipeline_label');
});
describe('trigger.min_events (spec 028 AC-4)', () => {
  const withTrigger = (t: string) => text.replace('trigger: {schedule: 1d, events: [merge]}', `trigger: ${t}`);
  const load = (s: string) => { const dir = mkdtempSync(join(tmpdir(), 'registry-')); writeFileSync(join(dir, 'test.md'), s); return loadRegistry(dir, ['merge'], []); };
  it('accepts min_events with events and rejects 0 or a missing events list', () => {
    expect(load(withTrigger('{schedule: 7d, events: [merge], min_events: 10}')).test.trigger.min_events).toBe(10);
    expect(() => load(withTrigger('{schedule: 7d, events: [merge], min_events: 0}'))).toThrow();
    expect(() => load(withTrigger('{schedule: 7d, min_events: 3}'))).toThrow(/min_events needs events/);
  });
  it('leaves the filer and the audit on the default', () => {
    const r = loadRegistry(join(agentsDir, 'standing'), EVENT_NAMES, Object.keys(KINDS));
    expect(r['findings-filer']!.trigger.min_events).toBeUndefined();
    expect(r['action-audit']!.trigger.min_events).toBeUndefined();
  });
});
describe('standing registry', () => {
  function load(s = text) { const dir = mkdtempSync(join(tmpdir(), 'registry-')); writeFileSync(join(dir, 'test.md'), s); return loadRegistry(dir, ['merge'], []); }
  it('loads and renders', () => {
    const d = load().test;
    expect(d.actions).toEqual([]);
    expect(d).toMatchObject({name:'test',kind:'standing',trigger:{schedule:'1d',events:['merge']},tier:'strong',worktree:'none',profile:'none',input:'audit-input',output:'standing-result',bounds:{timeout_min:10,max_turns:10,max_cost_usd:1},prompt:'Hello {{agent}}\n'});
    expect(renderStandingPrompt(d.prompt, {agent:'test'})).toBe('Hello test\n');
  });
  it.each([
    ['schedule: 1d','schedule: 1.5d'], ['tier: strong','tier: strong\neffort: high'], ['tier: strong','tier: strong\nindependent: true\nfallback: other'], ['tier: strong','tier: standard\nfallback: other'],
  ])('loads %s -> %s', (a,b) => expect(() => load(text.replace(a,b))).not.toThrow());
  const P = '"^[a-z][a-z0-9-]*$" {"pattern":"^[a-z][a-z0-9-]*$"}';
  it.each([
    ['input: audit-input','input: audit-input\nunknown: true',': / must NOT have additional properties {"additionalProperty":"unknown"}'],
    ['name: test\n','',`: / must have required property 'name' {"missingProperty":"name"}`],
    ['worktree: none','worktree: issue',': /worktree must be equal to one of the allowed values {"allowedValues":["fresh","none"]}'],
    ['input: audit-input','input: audit-input\neffort: 3',': /effort must be string {"type":"string"}'],
    ['name: test','name: Bad Name',`: /name must match pattern ${P}`],
    ['profile: none',"profile: ''",`: /profile must match pattern ${P}`],
    ['trigger: {schedule: 1d, events: [merge]}','trigger: {}',': /trigger must NOT have fewer than 1 properties {"limit":1}'],
    ['trigger: {schedule: 1d, events: [merge]}','trigger: {schedule: 1d, foo: 1}',': /trigger must NOT have additional properties {"additionalProperty":"foo"}'],
    ['trigger: {schedule: 1d, events: [merge]}','trigger: {events: []}',': /trigger/events must NOT have fewer than 1 items {"limit":1}'],
    ['trigger: {schedule: 1d, events: [merge]}','trigger: {schedule: soon}',': /trigger/schedule must match pattern'],
    ['trigger: {schedule: 1d, events: [merge]}','trigger: [merge]',': /trigger must be object {"type":"object"}'],
    ['schedule: 1d','schedule: 1m',': trigger.schedule must be between 1h and 30d'],
    ['schedule: 1d','schedule: 31d',': trigger.schedule must be between 1h and 30d'],
    ['events: [merge]','events: [oops]',': trigger.events unknown or empty'],
    ['input: audit-input','input: audit-input\nactions: [oops]',': actions contains unknown kind'],
    ['profile: none','profile: from-issue',': profile must be none or a profile name'],
    ['output: standing-result','output: plan-result',': output must extend standing-result'],
    ['input: audit-input','input: nope',': input schema missing'],
    ['tier: strong','tier: strong\nfallback: other',': a strong-tier stage may not name a fallback unless independent'],
    ['name: test','name: other',': name must equal file name'],
    ['kind: standing','kind: wrong',': kind must be agent or standing'],
  ])('rejects %s -> %s with the exact message', (a,b,msg) => expect(() => load(text.replace(a,b))).toThrow(msg));
  it.each([['kind: standing','kind: wrong'], ['schedule: 1d','schedule: 1m'], ['events: [merge]','events: [oops]'], ['name: test','name: other'], ['worktree: none','worktree: issue'], ['tier: strong','tier: strong\nfallback: other'], ['input: audit-input','input: audit-input\nunknown: true'], ['output: standing-result','output: plan-result'], ['profile: none\n',''], ['profile: none','profile: none\nactions: [oops]']])('rejects %s -> %s', (a,b) => expect(() => load(text.replace(a,b))).toThrow(/test.md/));
  it('rejects unknown placeholders', () => expect(() => renderStandingPrompt('{{oops}}', {})).toThrow());
  it('loads every real agent and cross-checks action code', () => {
    const kinds=registryActionsCheck('agents/actions.yaml');
    expect(Object.keys(loadRegistry('agents/standing',EVENT_NAMES,kinds)).sort()).toEqual(['action-audit','charter-reflection','credential-check','delivery-reflection','findings-filer','infra-health','meta-reflection']);
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

describe('agent state is checked before it is written (spec 086 AC-5)',()=>{
 const good={last_run:null,next_run:null,pending_events:[],paused:false,paused_by:null,failures:0};
 it('rejects invalid states and leaves the file unchanged',async()=>{
  const paths=statePaths(await mkdtemp(join(tmpdir(),'state-')));await ensureStateDirs(paths);
  await writeAgentState(paths,'test',good);
  const file=join(paths.agents,'test.json'),before=await readFile(file,'utf8');
  const bad:[Record<string,unknown>,string][]=[
   [{...good,bogus:1},'/ must NOT have additional properties {"additionalProperty":"bogus"}'],
   [{...good,running:{run_id:'r'}},"/running must have required property 'started_at' {\"missingProperty\":\"started_at\"}"],
   [{...good,failures:-1},'/failures must be >= 0 {"comparison":">=","limit":0}'],
  ];
  for(const [s,msg] of bad){
   await expect(writeAgentState(paths,'test',s as never)).rejects.toThrow(`invalid agent state test: ${msg}`);
   await expect(updateAgentState(paths,'test',()=>s as never)).rejects.toThrow(`invalid agent state test: ${msg}`);
   expect(await readFile(file,'utf8')).toBe(before);
  }
 });
});

describe('the reflection agents (spec 028 AC-1 to AC-3)', () => {
  const r = loadRegistry(join(agentsDir, 'standing'), EVENT_NAMES, Object.keys(KINDS));
  const bounds = { timeout_min: 45, max_turns: 80, max_cost_usd: 8 };
  it('registers the six standing agents', () => {
    expect(Object.keys(r).sort()).toEqual(['action-audit', 'charter-reflection', 'credential-check', 'delivery-reflection', 'findings-filer', 'infra-health', 'meta-reflection']);
  });
  it('delivery waits for ten merges, charter weekly, meta monthly', () => {
    expect(r['delivery-reflection']).toMatchObject({ tier: 'strong', harness: 'claude', worktree: 'fresh', trigger: { schedule: '7d', events: ['merge'], min_events: 10 }, bounds, actions: ['set_parameter', 'pause_agent', 'resume_agent', 'run_agent'], input: 'reflection-input', output: 'reflection-result' });
    expect(r['charter-reflection']).toMatchObject({ trigger: { schedule: '7d' }, bounds, actions: ['set_parameter', 'pause_agent', 'resume_agent', 'run_agent'] });
    expect(r['meta-reflection']).toMatchObject({ trigger: { schedule: '30d' }, bounds, actions: [] });
  });
  it('every prompt renders and forbids posting to GitHub', () => {
    for (const n of ['delivery-reflection', 'charter-reflection', 'meta-reflection']) {
      const out = renderStandingPrompt(r[n]!.prompt, { agent: n, events: '{}', parameters: '{}', profile_instructions: '', since: 'x', result_path: '/r.json' });
      expect(out).toContain('never post to GitHub');
    }
  });
});
