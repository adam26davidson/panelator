/** Stands in for a reason the filer left out of an issue decision; it reaches the issue body, so it says what it is (spec 025 AC-2). */
export const REASON_PLACEHOLDER='(no reason given by the filer; placeholder added by the scheduler, spec 025)';
/** The outcomes that carry an issue. Elsewhere `reason` is the decision's whole content, so a missing one stays invalid. */
const ISSUE_OUTCOMES=new Set(['file','rewrite','escalate','merge_into']);
const isObject=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
/**
 * Puts the two shapes the filer is recorded returning into the schema's shape, before validation: `fallback` for `issue`,
 * and `title`, `body`, `class` beside the decision instead of inside `issue`, usually with no `reason` (spec 025 AC-2).
 * Anything else is left as it is for the schema to refuse. The input is not changed.
 */
export function normalizeFilerResult(raw:unknown):{result:unknown;notes:string[]} {
 if(!isObject(raw)||!Array.isArray(raw.decisions))return {result:raw,notes:[]};
 const notes:string[]=[];
 const decisions=raw.decisions.map((dec:unknown)=>{
  if(!isObject(dec)||typeof dec.outcome!=='string'||!ISSUE_OUTCOMES.has(dec.outcome))return dec;
  const next={...dec},{ref,fallback,title,body}=dec,klass=dec.class;
  const anyFlat=[title,body,klass].some(v=>v!==undefined),flat=[title,body,klass].every(v=>typeof v==='string');
  if(next.issue===undefined&&isObject(fallback)&&!anyFlat) {
   delete next.fallback;next.issue=fallback;notes.push(`${String(ref)}: fallback moved to issue`);
  } else if(next.issue===undefined&&fallback===undefined&&flat) {
   delete next.title;delete next.body;delete next.class;next.issue={title,body,class:klass};notes.push(`${String(ref)}: flat title, body, class gathered into issue`);
  }
  if(next.reason===undefined){next.reason=REASON_PLACEHOLDER;notes.push(`${String(ref)}: missing reason replaced by a placeholder`);}
  return next;
 });
 return {result:notes.length?{...raw,decisions}:raw,notes};
}
