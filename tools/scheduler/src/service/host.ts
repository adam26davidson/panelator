import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkHostSpace, type FreeSpace } from "../runner/host-space.ts";
import { DISK_FULL, failureCause, outageBackoffS, transientCause } from "../chain/transient.ts";
import { validate } from "../schema/validate.ts";
import { appendFindings } from "../state/findings.ts";
import type { StatePaths } from "../state/paths.ts";
import type { Notifier } from "../notify/types.ts";

/**
 * Spec 100: the host monitor. A host that cannot work (no network, a full disk) pauses the scheduler, which probes for the
 * cause to clear and resumes by itself; no issue's bounds are touched. The downtime log records every interval the
 * scheduler was not running or was paused, so the windows that judge (liveness, verify pending, an outage's age) count
 * running time only.
 */

/** AC-1: the hosts whose reachability says the host can work. Any HTTP response is reached. */
export const PROBE_HOSTS = ["github.com", "api.github.com"] as const;
export const PROBE_TIMEOUT_MS = 10_000;
/** AC-5: a pause this old (wall clock) tells the maintainer, once. */
export const HOST_NOTICE_MS = 2 * 3600_000;
/** AC-6: downtime entries older than this are dropped. */
export const DOWNTIME_KEEP_MS = 90 * 24 * 3600_000;

export type DowntimeReason = "host" | "sleep" | "stopped";
export interface Downtime { from: string; to: string; reason: DowntimeReason }
export interface Paused { since: string; cause: string; probes: number; next_probe_at: string; notified: boolean }
export interface HostState { paused: Paused | null; last_seen_at: string | null; downtime: Downtime[] }

const emptyState = (): HostState => ({ paused: null, last_seen_at: null, downtime: [] });

export interface ProbeDeps {
  paths: StatePaths;
  fetch?: typeof fetch;
  freeSpace?: (path: string) => Promise<FreeSpace>;
  log?: (rec: Record<string, unknown>) => void;
}

/** AC-1: null when the host can work, else the cause label. */
export async function probeHost(deps: ProbeDeps): Promise<string | null> {
  try {
    await checkHostSpace(deps.paths, null, { freeSpace: deps.freeSpace, log: deps.log ?? (() => {}) });
  } catch (e) {
    return (e as { code?: string }).code === DISK_FULL ? DISK_FULL : failureCause(String((e as Error).message), null);
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  for (const host of PROBE_HOSTS) {
    try {
      await doFetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return transientCause(e) ?? (typeof code === "string" ? code : failureCause(String((e as Error)?.message ?? e), null));
    }
  }
  return null;
}

export async function readHostState(paths: StatePaths): Promise<HostState> {
  let raw: string;
  try {
    raw = await readFile(paths.host, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw e;
  }
  const data: unknown = JSON.parse(raw);
  const v = validate("host", data);
  if (!v.ok) throw new Error(`invalid host state: ${v.errors.join("; ")}`);
  return data as HostState;
}

export async function writeHostState(paths: StatePaths, state: HostState): Promise<void> {
  const v = validate("host", state);
  if (!v.ok) throw new Error(`invalid host state: ${v.errors.join("; ")}`);
  await mkdir(dirname(paths.host), { recursive: true });
  const tmp = `${paths.host}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, paths.host);
}

function withDowntime(state: HostState, interval: Downtime, now: number): HostState {
  const kept = state.downtime.filter((d) => now - Date.parse(d.to) <= DOWNTIME_KEEP_MS);
  return { ...state, downtime: [...kept, interval] };
}

/** AC-6: appends an interval to the downtime log, dropping entries older than DOWNTIME_KEEP_MS. */
export async function recordDowntime(paths: StatePaths, interval: Downtime, now: number = Date.parse(interval.to)): Promise<void> {
  await writeHostState(paths, withDowntime(await readHostState(paths), interval, now));
}

/** AC-6: the length of the union of the intervals clipped to [from, to]; overlapping entries count once. */
export function downtimeBetween(log: readonly Downtime[], from: string | number, to: string | number): number {
  const lo = typeof from === "number" ? from : Date.parse(from);
  const hi = typeof to === "number" ? to : Date.parse(to);
  if (!(hi > lo)) return 0;
  const clipped = log
    .map((d) => [Math.max(lo, Date.parse(d.from)), Math.min(hi, Date.parse(d.to))] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

export interface HostMonitorDeps {
  paths: StatePaths;
  now: () => Date;
  /** The service log. */
  write: (rec: Record<string, unknown>) => void;
  notifier: Notifier;
  emitEvent?: (event: string, payload: unknown, exclude?: string) => Promise<void>;
  /** The host probe: null when the host can work, else the cause. */
  probe: () => Promise<string | null>;
}

export class HostMonitor {
  #d: HostMonitorDeps;
  #s: HostState | null = null;
  #tick = 0;
  #memo: { tick: number; cause: string | null } | null = null;
  #lastError = "unknown";
  #first = true;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: HostMonitorDeps) {
    this.#d = deps;
  }

  async #state(): Promise<HostState> {
    return (this.#s ??= await readHostState(this.#d.paths).catch((e) => {
      this.#d.write({ kind: "error", error: `host state: ${(e as Error).message}` });
      return emptyState();
    }));
  }

  async #save(next: HostState): Promise<void> {
    this.#s = next;
    const p = this.#queue.then(() => writeHostState(this.#d.paths, next));
    this.#queue = p.catch(() => {});
    await p;
  }

  /** Loads the state; called by the loop at the start of each tick, so the synchronous readers below see the log. */
  async beginTick(): Promise<void> {
    await this.#state();
    this.#tick++;
  }

  get paused(): Paused | null {
    return this.#s?.paused ?? null;
  }

  /** AC-2: the probe runs at most once per tick; true when the host cannot work (the scheduler is, or now becomes, paused). */
  async onTransient(cause: string, error: string): Promise<boolean> {
    const s = await this.#state();
    if (s.paused) return true;
    let result: string | null;
    if (this.#memo && this.#memo.tick === this.#tick) result = this.#memo.cause;
    else {
      result = await this.#d.probe();
      this.#memo = { tick: this.#tick, cause: result };
    }
    if (result === null) return false;
    // A pause begun by a concurrent caller while the probe ran keeps its own record.
    const cur = await this.#state();
    if (cur.paused) return true;
    const now = this.#d.now();
    this.#lastError = error;
    // The cause recorded is the probe's: what the host cannot do, not the label of the one failure that asked.
    cause = result;
    await this.#save({ ...cur, paused: { since: now.toISOString(), cause, probes: 1, next_probe_at: new Date(now.getTime() + outageBackoffS(1) * 1000).toISOString(), notified: false } });
    this.#d.write({ kind: "host-paused", cause, error });
    return true;
  }

  /** AC-4: re-probes a paused host when due. True when it resumed on this call. */
  async probeIfDue(): Promise<boolean> {
    const s = await this.#state();
    const p = s.paused;
    if (!p) return false;
    const now = this.#d.now();
    if (now.getTime() < Date.parse(p.next_probe_at)) return false;
    const result = await this.#d.probe();
    if (result !== null) {
      const probes = p.probes + 1;
      await this.#save({ ...s, paused: { ...p, probes, next_probe_at: new Date(now.getTime() + outageBackoffS(probes) * 1000).toISOString() } });
      return false;
    }
    const interval: Downtime = { from: p.since, to: now.toISOString(), reason: "host" };
    await this.#save({ ...withDowntime(s, interval, now.getTime()), paused: null });
    this.#memo = { tick: this.#tick, cause: null };
    this.#d.write({ kind: "host-resumed", since: p.since, cause: p.cause, probes: p.probes, paused_ms: now.getTime() - Date.parse(p.since) });
    // Spec 102 AC-6: the pause is over, so its next notice is sent at once.
    await this.#d.notifier.clear?.({ issue: 0, gate: "infra", label: "host", keepQueued: true }).catch((e) => this.#d.write({ kind: "error", error: `notify clear: ${(e as Error).message}` }));
    return true;
  }

  /** AC-5: the one notice of a long pause. */
  async noticeIfDue(): Promise<void> {
    const s = await this.#state();
    const p = s.paused;
    if (!p || p.notified) return;
    const now = this.#d.now();
    const ms = now.getTime() - Date.parse(p.since);
    if (!(ms >= HOST_NOTICE_MS || p.cause === DISK_FULL)) return;
    await this.#save({ ...s, paused: { ...p, notified: true } });
    this.#d.write({ kind: "host-paused-notice", since: p.since, cause: p.cause, probes: p.probes });
    await appendFindings(this.#d.paths, { issue: 0, stage: "scheduler", run_id: "host-probe", timestamp: now.toISOString() }, [{
      what: `host outage pauses the scheduler: ${p.cause}`, where: "scheduler host",
      evidence: `paused since ${p.since}; ${p.probes} probe${p.probes === 1 ? "" : "s"}; last error: ${this.#lastError}`,
      noticed_how: "scheduler host probe", stops_pipeline: true,
    }]);
    const minutes = Math.floor(ms / 60_000);
    const age = minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
    await this.#d.notifier.notify({ issue: 0, gate: "infra", label: "host", text: `The scheduler is paused: the host cannot work (${p.cause}). It has been paused for ${age} (since ${p.since}) and resumes by itself when the host probe passes. Nothing is counted against any issue meanwhile.` });
    await this.#d.emitEvent?.("infra_alarm", { kind: p.cause === DISK_FULL ? "disk_full" : "host_outage", since: p.since, probes: p.probes, cause: p.cause });
  }

  /** AC-6: a sleep the loop detected. */
  async recordSleep(sleptMs: number): Promise<void> {
    const s = await this.#state();
    const now = this.#d.now();
    await this.#save(withDowntime(s, { from: new Date(now.getTime() - sleptMs).toISOString(), to: now.toISOString(), reason: "sleep" }, now.getTime()));
  }

  /** AC-6: on the first tick of a process, a gap since the last tick of the previous one is downtime. */
  async startupGap(pollIntervalS: number): Promise<void> {
    if (!this.#first) return;
    this.#first = false;
    const s = await this.#state();
    if (!s.last_seen_at) return;
    const now = this.#d.now();
    const ms = now.getTime() - Date.parse(s.last_seen_at);
    if (ms <= 2 * pollIntervalS * 1000) return;
    const interval: Downtime = { from: s.last_seen_at, to: now.toISOString(), reason: "stopped" };
    await this.#save(withDowntime(s, interval, now.getTime()));
    this.#d.write({ kind: "downtime", ...interval, ms, reason: "stopped" });
  }

  /** AC-6: written at the end of every tick. */
  async markSeen(): Promise<void> {
    const s = await this.#state();
    await this.#save({ ...s, last_seen_at: this.#d.now().toISOString() });
  }

  /** The downtime inside [from, to], synchronous over the log loaded at the start of the tick. */
  downtimeMs(from: string | number, to: string | number): number {
    return downtimeBetween(this.#s?.downtime ?? [], from, to);
  }

  /** The tick line's `host` field while paused. */
  summary(): { paused_since: string; cause: string; probes: number; next_probe_at: string } | null {
    const p = this.paused;
    return p ? { paused_since: p.since, cause: p.cause, probes: p.probes, next_probe_at: p.next_probe_at } : null;
  }
}
