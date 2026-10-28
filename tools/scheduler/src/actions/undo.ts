import {KINDS,applyAction,exact,type ActionKind,type ActionContext} from './index.ts';
async function target(c:ActionContext,id:unknown){
 const row=(await c.log.list()).find(e=>e.id===id);
 if(!row||row.status!=='applied'||!row.undo)throw new Error('action is not undoable');
 if(!KINDS[row.undo.kind] || c.levels[row.undo.kind]!==1)throw new Error('inverse action is not level 1');
 const reason=await KINDS[row.undo.kind].check(row.undo.args,{...c,reversing:true});if(reason)throw new Error(reason);return row;
}
export const undoKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['action_id']);await target(c,a.action_id);return null;},
 async apply(a,c){const row=await target(c,a.action_id);const result=await KINDS[row.undo!.kind].apply(row.undo!.args,{...c,reversing:true});return {...result,undoes:row.id};}
};
export async function undoAction(ctx:ActionContext,id:string,actor:string){return applyAction(ctx,{agent:actor,run_id:'command',kind:'undo',args:{action_id:id},why:`Undo recorded action ${id}`},actor==='maintainer'?'maintainer':['undo']);}
