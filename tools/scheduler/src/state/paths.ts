import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface StatePaths {
  telegramOffset: string;
  telegramPending: string;
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
  parameters: string;
  parametersHistory: string;
  actionsLog: string;
  agents: string;
  mainChecks: string;
  findingsCursor: string;
  findingsTriage: string;
  /** Spec 013: the quota book. */
  quota: string;
}

export function statePaths(root: string): StatePaths {
  return {
    root,
    telegramOffset:join(root,'telegram','offset.json'),
    telegramPending:join(root,'telegram','pending.json'),
    parameters: join(root, 'parameters.json'),
    parametersHistory: join(root, 'parameters', 'history.jsonl'),
    actionsLog: join(root, 'actions', 'log.jsonl'),
    agents: join(root, 'agents'),
    mainChecks: join(root, 'main-checks.json'),
    findingsCursor: join(root, 'findings', 'cursor.json'),
    findingsTriage: join(root, 'findings', 'triage.jsonl'),
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
    quota: join(root, "quota.json"),
  };
}

export async function ensureStateDirs(p: StatePaths): Promise<void> {
  for (const d of [dirname(p.telegramOffset), p.claims, p.runs, p.usage, p.patches, p.findingsRejected, p.log, p.worktrees, p.paused, p.escalations, dirname(p.questionsLog), dirname(p.parametersHistory), dirname(p.actionsLog), p.agents]) await mkdir(d, { recursive: true });
}
