import type {StatePaths} from '../state/paths.ts';
import {readJsonLines} from '../filer/input.ts';
import type {LogEntry} from '../actions/log.ts';
export async function buildAuditInput(paths:StatePaths,since:string|null,now=new Date()) {
 const cutoff=(since?Date.parse(since):now.getTime())-30*86400000;
 const kinds:Record<string,{entries:LogEntry[];applied:number;refused:number;failed:number;undone:number}>={};
 for(const row of await readJsonLines<LogEntry>(paths.actionsLog))if(Date.parse(row.at)>=cutoff) {
  const k=kinds[row.kind]??={entries:[],applied:0,refused:0,failed:0,undone:0};k.entries.push(row);if(row.status!=='pending')k[row.status]++;
 }
 return {since,kinds,parameter_history:await readJsonLines(paths.parametersHistory)};
}
