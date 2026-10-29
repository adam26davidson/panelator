import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeChainState } from "../chain/machine.ts";
import type { Action, ChainEvent, ChainState } from "../chain/types.ts";
import type { AgentStageName } from "../types.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "./paths.ts";

export interface Claim {
  asking_session?: import('./paused.ts').AskingSession|null;
  telegram_thread?: import('./paused.ts').TelegramThread|null;
  issue: number;
  slot: number;
  state: ChainState;
  worktree: string;
  started_at: string;
  last_activity_at: string;
  run_id: string | null;
  /**
   * Spec 006: an event routed to the machine but not yet applied (a resume's `answered`, or C7's `chain_error`), and the
   * actions it produced, kept so a crash resumes them.
   */
  pendingEvent?: Extract<ChainEvent, { type: "answered" } | { type: "chain_error" }>;
  pendingActions?: Action[];
  /**
   * Spec 015 AC-10: a stage run that ended `ok`, recorded before its result is checked, so a step that throws after the
   * run checks the result again instead of running the stage again. Every transition clears it.
   */
  stageRun?: StageRunRecord;
  /** Spec 015 AC-5: the claim's consecutive transient failures; the chain is not started again before `retry_at`. */
  outage?: Outage;
}

export interface StageRunRecord {
  stage: AgentStageName;
  attempt: number;
  run_id: string;
  result: unknown;
  /** The worktree's HEAD when the run started (TI1). */
  start: string;
  security: boolean;
  sensitive: boolean;
}

export interface Outage {
  since: string;
  count: number;
  last: string;
  retry_at: string;
  alarmed: boolean;
  /** Spec 015 AC-13: the outage passed its ceiling; its failures count as genuine. */
  ceiling?: boolean;
  /** Spec 015 AC-13: the failures since the outage passed its ceiling, and when the first of them was. */
  past_ceiling?: { since: string; failures: number };
}

/** Pre-006 claims carry `securityFinding` and lack the new fields; fill them on read. */
function parse(text: string): Claim {
  const c = JSON.parse(text) as Claim;
  return { ...c, state: normalizeChainState(c.state) };
}

const file = (p: StatePaths, issue: number) => join(p.claims, `${issue}.json`);

export async function writeClaim(p: StatePaths, claim: Claim): Promise<void> {
  const v = validate("claim", claim);
  if (!v.ok) throw new Error(`invalid claim: ${v.errors.join("; ")}`);
  const tmp = file(p, claim.issue) + ".tmp";
  await writeFile(tmp, JSON.stringify(claim, null, 2));
  await rename(tmp, file(p, claim.issue));
}

export async function readClaim(p: StatePaths, issue: number): Promise<Claim | null> {
  try {
    return parse(await readFile(file(p, issue), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listClaims(p: StatePaths): Promise<Claim[]> {
  const names = (await readdir(p.claims)).filter((n) => /^\d+\.json$/.test(n));
  const out: Claim[] = [];
  for (const n of names) out.push(parse(await readFile(join(p.claims, n), "utf8")));
  return out.sort((a, b) => a.issue - b.issue);
}

export async function removeClaim(p: StatePaths, issue: number): Promise<void> {
  await unlink(file(p, issue)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}

export async function touchClaim(p: StatePaths, issue: number, patch: Partial<Claim>): Promise<Claim> {
  const c = await readClaim(p, issue);
  if (!c) throw new Error(`no claim for issue ${issue}`);
  const next = { ...c, ...patch, last_activity_at: new Date().toISOString() };
  await writeClaim(p, next);
  return next;
}
