import {accessSync,constants,readFileSync} from 'node:fs';
import {exact,type ActionKind,type ActionContext} from './index.ts';
import {runCheck} from '../credentials/check.ts';
const pathOf=(c:ActionContext,name:string)=>name==='github-app-key'||name==='telegram-bot'?c.credentials?.configPaths[name]:undefined;
export const credImportKind:ActionKind={changesMode:false,
 async check(a,c){
  exact(a,['name']);if(c.actor!=='maintainer')return 'maintainer only';
  const name=String(a.name);if(!c.credentials?.catalogue[name])return `unknown credential ${name}`;
  const path=pathOf(c,name);if(!path)return `unknown credential ${name}`;
  try{accessSync(path,constants.R_OK);}catch{return `cannot read ${path}`;}
  return null;
 },
 async apply(a,c){
  const cr=c.credentials!,name=String(a.name);
  await cr.store.writeSecret(name,readFileSync(pathOf(c,name)!,'utf8'),'import');
  cr.onResult?.(name,await runCheck(cr.catalogue[name],cr.probe));
  return {undo:null};
 }
};
