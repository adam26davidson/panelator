import {agentState,exact,updateAgentState,type ActionKind} from './index.ts';
export const resumeAgentKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name']);const s=await agentState(c,a);return s.paused_by==='maintainer'&&c.actor!=='maintainer'?'agent paused by maintainer':!s.paused?'not paused':null;},
 async apply(a,c){await updateAgentState(c.paths,String(a.name),s=>({...s,paused:false,paused_by:null}));return {undo:{kind:'pause_agent',args:{name:a.name}}};}
};
