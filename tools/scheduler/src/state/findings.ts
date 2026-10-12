import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validate } from "../schema/validate.ts";
import type { AgentStageName } from "../types.ts";
import type { StatePaths } from "./paths.ts";

export interface FindingEnvelope {
  issue: number;
  stage: AgentStageName;
  run_id: string;
  timestamp: string;
}

export async function appendFindings(p: StatePaths, env: FindingEnvelope, findings: unknown[]): Promise<{ queued: number; rejected: string[] }> {
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
  if (lines) await appendFile(p.findingsQueue, lines);
  return { queued, rejected };
}
