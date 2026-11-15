import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubClient } from "../github/client.ts";
import type { Claim } from "../state/claims.ts";
import type { StatePaths } from "../state/paths.ts";

const execFileP = promisify(execFile);

export type NumberKind = "spec" | "adr";
export interface NumberedPath { kind: NumberKind; number: number; path: string }
/** A number in use: `holder` is the path on main, `PR #<n>` or `issue #<n>'s reservation`. */
export interface Holder { kind: NumberKind; number: number; holder: string }

const SPEC = /^specs\/(\d{3})-[^/]+\/(?:spec|README)\.md$/;
const ADR = /^docs\/decisions\/(\d{4})-[^/]+\.md$/;

/** Spec 065: the numbered paths among a file list: a spec is `specs/NNN-<slug>/` (by its spec.md or README.md), an ADR `docs/decisions/NNNN-<slug>.md`; README.md and the like are not numbered. */
export function numberedPaths(files: string[]): NumberedPath[] {
  const out: NumberedPath[] = [];
  for (const f of files) {
    const s = SPEC.exec(f);
    if (s) out.push({ kind: "spec", number: Number(s[1]), path: f.slice(0, f.lastIndexOf("/")) });
    const a = ADR.exec(f);
    if (a) out.push({ kind: "adr", number: Number(a[1]), path: f });
  }
  return out;
}

/** One more than the largest number held (not the smallest gap: a split's directory keeps its number). */
export function nextFree(holders: Holder[], kind: NumberKind): number {
  return holders.filter((h) => h.kind === kind).reduce((m, h) => Math.max(m, h.number), 0) + 1;
}

export const fmtSpec = (n: number): string => String(n).padStart(3, "0");
export const fmtAdr = (n: number): string => String(n).padStart(4, "0");

/** The numbers the added files take that another holder already has. */
export function collisions(added: string[], holders: Holder[]): { kind: NumberKind; number: number; holder: string }[] {
  const out: { kind: NumberKind; number: number; holder: string }[] = [];
  for (const p of numberedPaths(added)) {
    const h = holders.find((x) => x.kind === p.kind && x.number === p.number);
    if (h) out.push({ kind: p.kind, number: p.number, holder: h.holder });
  }
  return out;
}

export interface NumberDeps {
  repoDir: string;
  paths: StatePaths;
  gh: Pick<GitHubClient, "openPullRequestsAddedFiles">;
  /** Test seam: the files on origin/main under specs/ and docs/decisions/. */
  mainFiles?: () => Promise<string[]>;
  listClaims: (p: StatePaths) => Promise<Claim[]>;
}

async function mainListing(repoDir: string): Promise<string[]> {
  const { stdout } = await execFileP("git", ["ls-tree", "-r", "--name-only", "origin/main", "--", "specs", "docs/decisions"], { cwd: repoDir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean);
}

/**
 * Every number held by origin/main, by an open pull request (its added files; those of `exceptPrs` are the run's own),
 * and by the reservation of every claim other than `except`.
 */
export async function holders(deps: NumberDeps, except: number, exceptPrs: number[] = []): Promise<Holder[]> {
  const out: Holder[] = [];
  for (const p of numberedPaths(await (deps.mainFiles ?? (() => mainListing(deps.repoDir)))())) out.push({ kind: p.kind, number: p.number, holder: p.path });
  for (const pr of await deps.gh.openPullRequestsAddedFiles()) {
    if (exceptPrs.includes(pr.number)) continue;
    for (const p of numberedPaths(pr.added)) out.push({ kind: p.kind, number: p.number, holder: `PR #${pr.number}` });
  }
  for (const c of await deps.listClaims(deps.paths)) {
    if (c.issue === except) continue;
    const r = c.state.reserved;
    if (r.spec !== null) out.push({ kind: "spec", number: r.spec, holder: `issue #${c.issue}'s reservation` });
    if (r.adr !== null) out.push({ kind: "adr", number: r.adr, holder: `issue #${c.issue}'s reservation` });
  }
  return out;
}

let tail: Promise<unknown> = Promise.resolve();
/** Chains run as concurrent tasks: reservation steps (read every claim, write one) run one at a time within the process. */
export function reserveSerially<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}
