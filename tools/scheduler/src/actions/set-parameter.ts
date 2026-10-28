import {checkParameter} from '../parameters/definitions.ts';
import {exact,type ActionKind} from './index.ts';
export const setParameterKind:ActionKind={changesMode:false,
 async check(a,c){exact(a,['name','value']);const n=String(a.name);const prev=await c.parameters.read(n);if(prev.mode==='locked'&&c.actor!=='maintainer')return `${n}: parameter locked`;checkParameter(c.parameters.definitions[n],a.value);return null;},
 async apply(a,c){const name=String(a.name),prev=await c.parameters.read(name);await c.parameters.setParameter(name,a.value,c.actor!);return {undo:{kind:'set_parameter',args:{name,value:prev.value}}};}
};
