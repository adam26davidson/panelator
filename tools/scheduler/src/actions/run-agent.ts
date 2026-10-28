import {agentState,exact,updateAgentState,type ActionKind} from './index.ts';
export const runAgentKind:ActionKind={changesMode:false,
 async check(a,c){if(c.reversing){exact(a,['name','previous','marked','last_run']);const s=await agentState(c,a);return s.next_run!==a.marked||s.last_run?.run_id!==(a.last_run??undefined)?'agent has run or mark changed':null;}exact(a,['name']);await agentState(c,a);return null;},
 async apply(a,c){const s=await agentState(c,a);if(c.reversing){await updateAgentState(c.paths,String(a.name),current=>({...current,next_run:a.previous as string|null}));return {undo:null};}const marked=c.now().toISOString();await updateAgentState(c.paths,String(a.name),current=>({...current,next_run:marked}));return {undo:{kind:'run_agent',args:{name:a.name,previous:s.next_run,marked,last_run:s.last_run?.run_id??null}}};}
};
