import {exact,type ActionKind} from './index.ts';
import {runCheck} from '../credentials/check.ts';
export const credCheckKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);if(c.actor!=='maintainer')return 'maintainer only';return c.credentials?.catalogue[String(a.name)]?null:`unknown credential ${a.name}`;},
 async apply(a,c){const cr=c.credentials!,name=String(a.name);cr.onResult?.(name,await runCheck(cr.catalogue[name],cr.probe));return {undo:null};}
};
