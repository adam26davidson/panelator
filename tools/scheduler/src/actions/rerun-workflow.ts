import {exact,type ActionKind} from './index.ts';
export const rerunWorkflowKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,c.reversing?['run_id','cancel']:['run_id']);if(!Number.isSafeInteger(a.run_id)||Number(a.run_id)<1)return 'run_id must be positive integer';if(c.reversing)return a.cancel===true?null:'invalid inverse';const cutoff=c.now().getTime()-86400000;return (await c.log.list()).some(e=>e.kind==='rerun_workflow'&&e.args.run_id===a.run_id&&['applied','undone','pending','failed'].includes(e.status)&&Date.parse(e.at)>cutoff)?'workflow already rerun today':null;},
 async apply(a,c){if(c.reversing){await c.gh.cancelWorkflowRun(Number(a.run_id));return {undo:null};}await c.gh.rerunWorkflowRun(Number(a.run_id));return {undo:{kind:'rerun_workflow',args:{run_id:a.run_id,cancel:true}}};}
};
