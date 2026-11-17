import { markBricked } from '../firmware/board.ts';
import {exact,type ActionKind} from './index.ts';
/** Spec 070 AC-12: the maintainer sets the board bricked by hand; the pause and the message follow as for a result. */
export const boardBrickedKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['reason']);if(c.actor!=='maintainer')return 'maintainer only';if(typeof a.reason!=='string'||!a.reason.trim())return 'reason is required';return c.firmware?null:'firmware handling is not configured';},
 async apply(a,c){await markBricked(c.firmware!.board,String(a.reason));return {undo:null};}
};
