import {exact,type ActionKind} from './index.ts';
import {runCheck} from '../credentials/check.ts';
/** Spec 069 AC-11: store the secret the command read from stdin, then run the entry's check; the secret never enters `args` or the row. */
export const credSetKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);if(c.actor!=='maintainer')return 'maintainer only';return c.credentials?.catalogue[String(a.name)]?null:`unknown credential ${a.name}`;},
 async apply(a,c){
  const cr=c.credentials!,name=String(a.name);
  if(!cr.secret)throw new Error('no secret supplied');
  await cr.store.writeSecret(name,await cr.secret(),'maintainer');
  cr.onResult?.(name,await runCheck(cr.catalogue[name],cr.probe));
  return {undo:null};
 }
};
