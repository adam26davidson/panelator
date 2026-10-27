import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StatePaths {
  root: string;
  claims: string;
  runs: string;
  usage: string;
  patches: string;
  findingsQueue: string;
  findingsRejected: string;
  token: string;
  log: string;
  serviceLog: string;
  worktrees: string;
  paused: string;
  escalations: string;
  questionsLog: string;
}

export function statePaths(root: string): StatePaths {
  return {
    root,
    claims: join(root, "claims"),
    runs: join(root, "runs"),
    usage: join(root, "usage"),
    patches: join(root, "patches"),
    findingsQueue: join(root, "findings", "queue.jsonl"),
    findingsRejected: join(root, "findings", "rejected"),
    token: join(root, "token.json"),
    log: join(root, "log"),
    serviceLog: join(root, "log", "service.jsonl"),
    worktrees: join(root, "worktrees"),
    paused: join(root, "paused"),
    escalations: join(root, "escalations"),
    questionsLog: join(root, "questions", "log.jsonl"),
  };
}

export async function ensureStateDirs(p: StatePaths): Promise<void> {
  for (const d of [p.claims, p.runs, p.usage, p.patches, p.findingsRejected, p.log, p.worktrees, p.paused, p.escalations, dirname(p.questionsLog)]) await mkdir(d, { recursive: true });
}
