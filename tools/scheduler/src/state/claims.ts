import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChainState } from "../chain/types.ts";
import { validate } from "../schema/validate.ts";
import type { StatePaths } from "./paths.ts";

export interface Claim {
  issue: number;
  slot: number;
  state: ChainState;
  worktree: string;
  started_at: string;
  last_activity_at: string;
  run_id: string | null;
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
    return JSON.parse(await readFile(file(p, issue), "utf8")) as Claim;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function listClaims(p: StatePaths): Promise<Claim[]> {
  const names = (await readdir(p.claims)).filter((n) => /^\d+\.json$/.test(n));
  const out: Claim[] = [];
  for (const n of names) out.push(JSON.parse(await readFile(join(p.claims, n), "utf8")) as Claim);
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
