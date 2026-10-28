import {it, expect} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {statePaths, ensureStateDirs} from '../src/state/paths.ts';
import {loadRegistry} from '../src/standing/registry.ts';
import {EVENT_NAMES} from '../src/standing/events.ts';
import {registryActionsCheck} from '../src/actions/index.ts';
import {loadParameterDefinitions} from '../src/parameters/definitions.ts';
import {ParameterStore, ParameterLockedError} from '../src/parameters/store.ts';
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
 for(const defs of [[{...base,unknown:true}],[{...base,default:3}],[base,base]]){await writeFile(file,JSON.stringify(defs));expect(()=>loadParameterDefinitions(file,{slots:1},{})).toThrow();}
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
