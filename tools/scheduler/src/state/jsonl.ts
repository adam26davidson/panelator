import {open,readFile} from 'node:fs/promises';
/**
 * The one tolerant reader of the scheduler's JSONL state files (spec 103). A line is parsed after its leading NUL bytes are
 * stripped (what delayed allocation leaves after an unclean shutdown); a line that still is no JSON object is skipped. Nothing is
 * written back: refs of the findings queue are line numbers and the events index stores byte offsets.
 */
export interface SkippedLines {file:string;skipped:number;recovered:number;offsets:number[];lines?:number[]}
export interface ReportOptions {log?:(rec:Record<string,unknown>)=>void;onSkipped?:(r:SkippedLines)=>void}
export interface ReadOptions extends ReportOptions {positional?:boolean}
export interface RecentOptions extends ReportOptions {chunkBytes?:number}
const REPORT_MAX=10,NUL=0,LF=10;
export function parseJsonLine(line:string):{ok:true;value:unknown;recovered:boolean}|{ok:false} {
 let i=0;while(i<line.length&&line.charCodeAt(i)===NUL)i++;
 try{
  const value:unknown=JSON.parse(i?line.slice(i):line);
  if(value===null||typeof value!=='object'||Array.isArray(value))return {ok:false};
  return {ok:true,value,recovered:i>0};
 }catch{return {ok:false};}
}
function report(file:string,skipped:number,recovered:number,offsets:number[],lines:number[]|null,o:ReportOptions):void {
 if(skipped+recovered===0)return;
 const r:SkippedLines={file,skipped,recovered,offsets:offsets.slice(0,REPORT_MAX)};
 if(lines)r.lines=lines.slice(0,REPORT_MAX);
 o.log?.({kind:'jsonl-skipped-lines',...r});
 o.onSkipped?.(r);
}
async function readBytes(path:string):Promise<Buffer|null> {
 try{return await readFile(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export async function readJsonLines<T>(path:string,opts:ReadOptions&{positional:true}):Promise<(T|undefined)[]>;
export async function readJsonLines<T>(path:string,opts?:ReadOptions):Promise<T[]>;
export async function readJsonLines<T>(path:string,opts:ReadOptions={}):Promise<(T|undefined)[]> {
 const buf=await readBytes(path);if(!buf)return [];
 const out:(T|undefined)[]=[],offsets:number[]=[],lines:number[]=[];let skipped=0,recovered=0,start=0,n=0;
 while(start<buf.length) {
  let end=buf.indexOf(LF,start);if(end<0)end=buf.length;
  n++;
  if(end===start){if(opts.positional)out.push(undefined);}
  else {
   const p=parseJsonLine(buf.toString('utf8',start,end));
   if(p.ok){out.push(p.value as T);if(p.recovered){recovered++;offsets.push(start);lines.push(n);}}
   else{skipped++;offsets.push(start);lines.push(n);if(opts.positional)out.push(undefined);}
  }
  start=end+1;
 }
 report(path,skipped,recovered,offsets,lines,opts);
 return out;
}
/**
 * The records with `at` at or after `cutoff`, read backwards in chunks. Stop rule: the read stops after the first chunk that
 * holds at least one record with a parseable `at` and none at or after the cutoff, or at the start of the file; a chunk with no
 * complete line, or only torn lines, says nothing about time and does not stop it.
 */
export async function readRecentJsonLines<T extends {at:string}>(path:string,cutoff:string,opts:RecentOptions={}):Promise<T[]> {
 const chunkBytes=Math.max(1,opts.chunkBytes??65536),min=Date.parse(cutoff);
 let fh;try{fh=await open(path,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 const chunks:T[][]=[],offsets:number[]=[];let skipped=0,recovered=0;
 try{
  let pos=(await fh.stat()).size,carry=Buffer.alloc(0);
  while(pos>0) {
   const start=Math.max(0,pos-chunkBytes),part=Buffer.alloc(pos-start);
   let got=0;while(got<part.length){const {bytesRead}=await fh.read(part,got,part.length-got,start+got);if(!bytesRead)break;got+=bytesRead;}
   let buf=Buffer.concat([part.subarray(0,got),carry]),base=start;
   carry=Buffer.alloc(0);
   if(start>0) {
    const first=buf.indexOf(LF);
    if(first<0){carry=buf;pos=start;continue;}
    carry=buf.subarray(0,first);buf=buf.subarray(first+1);base=start+first+1;
   }
   const kept:T[]=[];let dated=false,fresh=false,at=0;
   while(at<buf.length) {
    let end=buf.indexOf(LF,at);if(end<0)end=buf.length;
    if(end>at) {
     const p=parseJsonLine(buf.toString('utf8',at,end)),stamp=p.ok?(p.value as {at?:unknown}).at:undefined,when=typeof stamp==='string'?Date.parse(stamp):NaN;
     if(!p.ok||Number.isNaN(when)){skipped++;offsets.push(base+at);}
     else {
      dated=true;
      if(when>=min){fresh=true;kept.push(p.value as T);if(p.recovered){recovered++;offsets.push(base+at);}}
     }
    }
    at=end+1;
   }
   chunks.push(kept);pos=start;
   if(dated&&!fresh)break;
  }
 }finally{await fh.close();}
 offsets.sort((a,b)=>a-b);
 report(path,skipped,recovered,offsets,null,opts);
 return chunks.reverse().flat();
}
