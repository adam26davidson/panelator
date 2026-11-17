import { promote } from '../firmware/promote.ts';
import { readReleases } from '../firmware/releases.ts';
import {exact,type ActionKind} from './index.ts';
/** Spec 070 AC-12: promotes a recorded beta release whatever the criteria; the maintainer's command. */
export const firmwarePromoteKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['tag']);if(c.actor!=='maintainer')return 'maintainer only';if(!c.firmware)return 'firmware handling is not configured';const r=(await readReleases(c.paths)).find(x=>x.tag===a.tag);return !r?`no recorded firmware release ${a.tag}`:r.channel!=='beta'?`${a.tag} is not a beta release`:null;},
 async apply(a,c){await promote(c.firmware!.promote,String(a.tag),'maintainer');return {undo:null};}
};
