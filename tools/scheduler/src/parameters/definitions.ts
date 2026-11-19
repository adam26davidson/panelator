import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {parseDuration} from '../standing/registry.ts';
import {validate} from '../schema/validate.ts';
import type {StandingDefinition} from '../types.ts';
export interface ParameterDefinition {
 name:string; type:'number'|'boolean'|'string'|'duration'; default:unknown;
 min?:number|string; max?:number|string; mode:'auto'|'locked'; description:string;
}
export function checkParameter(d:ParameterDefinition,value:unknown):void {
 if (d.type === 'duration') {
  if (typeof value !== 'string') throw new Error(`${d.name}: expected duration`);
  const n=parseDuration(value);
  if ((d.min !== undefined && n<parseDuration(String(d.min))) || (d.max !== undefined && n>parseDuration(String(d.max)))) throw new Error(`${d.name}: out of range`);
 } else {
  if(typeof value !== d.type || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`${d.name}: expected ${d.type}`);
  if(typeof value === 'number' && ((typeof d.min === 'number' && value<d.min)||(typeof d.max === 'number' && value>d.max))) throw new Error(`${d.name}: out of range`);
  if(d.name === 'slots' && !Number.isInteger(value)) throw new Error('slots: expected integer');
 }
}
export function loadParameterDefinitions(path:string,cfg:{slots:number},registry:Record<string,StandingDefinition>):Record<string,ParameterDefinition> {
 try {
  const raw:unknown=parse(readFileSync(path,'utf8'));
  if(!Array.isArray(raw)) throw new Error('expected list');
  const out:Record<string,ParameterDefinition>=Object.create(null);
  for(const [i,item] of (raw as unknown[]).entries()) {
   const v=validate('parameter-definition',item); if(!v.ok) throw new Error(`parameter ${i}: ${v.errors.join('; ')}`);
   const d=item as ParameterDefinition;
   if(out[d.name]) throw new Error(`duplicate name ${d.name}`);
   checkParameter(d,d.default);
   if(d.name==='slots') d.default=cfg.slots;
   checkParameter(d,d.default); out[d.name]=d;
  }
  for(const def of Object.values(registry)) if(def.trigger.schedule) {
   const name=`schedule.${def.name}`;
   if(out[name]) throw new Error(`duplicate name ${name}`);
   out[name]={name,type:'duration',default:def.trigger.schedule,min:'1h',max:'30d',mode:'auto',description:`Schedule for ${def.name}`};
  }
  return out;
 } catch(e) {throw new Error(`${path}: ${(e as Error).message}`);}
}
