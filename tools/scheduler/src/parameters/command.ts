import type {ParameterStore,ParameterValue} from './store.ts';

export async function setParameterModeCommand(parameters:ParameterStore,name:string,mode:string):Promise<{name:string}&ParameterValue> {
  if(!Object.hasOwn(parameters.definitions,name))throw new Error(`undefined parameter ${name}`);
  await parameters.setParameterMode(name,mode as 'auto'|'locked','maintainer');
  return {name,...await parameters.read(name)};
}
