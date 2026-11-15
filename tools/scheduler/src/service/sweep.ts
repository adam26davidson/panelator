import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ActionLog } from "../actions/log.ts";
import { applyAction, loadActionLevels, type ActionContext } from "../actions/index.ts";
import type { GitHubClient } from "../github/client.ts";
import type { Notifier } from "../notify/types.ts";
import type { ParameterStore } from "../parameters/store.ts";
import { checkedPaths, MIN_FREE_BYTES, MIN_FREE_INODES, statfsFreeSpace, type FreeSpace } from "../runner/host-space.ts";
import { listWorktrees } from "../runner/worktree.ts";
import { readAgentState } from "../standing/state.ts";
import { readClaim } from "../state/claims.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";

/**
 * Spec 064: the scheduler's own sweep of the temp and state volumes. Under these floors a volume has room for one more
 * test run at most; spec 059's launch floors are lower. The values change with the host, by a reviewed PR.
 */
export const SWEEP_FREE_BYTES = 2 * 2 ** 30;
export const SWEEP_FREE_INODES = 100_000;
export const STALE_MS = 2 * 3600_000;
export const URGENT_STALE_MS = 15 * 60_000;
export const SWEEP_INTERVAL_MS = 3600_000;
export const HOLDER_WALK_MAX = 500_000;
/** The `PREFIX` of `test/helpers/test-tmpdir.ts`; a test asserts the two are equal. */
export const TEST_ROOT_PREFIX = "panelator-test-";

export type SweepAge = "stale" | "urgent";
export const AGE_MS: Record<SweepAge, number> = { stale: STALE_MS, urgent: URGENT_STALE_MS };

export interface Leftover {
  kind: "test-root" | "worktree" | "missing-worktree";
  name: string;
  path: string;
}

export interface Holder {
  name: string;
  inodes: number;
  /** The walk was cut short: `inodes` is a lower bound. */
  cut?: true;
  mtime: string;
}

export interface VolumeReport {
  path: string;
  free_bytes: number;
  free_inodes: number | null;
  removed: number;
  freed_inodes: number;
  episode?: { since: string; alarmed: boolean };
  holders: Holder[];
}

export interface DiskSweep {
  last_at: string;
  volumes: VolumeReport[];
}

export interface ListDeps {
  paths: StatePaths;
  repoDir: string;
  now: () => Date;
  /** Issues whose chain runs in this process. */
  activeIssues?: () => number[];
}

/** The harness's temp directory, as spec 059 reads it. */
export function tempDir(paths: StatePaths): string {
  return checkedPaths(paths, null)[0];
}

/** Spec 059's checked paths for a run without a worktree: the temp directory and the state root. */
export const checkedVolumes = (paths: StatePaths): string[] => checkedPaths(paths, null);

const older = (mtimeMs: number, age: SweepAge, now: Date): boolean => now.getTime() - mtimeMs > AGE_MS[age];

async function entries(dir: string): Promise<string[]> {
  return readdir(dir).catch((e) => {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return [];
    throw e;
  });
}

/** The things the system created on this volume and can recreate, older than `age`. A closed list: nothing else is ever listed. */
export async function staleLeftovers(volume: string, age: SweepAge, deps: ListDeps): Promise<Leftover[]> {
  const out: Leftover[] = [];
  const { paths } = deps;
  if (volume === tempDir(paths)) {
    for (const name of await entries(volume)) {
      if (!name.startsWith(TEST_ROOT_PREFIX)) continue;
      const path = join(volume, name);
      const st = await lstat(path).catch(() => null);
      if (st && older(st.mtimeMs, age, deps.now())) out.push({ kind: "test-root", name, path });
    }
  }
  if (volume === paths.root) {
    const protectedIssues = new Set<number>(deps.activeIssues?.() ?? []);
    // By file name: a record that does not parse still protects its issue.
    for (const dir of [paths.paused, paths.blocked])
      for (const n of await entries(dir)) {
        const m = /^(\d+)\.json$/.exec(n);
        if (m) protectedIssues.add(Number(m[1]));
      }
    for (const name of await entries(paths.worktrees)) {
      const path = join(paths.worktrees, name);
      const issue = /^issue-(\d+)$/.exec(name);
      const standing = /^standing-(.+)$/.exec(name);
      if (issue) {
        const n = Number(issue[1]);
        if (protectedIssues.has(n) || (await readClaim(paths, n).catch(() => ({}))) !== null) continue;
      } else if (standing) {
        if ((await readAgentState(paths, standing[1]).catch(() => null))?.running) continue;
      } else continue;
      const st = await lstat(path).catch(() => null);
      if (st?.isDirectory() && older(st.mtimeMs, age, deps.now())) out.push({ kind: "worktree", name, path });
    }
    const prefix = paths.worktrees + "/";
    for (const path of await listWorktrees(deps.repoDir).catch(() => [] as string[]))
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && !existsSync(path)) out.push({ kind: "missing-worktree", name: path.slice(prefix.length), path });
  }
  return out;
}

/** Counts `root` and what is under it, no symlink followed, stopping when `budget.left` runs out. Returns the entries counted and whether it was cut. */
export async function walkCount(root: string, budget: { left: number }): Promise<{ count: number; cut: boolean }> {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    if (budget.left <= 0) return { count, cut: true };
    budget.left--;
    count++;
    const st = await lstat(dir).catch(() => null);
    if (!st?.isDirectory()) continue;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, e.name);
      if (e.isDirectory()) stack.push(path);
      else {
        if (budget.left <= 0) return { count, cut: true };
        budget.left--;
        count++;
      }
    }
  }
  return { count, cut: false };
}

/** The direct entries of the volume's checked directory, ranked by inode count (a walk bounded in total by `HOLDER_WALK_MAX`), at most five. */
export async function holders(volume: string, deps: { paths: StatePaths }): Promise<Holder[]> {
  const { paths } = deps;
  const targets = volume === paths.root ? [paths.runs, paths.worktrees, paths.patches, paths.usage, paths.events] : (await entries(volume)).map((n) => join(volume, n));
  const budget = { left: HOLDER_WALK_MAX };
  const found: Holder[] = [];
  for (const path of targets) {
    const st = await lstat(path).catch(() => null);
    if (!st) continue;
    const { count, cut } = await walkCount(path, budget);
    found.push({ name: relative(volume, path), inodes: count, ...(cut ? { cut: true as const } : {}), mtime: st.mtime.toISOString() });
  }
  return found.sort((a, b) => b.inodes - a.inodes).slice(0, 5);
}

export const holderText = (h: Holder): string => `${h.name} (${h.cut ? ">=" : ""}${h.inodes} inodes, mtime ${h.mtime})`;

export async function readDiskSweep(paths: StatePaths): Promise<DiskSweep | null> {
  try {
    return JSON.parse(await readFile(paths.diskSweep, "utf8")) as DiskSweep;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeDiskSweep(paths: StatePaths, report: DiskSweep): Promise<void> {
  const tmp = paths.diskSweep + ".tmp";
  await writeFile(tmp, JSON.stringify(report, null, 2));
  await rename(tmp, paths.diskSweep);
}

const underSweepFloor = (f: FreeSpace): boolean => f.bytes < SWEEP_FREE_BYTES || (f.inodes !== null && f.inodes < SWEEP_FREE_INODES);
export const underLaunchFloor = (f: FreeSpace): boolean => f.bytes < MIN_FREE_BYTES || (f.inodes !== null && f.inodes < MIN_FREE_INODES);

export interface SweepResult {
  removed: string[];
  freed_inodes: number;
  patches: string[];
}

export interface SweepDeps extends ListDeps {
  agentsDir: string;
  gh: Pick<GitHubClient, "rerunWorkflowRun" | "cancelWorkflowRun">;
  parameters?: ParameterStore;
  freeSpace?: (path: string) => Promise<FreeSpace>;
  log: (rec: Record<string, unknown>) => void;
  notifier: Pick<Notifier, "notify">;
  emitEvent?: (event: string, payload: unknown) => Promise<void>;
}

const mib = (b: number): number => Math.floor(b / 2 ** 20);

/**
 * The tick step of spec 064 AC-1 and AC-2: measure each checked volume, remove the stale leftovers (urgently under the
 * sweep floors, hourly otherwise) as `sweep_volume` actions, and alarm once per episode when a volume stays under a
 * launch floor. Throws after all volumes are done when a sweep failed.
 */
export async function sweepVolumes(d: SweepDeps): Promise<void> {
  const now = d.now();
  const read = d.freeSpace ?? statfsFreeSpace;
  const previous = await readDiskSweep(d.paths);
  const due = !previous || now.getTime() - Date.parse(previous.last_at) >= SWEEP_INTERVAL_MS;
  const ctxBase: Omit<ActionContext, "onSweep"> = {
    paths: d.paths, parameters: d.parameters as ParameterStore, log: new ActionLog(d.paths.actionsLog, d.paths),
    levels: loadActionLevels(join(d.agentsDir, "actions.yaml")), gh: d.gh, now: d.now, repoDir: d.repoDir, serviceLog: d.log, activeIssues: d.activeIssues,
  };
  const request = async (path: string, age: SweepAge, why: string): Promise<{ result: SweepResult | null; error: string | null }> => {
    let result: SweepResult | null = null;
    const row = await applyAction({ ...ctxBase, onSweep: (r) => { result = r; } }, { kind: "sweep_volume", args: { path, age }, agent: "scheduler", run_id: "tick", why }, ["sweep_volume"]);
    return { result, error: row.status === "applied" ? null : `sweep_volume ${path} ${age} ${row.status}: ${row.reason ?? ""}` };
  };
  const reports: VolumeReport[] = [];
  const errors: string[] = [];
  let changed = false;
  let urgent = false;
  for (const path of checkedVolumes(d.paths)) {
    const prev = previous?.volumes.find((v) => v.path === path);
    let free: FreeSpace;
    try {
      free = await read(path);
    } catch (e) {
      d.log({ kind: "host-space-unknown", path, error: e instanceof Error ? e.message : String(e) });
      if (prev) reports.push(prev);
      continue;
    }
    let result: SweepResult | null = null;
    let swept = false;
    let measured = false;
    if (underSweepFloor(free)) {
      d.log({ kind: "disk-sweep-urgent", path, free_bytes: free.bytes, free_inodes: free.inodes });
      const r = await request(path, "urgent", `volume ${path} has ${mib(free.bytes)} MiB and ${free.inodes ?? "unknown"} inodes free, under the sweep floors`).catch((e) => ({ result: null, error: String(e) }));
      result = r.result;
      if (r.error) errors.push(r.error);
      swept = measured = urgent = true;
      try {
        free = await read(path);
      } catch (e) {
        d.log({ kind: "host-space-unknown", path, error: e instanceof Error ? e.message : String(e) });
      }
    } else if (due) {
      swept = true;
      try {
        const count = (await staleLeftovers(path, "stale", d)).length;
        if (count > 0) {
          const r = await request(path, "stale", `routine sweep: ${count} stale leftovers on ${path}, once every ${SWEEP_INTERVAL_MS / 60_000} minutes`);
          result = r.result;
          if (r.error) errors.push(r.error);
        }
      } catch (e) {
        errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const report: VolumeReport = {
      path, free_bytes: free.bytes, free_inodes: free.inodes,
      removed: swept ? result?.removed.length ?? 0 : prev?.removed ?? 0,
      freed_inodes: swept ? result?.freed_inodes ?? 0 : prev?.freed_inodes ?? 0,
      holders: prev?.holders ?? [],
    };
    if (prev?.episode) report.episode = prev.episode;
    const over = underLaunchFloor(free);
    if (over && !report.episode?.alarmed) {
      report.holders = await holders(path, d).catch(() => report.holders);
      const since = now.toISOString();
      report.episode = { since, alarmed: true };
      changed = true;
      const numbers = `${mib(free.bytes)} MiB and ${free.inodes ?? "unknown"} free inodes`;
      const held = report.holders.map(holderText).join("; ") || "none found";
      d.log({ kind: "disk-sweep-alarm", path, free_bytes: free.bytes, free_inodes: free.inodes, removed: report.removed, holders: report.holders });
      await d.notifier.notify({
        issue: 0, gate: "infra", label: "disk_full",
        text: `Host volume ${path} is low after the sweep: ${numbers}. The sweep removed ${report.removed} entries and freed ${report.freed_inodes} inodes. Largest holders: ${held}.`,
      });
      await appendFindings(d.paths, { issue: 0, stage: "scheduler", run_id: "disk-sweep", timestamp: since }, [{
        what: "host volume low after sweep", where: path,
        evidence: `${path} has ${numbers} after the sweep removed ${report.removed} entries (${report.freed_inodes} inodes). Largest holders: ${held}.`,
        noticed_how: "scheduler disk sweep", stops_pipeline: true,
      }]);
      await d.emitEvent?.("infra_alarm", { kind: "disk_full", path, since, free_bytes: free.bytes, free_inodes: free.inodes, removed: report.removed, holders: report.holders });
    } else if (!over && report.episode) {
      d.log({ kind: "disk-sweep-recovered", path, since: report.episode.since });
      delete report.episode;
      changed = true;
    } else if (swept && !measured && due) {
      report.holders = await holders(path, d).catch(() => report.holders);
    }
    reports.push(report);
  }
  if (due || changed || urgent) await writeDiskSweep(d.paths, { last_at: due ? now.toISOString() : previous!.last_at, volumes: reports });
  if (errors.length) throw new Error(errors.join("; "));
}
