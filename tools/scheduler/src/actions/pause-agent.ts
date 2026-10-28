import {agentState,exact,updateAgentState,type ActionKind} from './index.ts';
export const pauseAgentKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);const s=await agentState(c,a);return s.paused?'already paused':null;},
 async apply(a,c){await updateAgentState(c.paths,String(a.name),s=>({...s,paused:true,paused_by:c.actor!}));return {undo:{kind:'resume_agent',args:{name:a.name}}};}
};
