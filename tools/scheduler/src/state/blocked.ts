import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeChainState } from "../chain/machine.ts";
import type { BlockCondition, ChainState } from "../chain/types.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "./paths.ts";

/** Spec 060 AC-4: a chain waiting for main holds no claim and no slot; this record keeps its state and worktree. */
export interface BlockedRecord {
  issue: number;
  state: ChainState;
  worktree: string;
  since: string;
  condition: BlockCondition;
  pr: { number: number; head_sha: string };
  /** AC-7: when main's checks were last read for a `main_green` condition. */
  last_check?: string | null;
  /** AC-7: the head of main the last settled read was made on. */
  checked_sha?: string | null;
}

const file = (p: StatePaths, issue: number) => join(p.blocked, `${issue}.json`);

export async function writeBlocked(p: StatePaths, r: BlockedRecord): Promise<void> {
  const v = validate("blocked", r);
  if (!v.ok) throw new Error(`invalid blocked record: ${v.errors.join("; ")}`);
  const tmp = file(p, r.issue) + ".tmp";
  await writeFile(tmp, JSON.stringify(r, null, 2));
  await rename(tmp, file(p, r.issue));
}

export async function listBlocked(p: StatePaths): Promise<BlockedRecord[]> {
  const names = (await readdir(p.blocked).catch(() => [] as string[])).filter((n) => /^\d+\.json$/.test(n));
  const out: BlockedRecord[] = [];
  for (const n of names) {
    const r = JSON.parse(await readFile(join(p.blocked, n), "utf8")) as BlockedRecord;
    out.push({ ...r, state: normalizeChainState(r.state) });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

export async function removeBlocked(p: StatePaths, issue: number): Promise<void> {
  await unlink(file(p, issue)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
}
