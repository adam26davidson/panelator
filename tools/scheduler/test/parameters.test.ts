import {it, expect} from 'vitest';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {statePaths, ensureStateDirs} from '../src/state/paths.ts';
import {loadRegistry} from '../src/standing/registry.ts';
import {EVENT_NAMES} from '../src/standing/events.ts';
import {registryActionsCheck} from '../src/actions/index.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ParameterStore, ParameterLockedError} from '../src/parameters/store.ts';
import {setParameterModeCommand} from '../src/parameters/command.ts';
it('enforces locks, maintainer-only modes, types and ranges, persists history', async () => {
 const paths=statePaths(await mkdtemp(join(tmpdir(),'params-'))); await ensureStateDirs(paths);
 const defs=loadParameterDefinitions('agents/parameters.yaml',{slots:2},{}); const store=new ParameterStore(paths,defs);
 expect((await store.read('slots')).value).toBe(2);
 await expect(store.setParameter('aws_cap_usd',1,'test')).rejects.toBeInstanceOf(ParameterLockedError);
 await store.setParameter('aws_cap_usd',1,'maintainer');
 await expect(store.setParameterMode('aws_cap_usd','auto','test')).rejects.toThrow();
 await expect(store.setParameter('slots',5,'test')).rejects.toThrow();
 await expect(store.setParameter('slots','2','test')).rejects.toThrow();
 await store.setParameter('system_work_share',0.5,'test');
 expect((await new ParameterStore(paths,defs).read('system_work_share')).value).toBe(0.5);
});
it('rejects malformed parameter definitions and serializes mode/value changes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'defs-')),file=join(root,'parameters.yaml');
 const base={name:'test',type:'number',default:1,min:0,max:2,mode:'auto',description:'test'};
 const x={...base,name:'x'};
 const cases:[unknown,string][]=[
  [[{...x,unknown:true}],`${file}: parameter 0: / must NOT have additional properties {"additionalProperty":"unknown"}`],
  [[{...x,name:'Bad Name'}],`${file}: parameter 0: /name must match pattern "^[a-z][a-z0-9_.-]*$"`],
  [[{...x,type:'text'}],`${file}: parameter 0: /type must be equal to one of the allowed values`],
  [[{...x,mode:'frozen'}],`${file}: parameter 0: /mode must be equal to one of the allowed values`],
  [[{...x,description:''}],`${file}: parameter 0: /description must NOT have fewer than 1 characters {"limit":1}`],
  [[(({default:_d,...r})=>r)(x)],`${file}: parameter 0: / must have required property 'default' {"missingProperty":"default"}`],
  [[{...x,min:'1'}],`${file}: parameter 0: /min must be number {"type":"number"}`],
  [[{...x,type:'duration',default:'1h',min:undefined,max:'soon'}],`${file}: parameter 0: /max must match pattern`],
  [[x,{...x,name:'y',unknown:1}],`${file}: parameter 1: / must NOT have additional properties`],
  [{a:1},`${file}: expected list`],
  [[x,x],`${file}: duplicate name x`],
  [[{...x,default:3,max:2}],`${file}: x: out of range`],
 ];
 for(const [defs,msg] of cases){await writeFile(file,JSON.stringify(defs));expect(()=>loadParameterDefinitions(file,{slots:1},{})).toThrow(msg);}
 await writeFile(file,JSON.stringify([{...x,name:'schedule.a',type:'duration',default:'1h',min:undefined,max:undefined}]));
 expect(()=>loadParameterDefinitions(file,{slots:1},{a:{name:'a',trigger:{schedule:'1d'}}} as never)).toThrow(`${file}: duplicate name schedule.a`);
 await writeFile(file,JSON.stringify([base]));const paths=statePaths(root);await ensureStateDirs(paths);
 const store=new ParameterStore(paths,loadParameterDefinitions(file,{slots:1},{}));
 const results=await Promise.allSettled([store.setParameterMode('test','locked','maintainer'),store.setParameter('test',2,'system')]);
 expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect((await store.read('test')).value).toBe(1);expect((await store.read('test')).mode).toBe('locked');
});
it('schedule parameters retain maintainer values and locks across definition changes',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'params-')));await ensureStateDirs(paths);
 const registry=loadRegistry('agents/standing',EVENT_NAMES,registryActionsCheck('agents/actions.yaml'));
 const defs=loadParameterDefinitions('agents/parameters.yaml',{slots:3},registry),store=new ParameterStore(paths,defs);
 expect((await store.read('schedule.action-audit')).value).toBe('7d');
 await store.setParameter('schedule.action-audit','2d','maintainer');await store.setParameterMode('schedule.action-audit','locked','maintainer');
 registry['action-audit'].trigger.schedule='3d';
 const newer=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:3},registry));
 expect((await newer.read('schedule.action-audit')).value).toBe('2d');expect((await newer.read('schedule.action-audit')).mode).toBe('locked');
 await expect(newer.setParameter('schedule.action-audit','3d','audit')).rejects.toThrow(/locked/);
 await newer.setParameterMode('schedule.action-audit','auto','maintainer');await expect(newer.setParameter('schedule.action-audit','30m','audit')).rejects.toThrow(/range/);
});
it('param mode records in the parameter history only and prints the new state',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'params-')));await ensureStateDirs(paths);
 const store=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},{}));
 const history=async()=>(await readFile(paths.parametersHistory,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(l=>JSON.parse(l));
 const locked=await setParameterModeCommand(store,'system_work_share','locked');
 expect(locked).toEqual({name:'system_work_share',...await store.read('system_work_share')});
 expect(locked.mode).toBe('locked');expect(locked.set_by).toBe('maintainer');
 expect(JSON.parse(await readFile(paths.parameters,'utf8')).system_work_share).toMatchObject({mode:'locked',set_by:'maintainer'});
 let h=await history();expect(h).toHaveLength(1);
 expect(h[0]).toMatchObject({name:'system_work_share',field:'mode',old:'auto',new:'locked',actor:'maintainer'});
 expect(existsSync(paths.actionsLog)).toBe(false);
 expect((await setParameterModeCommand(store,'system_work_share','auto')).mode).toBe('auto');
 expect(await history()).toHaveLength(2);expect(existsSync(paths.actionsLog)).toBe(false);
 const before=[await readFile(paths.parameters,'utf8'),await readFile(paths.parametersHistory,'utf8')];
 await expect(setParameterModeCommand(store,'no_such_parameter','locked')).rejects.toThrow('undefined parameter no_such_parameter');
 await expect(setParameterModeCommand(store,'system_work_share','frozen')).rejects.toThrow('mode must be auto or locked');
 expect([await readFile(paths.parameters,'utf8'),await readFile(paths.parametersHistory,'utf8')]).toEqual(before);
 expect(existsSync(paths.actionsLog)).toBe(false);
});
it('the store refuses to write an invalid parameters.json and leaves no trace',async()=>{
 const paths=statePaths(await mkdtemp(join(tmpdir(),'params-')));await ensureStateDirs(paths);
 const store=new ParameterStore(paths,loadParameterDefinitions('agents/parameters.yaml',{slots:1},{}));
 await store.setParameter('system_work_share',0.5,'test');
 const before=await readFile(paths.parameters,'utf8'),hist=await readFile(paths.parametersHistory,'utf8');
 await expect(store.setParameter('system_work_share',0.6,'')).rejects.toThrow('invalid parameters: /system_work_share/set_by must NOT have fewer than 1 characters {"limit":1}');
 expect(await readFile(paths.parameters,'utf8')).toBe(before);expect(await readFile(paths.parametersHistory,'utf8')).toBe(hist);
});
it('withStateLock leaves no lock when it cannot write its pid (spec 114 AC-8)',async()=>{
 const {installEnospc}=await import('./helpers/enospc-fs.mjs');
 const {withStateLock}=await import('../src/parameters/store.ts');
 const root=await mkdtemp(join(tmpdir(),'panelator-test-lock-')); const target=join(root,'p.json');
 const sw=installEnospc(root);
 try {
  await expect(withStateLock(target,async()=>1)).rejects.toMatchObject({code:'ENOSPC'});
  expect(existsSync(target+'.lock')).toBe(false);
  sw.on=false;
  expect(await withStateLock(target,async()=>2)).toBe(2);
 } finally {sw.restore();}
});
it('an empty lock younger than 30 seconds is not taken (spec 114 AC-8)',async()=>{
 const {withStateLock}=await import('../src/parameters/store.ts');
 const {unlink}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'panelator-test-lock-')); const target=join(root,'p.json');
 await writeFile(target+'.lock','');
 let got=false; const p=withStateLock(target,async()=>{got=true;});
 await new Promise(r=>setTimeout(r,150));
 expect(got).toBe(false);
 await unlink(target+'.lock'); await p; expect(got).toBe(true);
});
