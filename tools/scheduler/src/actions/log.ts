import {randomUUID} from 'node:crypto';
import {appendFile,readFile,writeFile,rename} from 'node:fs/promises';
import {withStateLock} from '../parameters/store.ts';
export interface Inverse {kind:string; args:Record<string,unknown>}
export interface ActionRequest extends Inverse {agent:string; run_id:string; why:string}
export interface LogEntry extends ActionRequest {id:string; at:string; status:'pending'|'applied'|'refused'|'failed'|'undone'; reason?:string; undo:Inverse|null; undoes?:string}
export class ActionLog {
 readonly path:string;
 constructor(path:string) {this.path=path;}
 async list(since?:string):Promise<LogEntry[]> {
  let text:string; try{text=await readFile(this.path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  return text.split('\n').filter(Boolean).map(l=>JSON.parse(l) as LogEntry).filter(e=>!since||e.at>=since);
 }
 async writePending(entry:ActionRequest & {undo:Inverse|null; undoes?:string},at=new Date().toISOString()):Promise<LogEntry> {
  const row:LogEntry={...entry,id:randomUUID(),at,status:'pending'};
  await withStateLock(this.path,()=>appendFile(this.path,JSON.stringify(row)+'\n')); return row;
 }
 async settle(id:string,status:LogEntry['status'],reason?:string,undo?:Inverse|null):Promise<LogEntry> {
  return withStateLock(this.path,async()=>{
  const rows=await this.list(); const row=rows.find(r=>r.id===id); if(!row)throw new Error('action not found');
  row.status=status; if(reason!==undefined)row.reason=reason; if(undo!==undefined)row.undo=undo;
  await writeFile(this.path+'.tmp',rows.map(r=>JSON.stringify(r)+'\n').join('')); await rename(this.path+'.tmp',this.path); return row;
  });
 }
 async markUndone(id:string):Promise<void> {await this.settle(id,'undone');}
 async markStalePending():Promise<void> {await withStateLock(this.path+'.operation',async()=>{for(const row of await this.list()) if(row.status==='pending')await this.settle(row.id,'failed','interrupted before settlement');});}
}
