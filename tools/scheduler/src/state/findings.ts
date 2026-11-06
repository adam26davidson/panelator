import {withStateLock} from '../parameters/store.ts';
import { appendFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import { record } from "../events/store.ts";
import type { AgentStageName } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export interface FindingEnvelope {
  issue: number;
  stage: string;
  run_id: string;
  timestamp: string;
}

type QueuedListener=(count:number,offset:number,exclude?:string)=>Promise<void>;
const listeners = new Map<string,QueuedListener>();
export function onFindingsQueued(p:StatePaths,fn:QueuedListener):void {listeners.set(p.root,fn);}

export async function appendFindings(p: StatePaths, env: FindingEnvelope, findings: unknown[], opts: {exclude?:string;emit?:QueuedListener} = {}): Promise<{ queued: number; rejected: string[] }> {
  let queued = 0;
  const rejected: string[] = [];
  let lines = "";
  for (const [i, finding] of findings.entries()) {
    const v = validate("finding", finding);
    if (v.ok) {
      lines += JSON.stringify({ ...env, finding }) + "\n";
      queued++;
    } else {
      const path = join(p.findingsRejected, `${env.run_id}-${i}.json`);
      await writeFile(path, JSON.stringify({ envelope: env, finding, errors: v.errors }, null, 2));
      rejected.push(path);
    }
  }
  if (lines) await withStateLock(p.findingsQueue,async()=>{
    const offset=await stat(p.findingsQueue).then(s=>s.size).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;});
    await (opts.emit ?? listeners.get(p.root))?.(queued,offset,opts.exclude);
    await appendFile(p.findingsQueue, lines);
    for (const line of lines.split("\n").filter(Boolean)) await record(p, "finding.queued", env.timestamp, JSON.parse(line), { issue: env.issue, run_id: env.run_id });
  });
  return { queued, rejected };
}
