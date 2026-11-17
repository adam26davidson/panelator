import { confirmBack } from '../firmware/board.ts';
import {exact,type ActionKind} from './index.ts';
/** Spec 070 AC-4, AC-12: the only writer of `ok` over `bricked`; the maintainer's command. */
export const boardBackKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,[]);if(c.actor!=='maintainer')return 'maintainer only';return c.firmware?null:'firmware handling is not configured';},
 async apply(_a,c){await confirmBack(c.firmware!.board);return {undo:null};}
};
