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
  /** Spec 060: records of chains waiting for main. */
  blocked: string;
  escalations: string;
  questionsLog: string;
  parameters: string;
  parametersHistory: string;
  actionsLog: string;
  agents: string;
  mainChecks: string;
  findingsCursor: string;
  findingsTriage: string;
  /** Spec 026: the event store; the index and the backfill marker are the only other files under `events/`. */
  events: string;
  eventsIndex: string;
  eventsBackfilled: string;
  /** Spec 026: issues already recorded as eligible. Not under `events/`: it is rewritten. */
  eligibleMarks: string;
  /** Spec 013: the quota book. */
  quota: string;
  /** Spec 029 AC-8: the issues whose needs-design-stage label was removed, so a restart comments once. */
  designRelabelled: string;
  /** Spec 031 AC-4: consecutive scans on which a planned child could not be filed. */
  childrenFailures: string;
  /** Spec 064: the disk sweep's report, and the patches it saves of a worktree's work before removing it. */
  diskSweep: string;
  patchesSweep: string;
  /** Spec 070: the test board's state, the recorded firmware releases, and the HIL check runs already read. */
  board: string;
  firmwareReleases: string;
  firmwareHilRead: string;
  firmwareListedAt: string;
  /** Spec 070 AC-7: when the maintainer was last told the board is down, and whether the one reminder was sent. */
  boardAlert: string;
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
    events: join(root, 'events'),
    eventsIndex: join(root, 'events', 'index.sqlite'),
    eventsBackfilled: join(root, 'events', 'backfilled.json'),
    eligibleMarks: join(root, 'shortlist', 'eligible.json'),
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
    blocked: join(root, "blocked"),
    escalations: join(root, "escalations"),
    questionsLog: join(root, "questions", "log.jsonl"),
    quota: join(root, "quota.json"),
    designRelabelled: join(root, "design", "relabelled.json"),
    childrenFailures: join(root, "children", "failures.json"),
    diskSweep: join(root, "disk-sweep.json"),
    patchesSweep: join(root, "patches", "sweep"),
    board: join(root, "board.json"),
    firmwareReleases: join(root, "firmware", "releases.json"),
    firmwareHilRead: join(root, "firmware", "hil-read.json"),
    boardAlert: join(root, "board-alert.json"),
    firmwareListedAt: join(root, "firmware", "listed-at.json"),
  };
}

export async function ensureStateDirs(p: StatePaths): Promise<void> {
  for (const d of [dirname(p.telegramOffset), p.claims, p.runs, p.usage, p.patches, p.findingsRejected, p.log, p.worktrees, p.paused, p.blocked, p.escalations, dirname(p.questionsLog), dirname(p.parametersHistory), dirname(p.actionsLog), dirname(p.designRelabelled), dirname(p.childrenFailures), dirname(p.firmwareReleases), p.agents, p.events, dirname(p.eligibleMarks)]) await mkdir(d, { recursive: true });
}
