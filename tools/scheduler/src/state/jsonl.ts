import {open,readFile} from 'node:fs/promises';
/**
 * The tolerant reader for the JSONL state files (spec 103). A line is parsed after its leading NUL bytes are
 * stripped (an unclean shutdown can leave a block of NULs before the next record); a line that is not then a JSON
 * object is skipped. Nothing is written back: the files stay as the crash left them.
 */
export interface SkippedLines {file:string;skipped:number;recovered:number;offsets:number[];lines?:number[]}
export interface ReadOpts {log?:(rec:Record<string,unknown>)=>void;onSkipped?:(r:SkippedLines)=>void}
export type ParsedLine={ok:true;value:unknown;recovered:boolean}|{ok:false};
const REPORT_MAX=10;
export function parseJsonLine(line:string):ParsedLine {
 let i=0;while(i<line.length&&line.charCodeAt(i)===0)i++;
 try{
  const value:unknown=JSON.parse(i?line.slice(i):line);
  if(value===null||typeof value!=='object'||Array.isArray(value))return {ok:false};
  return {ok:true,value,recovered:i>0};
 }catch{return {ok:false};}
}
const isEnoent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
/** Collects what one read skipped or recovered, and reports it once. */
class Tally {
 skipped=0;recovered=0;offsets:number[]=[];lines:number[]=[];
 constructor(readonly file:string,readonly opts:ReadOpts|undefined,readonly withLines:boolean) {}
 add(kind:'skipped'|'recovered',offset:number,line?:number):void {
  this[kind]++;this.offsets.push(offset);if(line!==undefined)this.lines.push(line);
 }
 report():void {
  if(!this.skipped&&!this.recovered)return;
  const order=this.offsets.map((o,i)=>i).sort((a,b)=>this.offsets[a]!-this.offsets[b]!).slice(0,REPORT_MAX);
  const r:SkippedLines={file:this.file,skipped:this.skipped,recovered:this.recovered,offsets:order.map(i=>this.offsets[i]!)};
  if(this.withLines)r.lines=order.map(i=>this.lines[i]!);
  this.opts?.onSkipped?.(r);
  this.opts?.log?.({kind:'jsonl-skipped-lines',...r});
 }
}
/** The lines of a buffer, each with the byte offset of its start; a trailing newline's empty remainder is not a line. */
function* splitLines(buf:Buffer,base:number):Generator<{text:Buffer;offset:number}> {
 let start=0;
 while(start<=buf.length) {
  let end=buf.indexOf(10,start);
  if(end<0){if(start<buf.length)yield {text:buf.subarray(start),offset:base+start};return;}
  yield {text:buf.subarray(start,end),offset:base+start};start=end+1;
 }
}
export async function readJsonLines<T>(path:string,opts:ReadOpts&{positional:true}):Promise<(T|undefined)[]>;
export async function readJsonLines<T>(path:string,opts?:ReadOpts&{positional?:false}):Promise<T[]>;
export async function readJsonLines<T>(path:string,opts:ReadOpts&{positional?:boolean}={}):Promise<(T|undefined)[]> {
 let buf:Buffer;try{buf=await readFile(path);}catch(e){if(isEnoent(e))return [];throw e;}
 const out:(T|undefined)[]=[],tally=new Tally(path,opts,true);let n=0;
 for(const {text,offset} of splitLines(buf,0)) {
  n++;
  if(!text.length){if(opts.positional)out.push(undefined);continue;}
  const p=parseJsonLine(text.toString('utf8'));
  if(!p.ok){tally.add('skipped',offset,n);if(opts.positional)out.push(undefined);continue;}
  if(p.recovered)tally.add('recovered',offset,n);
  out.push(p.value as T);
 }
 tally.report();
 return out;
}
/**
 * The records whose `at` is at or after `cutoff`, in file order, read backwards in chunks. The read stops after the
 * first chunk (one holding at least one whole line) in which no parsed record is that new, or at the start of the file.
 */
export async function readRecentJsonLines<T extends {at:string}>(path:string,cutoff:string,opts:ReadOpts&{chunkBytes?:number}={}):Promise<T[]> {
 const chunk=opts.chunkBytes??65536,min=Date.parse(cutoff),tally=new Tally(path,opts,false);
 let fh;try{fh=await open(path,'r');}catch(e){if(isEnoent(e))return [];throw e;}
 const found:T[][]=[];
 try{
  let pos=(await fh.stat()).size,carry:Buffer=Buffer.alloc(0);
  while(pos>0) {
   const from=Math.max(0,pos-chunk),part=Buffer.alloc(pos-from);
   let got=0;while(got<part.length){const {bytesRead}=await fh.read(part,got,part.length-got,from+got);if(!bytesRead)break;got+=bytesRead;}
   let data=Buffer.concat([part.subarray(0,got),carry]),base=from;
   if(from>0) {
    const nl=data.indexOf(10);
    if(nl<0){carry=data;pos=from;continue;}
    carry=data.subarray(0,nl);data=data.subarray(nl+1);base=from+nl+1;
   }
   const here:T[]=[];let newer=false;
   for(const {text,offset} of splitLines(data,base)) {
    if(!text.length)continue;
    const p=parseJsonLine(text.toString('utf8'));
    const at=p.ok?Date.parse((p.value as {at?:unknown}).at as string):NaN;
    if(!p.ok||typeof (p.value as {at?:unknown}).at!=='string'||Number.isNaN(at)){tally.add('skipped',offset);continue;}
    if(p.recovered)tally.add('recovered',offset);
    if(at>=min){newer=true;here.push(p.value as T);}
   }
   found.unshift(here);
   if(from===0)break;
   if(!newer&&data.length)break;
   pos=from;
  }
 }finally{await fh.close();}
 tally.report();
 return found.flat();
}
