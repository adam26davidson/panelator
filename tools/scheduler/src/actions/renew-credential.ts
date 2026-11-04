import {exact,type ActionKind,type ActionContext} from './index.ts';
import {defaultRunner,envFor,probeExpiry,runCheck} from '../credentials/check.ts';
import type {IndexEntry} from '../credentials/store.ts';

/** Spec 030 AC-14. The undo is null: a rotated secret cannot be un-rotated. */
async function fail(c:ActionContext,name:string,reason:string):Promise<never> {
 const e=c.credentials!.catalogue[name];
 await c.notify?.('credential-expiry',`Credential ${name} could not be renewed (${reason}). Steps:\n${e.setup.map((s,i)=>`${i+1}. ${s}`).join('\n')}`,name);
 throw new Error(reason);
}
export const renewCredentialKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);if(!c.credentials)return 'credentials are not configured';if(typeof a.name!=='string'||!c.credentials.catalogue[a.name])return 'unknown credential';return null;},
 async apply(a,c){
  const d=c.credentials!,name=String(a.name),e=d.catalogue[name];
  if(typeof e.renew==='string')return fail(c,name,`renew is ${e.renew}`);
  let secret='';
  try{secret=await d.store.readSecret(name);}catch{return fail(c,name,'credential is not set');}
  const r=await(d.run??defaultRunner)(e.renew.command,envFor(d,e,secret),d.timeoutMs??120_000);
  if(r.code!==0)return fail(c,name,`renew command exit ${r.code??'timeout'}`);
  // the command may have stored a new secret: check with what the store holds now
  secret=await d.store.readSecret(name);
  const bad=await runCheck(d,e,secret);
  if(bad!==null)return fail(c,name,`check failed after renewal: ${bad}`);
  const expires=await probeExpiry(d,e,secret,null);
  await d.store.updateIndex(name,cur=>({...(cur as IndexEntry),expires_at:expires,last_checked_at:d.now().toISOString(),last_check:'ok'}));
  return {undo:null};
 }
};
