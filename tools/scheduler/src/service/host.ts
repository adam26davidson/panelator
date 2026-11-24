import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { checkHostSpace, isSpaceFailure, type FreeSpace } from "../runner/host-space.ts";
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

export type DowntimeReason = "host" | "sleep" | "stopped" | "restart";
export interface Downtime { from: string; to: string; reason: DowntimeReason }
export interface Paused { since: string; cause: string; probes: number; next_probe_at: string; notified: boolean }
/**
 * Spec 104: `restart_pending_since` is when this process's pending self-restart began; while it is pending the scheduler
 * resumes no claim, so the next process records the interval as `restart` downtime.
 */
export interface HostState { paused: Paused | null; last_seen_at: string | null; downtime: Downtime[]; restart_pending_since?: string }

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

type NoticePart = "notify" | "log" | "finding" | "alarm" | "save";
/** Spec 114 AC-4: what the notice of one pause has done, in memory, and the values its texts are built from. */
interface NoticeState { since: string; due: Date; done: Set<NoticePart>; cause: string; probes: number; lastError: string }

export class HostMonitor {
  #d: HostMonitorDeps;
  #s: HostState | null = null;
  #tick = 0;
  #memo: { tick: number; cause: string | null } | null = null;
  #lastError = "unknown";
  #first = true;
  #queue: Promise<unknown> = Promise.resolve();
  #saveFailed = false;
  #notice: NoticeState | null = null;

  constructor(deps: HostMonitorDeps) {
    this.#d = deps;
  }

  async #state(): Promise<HostState> {
    return (this.#s ??= await readHostState(this.#d.paths).catch((e) => {
      this.#d.write({ kind: "error", error: `host state: ${(e as Error).message}` });
      return emptyState();
    }));
  }

  /**
   * The in-memory state is what the process acts on (spec 114 AC-3): a save that fails for lack of space completes, is
   * logged once per run of failures, and the next save writes the whole current state.
   */
  async #save(next: HostState): Promise<void> {
    this.#s = next;
    const p = this.#queue.then(() => writeHostState(this.#d.paths, next));
    this.#queue = p.catch(() => {});
    try {
      await p;
      this.#saveFailed = false;
    } catch (e) {
      if (!isSpaceFailure(e)) throw e;
      if (!this.#saveFailed) this.#d.write({ kind: "error", error: `host state: ${(e as Error).message}` });
      this.#saveFailed = true;
    }
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
    // The cause recorded is the probe's: what the host cannot do, not the label of the one failure that asked.
    await this.#begin(cur, result, error);
    return true;
  }

  /** Spec 114 AC-2: pauses without a probe, for a cause the caller has measured (a state volume under the write floor). */
  async pauseFor(cause: string, error: string): Promise<void> {
    const s = await this.#state();
    if (s.paused) return;
    await this.#begin(s, cause, error);
  }

  async #begin(cur: HostState, cause: string, error: string): Promise<void> {
    const now = this.#d.now();
    this.#lastError = error;
    this.#notice = null;
    await this.#save({ ...cur, paused: { since: now.toISOString(), cause, probes: 1, next_probe_at: new Date(now.getTime() + outageBackoffS(1) * 1000).toISOString(), notified: false } });
    this.#d.write({ kind: "host-paused", cause, error });
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
    // Spec 114 AC-4: the last attempt at the parts of the notice that are still outstanding.
    await this.#finishNotice(p.since);
    // Spec 102 AC-6: the condition cleared, so the next pause notifies at once; a queued notice stays and is sent marked cleared.
    try {
      await this.#d.notifier.clear?.({ issue: 0, gate: "infra", label: "host" });
    } catch (e) {
      this.#d.write({ kind: "error", error: `notify clear: ${(e as Error).message}` });
    }
    return true;
  }

  /**
   * AC-5 as amended by spec 114 AC-4: the one notice of a long pause. In order: the notification, the log line, the
   * finding, the `infra_alarm`, the save of `notified`. Each part is tried again on each paused tick after a space
   * failure until it succeeds; a part that fails otherwise is logged and not retried.
   */
  async noticeIfDue(): Promise<void> {
    const s = await this.#state();
    const p = s.paused;
    if (!p) return;
    const now = this.#d.now();
    let st = this.#notice?.since === p.since ? this.#notice : null;
    if (!st) {
      if (p.notified) return;
      const ms = now.getTime() - Date.parse(p.since);
      if (!(ms >= HOST_NOTICE_MS || p.cause === DISK_FULL)) return;
      st = this.#notice = { since: p.since, due: now, done: new Set(), cause: p.cause, probes: p.probes, lastError: this.#lastError };
    }
    await this.#runNotice(st, now, false);
  }

  async #runNotice(st: NoticeState, now: Date, resuming: boolean): Promise<void> {
    const ms = now.getTime() - Date.parse(st.since);
    const minutes = Math.floor(ms / 60_000);
    const age = minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`;
    const parts: [NoticePart, () => Promise<void>][] = [
      ["notify", async () => { await this.#d.notifier.notify({ issue: 0, gate: "infra", label: "host", text: `The scheduler is paused: the host cannot work (${st.cause}). It has been paused for ${age} (since ${st.since}) and resumes by itself when the host probe passes. Nothing is counted against any issue meanwhile.` }); }],
      ["log", async () => { this.#d.write({ kind: "host-paused-notice", since: st.since, cause: st.cause, probes: st.probes }); }],
      ["finding", async () => {
        await appendFindings(this.#d.paths, { issue: 0, stage: "scheduler", run_id: "host-probe", timestamp: st.due.toISOString() }, [{
          what: `host outage pauses the scheduler: ${st.cause}`, where: "scheduler host",
          evidence: `paused since ${st.since}; ${st.probes} probe${st.probes === 1 ? "" : "s"}; last error: ${st.lastError}`,
          noticed_how: "scheduler host probe", stops_pipeline: true,
        }]);
      }],
      ["alarm", async () => { await this.#d.emitEvent?.("infra_alarm", { kind: st.cause === DISK_FULL ? "disk_full" : "host_outage", since: st.since, probes: st.probes, cause: st.cause }); }],
      ["save", async () => {
        const cur = await this.#state();
        if (!resuming && cur.paused?.since === st.since && !cur.paused.notified) await this.#save({ ...cur, paused: { ...cur.paused, notified: true } });
      }],
    ];
    for (const [name, run] of parts) {
      if (st.done.has(name)) continue;
      if (name === "save" && !st.done.has("notify")) continue;
      try {
        await run();
        st.done.add(name);
      } catch (e) {
        if (isSpaceFailure(e)) {
          if (resuming) this.#d.write({ kind: "error", error: `host notice ${name}: ${(e as Error).message}` });
          continue;
        }
        this.#d.write({ kind: "error", error: `host notice ${name}: ${(e as Error).message}` });
        st.done.add(name);
      }
    }
  }

  /** The tick that resumes makes the last attempt at what is outstanding; what still fails is logged and dropped. */
  async #finishNotice(since: string): Promise<void> {
    const st = this.#notice;
    this.#notice = null;
    if (!st || st.since !== since || st.done.size >= 5) return;
    await this.#runNotice(st, this.#d.now(), true);
  }

  /** AC-6: a sleep the loop detected. */
  async recordSleep(sleptMs: number): Promise<void> {
    const s = await this.#state();
    const now = this.#d.now();
    await this.#save(withDowntime(s, { from: new Date(now.getTime() - sleptMs).toISOString(), to: now.toISOString(), reason: "sleep" }, now.getTime()));
  }

  /** Spec 104 AC-1: the moment a self-restart became pending, kept for the next process; a later call keeps the first. */
  async markRestartPending(): Promise<void> {
    const s = await this.#state();
    if (s.restart_pending_since) return;
    await this.#save({ ...s, restart_pending_since: this.#d.now().toISOString() });
  }

  /**
   * AC-6: on the first tick of a process, a gap since the last tick of the previous one is downtime. Spec 104 AC-2: so is
   * the time the previous process spent with a restart pending, during which it resumed no claim.
   */
  async startupGap(pollIntervalS: number): Promise<void> {
    if (!this.#first) return;
    this.#first = false;
    let s = await this.#state();
    const now = this.#d.now();
    if (s.restart_pending_since) {
      const { restart_pending_since: from, ...rest } = s;
      const ms = now.getTime() - Date.parse(from);
      s = ms > 0 ? withDowntime(rest, { from, to: now.toISOString(), reason: "restart" }, now.getTime()) : rest;
      await this.#save(s);
      if (ms > 0) this.#d.write({ kind: "downtime", from, to: now.toISOString(), ms, reason: "restart" });
    }
    if (!s.last_seen_at) return;
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
