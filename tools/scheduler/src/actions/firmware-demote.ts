import { demote } from '../firmware/promote.ts';
import { readReleases } from '../firmware/releases.ts';
import {exact,type ActionKind} from './index.ts';
/** Spec 070 AC-12: sets the prerelease flag back; a demoted release is never promoted again by the scheduler. */
export const firmwareDemoteKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['tag','reason']);if(c.actor!=='maintainer')return 'maintainer only';if(!c.firmware)return 'firmware handling is not configured';if(typeof a.reason!=='string'||!a.reason.trim())return 'reason is required';return (await readReleases(c.paths)).some(x=>x.tag===a.tag)?null:`no recorded firmware release ${a.tag}`;},
 async apply(a,c){await demote(c.firmware!.promote,String(a.tag),String(a.reason));return {undo:null};}
};
