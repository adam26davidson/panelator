import {exact,type ActionKind} from './index.ts';
export const credRemoveKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);if(c.actor!=='maintainer')return 'maintainer only';return c.credentials?.catalogue[String(a.name)]?null:`unknown credential ${a.name}`;},
 async apply(a,c){await c.credentials!.store.removeSecret(String(a.name));return {undo:null};}
};
