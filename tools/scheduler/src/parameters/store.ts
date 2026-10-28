import {appendFile, readFile, rename, writeFile, open, unlink, stat} from 'node:fs/promises';
import type {StatePaths} from '../state/paths.ts';
import {recordEvent} from '../events/store.ts';
import {checkParameter, type ParameterDefinition} from './definitions.ts';
const operations=new Map<string,Promise<unknown>>();
/** A short-lived state transaction lock, shared by the service and local CLI processes.
 * A dead process's lock is reclaimed; a live owner is never timed out and overwritten. */
export function withStateLock<T>(path:string,work:()=>Promise<T>):Promise<T> {
 const result=(operations.get(path)??Promise.resolve()).then(async()=>{
  const lock=path+'.lock',deadline=Date.now()+30000;
  let handle:Awaited<ReturnType<typeof open>>;
  for(;;) {
   try {handle=await open(lock,'wx');await handle.writeFile(String(process.pid));break;}
   catch(e) {
    if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
    try {
     const pid=Number(await readFile(lock,'utf8'));
     if(Number.isSafeInteger(pid)&&pid>0) {try{process.kill(pid,0);}catch(err){if((err as NodeJS.ErrnoException).code==='ESRCH'){await unlink(lock);continue;}}}
     else if(Date.now()-(await stat(lock)).mtimeMs>30000){await unlink(lock);continue;}
    }catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')continue;throw err;}
    if(Date.now()>deadline)throw new Error(`state is busy: ${path}`);
    await new Promise(r=>setTimeout(r,10));
   }
  }
  try{return await work();}finally{await handle.close();await unlink(lock);}
 });
 operations.set(path,result.catch(()=>{}));return result;
}
export class ParameterLockedError extends Error {}
export interface ParameterValue {value:unknown; mode:'auto'|'locked'; set_by:string; at:string}
export class ParameterStore {
 readonly paths:StatePaths;
 readonly definitions:Record<string,ParameterDefinition>;
 constructor(paths:StatePaths, definitions:Record<string,ParameterDefinition>) {this.paths=paths;this.definitions=definitions;}
 async stored():Promise<Record<string,ParameterValue>> {
  try{return JSON.parse(await readFile(this.paths.parameters,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') return {}; throw e;}
 }
 async read(name:string):Promise<ParameterValue> {
  const d=this.definitions[name]; if(!Object.hasOwn(this.definitions,name)) throw new Error(`undefined parameter ${name}`);
  const stored=await this.stored();
  const saved=Object.hasOwn(stored,name)?stored[name]:undefined;
  if(saved) {checkParameter(d,saved.value); return saved;}
  return {value:d.default,mode:d.mode,set_by:'default',at:new Date(0).toISOString()};
 }
 async all():Promise<Record<string,ParameterValue>> { const out:Record<string,ParameterValue>={}; for(const n of Object.keys(this.definitions)) out[n]=await this.read(n); return out; }
 async setParameter(name:string,value:unknown,actor:string):Promise<void> {
  return withStateLock(this.paths.parameters,async()=>{
  const old=await this.read(name);
  if(old.mode==='locked' && actor!=='maintainer') throw new ParameterLockedError(`${name}: parameter locked`);
  checkParameter(this.definitions[name],value);
  await this.change(name,old,{...old,value,set_by:actor,at:new Date().toISOString()},'value',actor);
  });
 }
 async setParameterMode(name:string,mode:'auto'|'locked',actor:string):Promise<void> {
  return withStateLock(this.paths.parameters,async()=>{
  if(actor!=='maintainer') throw new ParameterLockedError('only maintainer can change a parameter mode');
  if(!['auto','locked'].includes(mode)) throw new Error('mode must be auto or locked');
  const old=await this.read(name);
  await this.change(name,old,{...old,mode,set_by:actor,at:new Date().toISOString()},'mode',actor);
  });
 }
 private async change(name:string,old:ParameterValue,next:ParameterValue,field:'value'|'mode',actor:string):Promise<void> {
  const all=await this.stored(); all[name]=next;
  await writeFile(this.paths.parameters+'.tmp',JSON.stringify(all,null,2));
  await rename(this.paths.parameters+'.tmp',this.paths.parameters);
  const entry={name,old:old[field],new:next[field],field,actor,at:next.at};
  await appendFile(this.paths.parametersHistory,JSON.stringify(entry)+'\n');
  await recordEvent(this.paths,{kind:'parameter.changed',at:next.at,payload:entry});
 }
 async initialize():Promise<void> {
  await withStateLock(this.paths.parameters,async()=>{
   const all=await this.stored();let changed=false;
   for(const d of Object.values(this.definitions))if(!Object.hasOwn(all,d.name)){all[d.name]={value:d.default,mode:d.mode,set_by:'default',at:new Date().toISOString()};changed=true;}
   if(changed){await writeFile(this.paths.parameters+'.tmp',JSON.stringify(all,null,2));await rename(this.paths.parameters+'.tmp',this.paths.parameters);}
  });
 }
 async prune(name:string):Promise<void> {await withStateLock(this.paths.parameters,async()=>{const all=await this.stored(); delete all[name]; await writeFile(this.paths.parameters+'.tmp',JSON.stringify(all,null,2)); await rename(this.paths.parameters+'.tmp',this.paths.parameters);});}
}
