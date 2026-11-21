import {open,readFile} from 'node:fs/promises';
/**
 * The one reader of the scheduler's JSONL state files (spec 103). A line that does not parse is skipped, a record
 * behind a block of NUL bytes (an unclean shutdown's hole) is recovered, and what was skipped is reported once per read.
 * Nothing is written back: line numbers (the findings queue's refs) and byte offsets stay as the crash left them.
 */
export interface SkippedLines {file:string;skipped:number;recovered:number;offsets:number[];lines?:number[]}
export interface ReadOpts {log?:(rec:Record<string,unknown>)=>void;onSkipped?:(r:SkippedLines)=>void}
const MAX_REPORTED=10;
export type ParsedLine={ok:true;value:unknown;recovered:boolean}|{ok:false};
/** Leading NULs are stripped; the rest must be a JSON object. */
export function parseJsonLine(line:string):ParsedLine {
 let i=0;while(i<line.length&&line[i]==='\u0000')i++;
 const text=i?line.slice(i):line;
 if(!text.trim())return {ok:false};
 try{const v=JSON.parse(text);if(v!==null&&typeof v==='object'&&!Array.isArray(v))return {ok:true,value:v,recovered:i>0};}catch{/* torn */}
 return {ok:false};
}
class Tally {
 skipped=0;recovered=0;offsets:number[]=[];lines:number[]=[];
 note(kind:'skipped'|'recovered',offset:number,line?:number){
  if(kind==='skipped')this.skipped++;else this.recovered++;
  this.offsets.push(offset);if(line!==undefined)this.lines.push(line);
 }
 report(file:string,o:ReadOpts,withLines:boolean){
  if(!this.skipped&&!this.recovered)return;
  const offsets=[...this.offsets].sort((a,b)=>a-b).slice(0,MAX_REPORTED);
  const r:SkippedLines={file,skipped:this.skipped,recovered:this.recovered,offsets};
  if(withLines)r.lines=[...this.lines].sort((a,b)=>a-b).slice(0,MAX_REPORTED);
  o.onSkipped?.(r);
  o.log?.({kind:'jsonl-skipped-lines',...r});
 }
}
/** [start,end) byte ranges of the lines of a buffer split at 0x0A; the last is the remainder after the final newline. */
function splitLines(buf:Buffer):[number,number][] {
 const out:[number,number][]=[];let s=0;
 for(;;){const n=buf.indexOf(0x0a,s);if(n<0){out.push([s,buf.length]);return out;}out.push([s,n]);s=n+1;}
}
export async function readJsonLines<T>(path:string,opts:ReadOpts&{positional:true}):Promise<(T|undefined)[]>;
export async function readJsonLines<T>(path:string,opts?:ReadOpts&{positional?:boolean}):Promise<T[]>;
export async function readJsonLines<T>(path:string,opts:ReadOpts&{positional?:boolean}={}):Promise<(T|undefined)[]> {
 let buf:Buffer;try{buf=await readFile(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const ranges=splitLines(buf);
 const rem=ranges[ranges.length-1]!;if(rem[0]===rem[1])ranges.pop();
 const out:(T|undefined)[]=[],tally=new Tally();
 ranges.forEach(([s,e],i)=>{
  const text=buf.toString('utf8',s,e);
  if(!text){if(opts.positional)out.push(undefined);return;}
  const p=parseJsonLine(text);
  if(!p.ok){tally.note('skipped',s,i+1);if(opts.positional)out.push(undefined);return;}
  if(p.recovered)tally.note('recovered',s,i+1);
  out.push(p.value as T);
 });
 tally.report(path,opts,true);
 return out;
}
/**
 * The records whose `at` is at or after `cutoff`, read from the end of the file in chunks (spec 103 AC-6). The read
 * stops after the first chunk whose completed lines hold a dated record and none at or after the cutoff, or at the
 * start of the file. A chunk that completed no line, or whose lines were all torn, says nothing about time and does not stop it.
 */
export async function readRecentJsonLines<T extends {at:string}>(path:string,cutoff:string,opts:ReadOpts&{chunkBytes?:number}={}):Promise<T[]> {
 const chunk=Math.max(1,opts.chunkBytes??65536),cut=Date.parse(cutoff);
 let fh;try{fh=await open(path,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const tally=new Tally(),groups:T[][]=[];
 try{
  let pos=(await fh.stat()).size,carry=Buffer.alloc(0);
  while(pos>0||carry.length) {
   const start=Math.max(0,pos-chunk);
   const part=Buffer.alloc(pos-start);let got=0;while(got<part.length){const r=await fh.read(part,got,part.length-got,start+got);if(!r.bytesRead)break;got+=r.bytesRead;}
   const data=Buffer.concat([part.subarray(0,got),carry]);
   const ranges=splitLines(data);
   if(start>0){const first=ranges.shift()!;carry=data.subarray(first[0],first[1]);}else carry=Buffer.alloc(0);
   pos=start;
   const rem=ranges[ranges.length-1];if(start===0&&rem&&rem[0]===rem[1])ranges.pop();
   // With start>0 the carry ends at the next chunk's first newline, so every remaining range here is a whole line, except the last when the file does not end in a newline.
   const found:T[]=[];let dated=false,fresh=false;
   for(const [s,e] of ranges) {
    const text=data.toString('utf8',s,e);if(!text)continue;
    const p=parseJsonLine(text);
    if(!p.ok){tally.note('skipped',start+s);continue;}
    const at=Date.parse((p.value as {at?:unknown}).at as string);
    if(!Number.isFinite(at)){tally.note('skipped',start+s);continue;}
    if(p.recovered)tally.note('recovered',start+s);
    dated=true;if(at>=cut){fresh=true;found.push(p.value as T);}
   }
   groups.unshift(found);
   if(dated&&!fresh)break;
   if(start===0)break;
  }
 }finally{await fh.close();}
 tally.report(path,opts,false);
 return groups.flat();
}
