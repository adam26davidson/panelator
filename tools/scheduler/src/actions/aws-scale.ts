import {exact,type ActionKind} from './index.ts';
import {scaleRefusal,scaleSpend} from '../aws/ledger.ts';
import type {AwsContext} from '../aws/context.ts';

/** Spec 068 AC-7: moves a ledger reservation between the two states its launcher described, within the AWS cap. */
const awsOf=(ctx:{aws?:AwsContext}):AwsContext|string=>ctx.aws?.config?ctx.aws:'aws: off';
export const awsScaleKind:ActionKind={changesMode:false,
 async check(a,c){
  exact(a,['reservation_id','direction']);
  const aws=awsOf(c);
  if(typeof aws==='string')return aws;
  return scaleRefusal(aws,String(a.reservation_id),a.direction);
 },
 async apply(a,c){
  const aws=awsOf(c);
  if(typeof aws==='string')throw new Error(aws);
  const direction=a.direction as 'up'|'down';
  await scaleSpend(aws,String(a.reservation_id),direction);
  return {undo:{kind:'aws_scale',args:{reservation_id:a.reservation_id,direction:direction==='up'?'down':'up'}}};
 }
};
