import { applyActions, driveChain as defaultDriveChain, type DriverDeps } from "../chain/driver.ts";
import { CLAIM_LABEL, initialChainState, transition } from "../chain/machine.ts";
import { livenessGate } from "../gates/index.ts";
import { ensureWorktree, uncommittedPatch } from "../runner/worktree.ts";
import { buildSelectContext } from "../shortlist/fetch.ts";
import { rankIssues } from "../shortlist/rank.ts";
import { selectEligible } from "../shortlist/select.ts";
import { listClaims, removeClaim, writeClaim, type Claim } from "../state/claims.ts";
import { recentMerges } from "../state/merges.ts";
import { savePatch } from "../state/patches.ts";
import { pruneUsage } from "../state/runs.ts";
import type { SleepInhibitor } from "./inhibit.ts";
import type { ServiceLog } from "./log.ts";
import { schedulerChanged } from "./git.ts";

export interface SchedulerDeps extends DriverDeps {
  botLogin: string;
  serviceLog: ServiceLog;
  inhibitor: SleepInhibitor;
  fastForward: () => Promise<{ moved: boolean; changedPaths: string[] }>;
  sleep: (ms: number) => Promise<void>;
  monotonic: () => number;
  requestRestart: () => void;
}

export interface TickInfo {
  eligible: number;
  claimed: number[];
  released: number[];
  errors: string[];
  restartPending: boolean;
}

/** Ruling 7b: a chain whose driveChain rejects this many times in a row is released instead of resumed. */
export const MAX_CHAIN_FAILURES = 3;

type DriveFn = (deps: DriverDeps, claim: Claim, isStopping: () => boolean) => Promise<Claim>;

export class Scheduler {
  #deps: SchedulerDeps;
  #drive: DriveFn;
  #active = new Map<number, Promise<void>>();
  #stopping = false;
  #stopReason = "";
  #ticking = false;
  #restartPending = false;
  #failures = new Map<number, number>();

  constructor(deps: SchedulerDeps, opts: { driveChain?: DriveFn } = {}) {
    this.#deps = deps;
    this.#drive = opts.driveChain ?? defaultDriveChain;
  }

  get active(): number {
    return this.#active.size;
  }

  stop(reason: string): void {
    this.#stopping = true;
    this.#stopReason = reason;
  }

  #start(claim: Claim): void {
    if (this.#active.has(claim.issue)) return;
    const d = this.#deps;
    d.inhibitor.acquire();
    const p = this.#drive(d, claim, () => this.#stopping)
      .then(() => {
        this.#failures.delete(claim.issue);
      })
      .catch((e) => {
        d.log({ kind: "error", issue: claim.issue, error: (e as Error).message });
        this.#failures.set(claim.issue, (this.#failures.get(claim.issue) ?? 0) + 1);
      })
      .finally(() => {
        this.#active.delete(claim.issue);
        if (this.#active.size === 0) {
          d.inhibitor.release();
          // Mid-tick, the tick's own finally requests the restart once it is done.
          if (this.#restartPending && !this.#ticking) d.requestRestart();
        }
      });
    this.#active.set(claim.issue, p);
  }

  async #liveness(claim: Claim, errors: string[]): Promise<boolean> {
    const d = this.#deps;
    const labels = await d.gh.issueLabels(claim.issue).catch((e) => { errors.push(`labels ${claim.issue}: ${(e as Error).message}`); return null; });
    if (labels === null) return false;
    if (!labels.includes(CLAIM_LABEL)) {
      d.log({ kind: "stale-claim", issue: claim.issue });
      await savePatch(d.paths, claim.issue, await uncommittedPatch(claim.worktree).catch(() => ""));
      await removeClaim(d.paths, claim.issue);
      return true;
    }
    const ghActivity = await d.gh.issueActivityAt(claim.issue).catch(() => claim.last_activity_at);
    const last = ghActivity > claim.last_activity_at ? ghActivity : claim.last_activity_at;
    const g = livenessGate(last, claim.run_id !== null, d.now(), d.cfg.liveness_hours);
    if (g.ok) return false;
    await this.#expire(claim);
    return true;
  }

  async #expire(claim: Claim): Promise<void> {
    const { state, actions } = transition(claim.state, { type: "liveness_expired" });
    await applyActions(this.#deps, { ...claim, state }, actions);
  }

  async tick(): Promise<TickInfo> {
    if (this.#ticking) return { eligible: 0, claimed: [], released: [], errors: ["tick already in progress"], restartPending: this.#restartPending };
    this.#ticking = true;
    const d = this.#deps;
    const info: TickInfo = { eligible: 0, claimed: [], released: [], errors: [], restartPending: this.#restartPending };
    try {
      try {
        await d.fetchOrigin();
        const ff = await d.fastForward();
        if (ff.moved && schedulerChanged(ff.changedPaths)) {
          this.#restartPending = true;
          info.restartPending = true;
        }
      } catch (e) {
        info.errors.push(`freshness: ${(e as Error).message}`);
      }
      await pruneUsage(d.paths, d.now()).catch((e) => info.errors.push(`prune: ${(e as Error).message}`));

      for (const claim of await listClaims(d.paths)) {
        if (this.#active.has(claim.issue)) continue;
        if (await this.#liveness(claim, info.errors)) info.released.push(claim.issue);
      }
      // A pending self-update stops resuming and claiming, like a stop, so the restart is not held up by new chains.
      if (this.#stopping || this.#restartPending) return info;

      for (const claim of await listClaims(d.paths)) {
        if (this.#active.has(claim.issue)) continue;
        const failures = this.#failures.get(claim.issue) ?? 0;
        if (failures >= MAX_CHAIN_FAILURES) {
          await this.#expire(claim);
          this.#failures.delete(claim.issue);
          d.serviceLog.write({ kind: "chain-abandoned", issue: claim.issue, failures });
          info.released.push(claim.issue);
          continue;
        }
        if (this.#active.size >= d.cfg.slots) break;
        if (!this.#active.has(claim.issue) && !(claim.state.stage === "waiting" && claim.state.postponedUntil && new Date(claim.state.postponedUntil) > d.now())) this.#start(claim);
      }

      const free = d.cfg.slots - this.#active.size;
      if (free <= 0) return info;
      let issues;
      try {
        issues = await d.gh.listOpenIssues();
      } catch (e) {
        info.errors.push((e as Error).message);
        return info;
      }
      const claimed = new Set((await listClaims(d.paths)).map((c) => c.issue));
      const { eligible, decisions } = selectEligible(issues, buildSelectContext(d.repoDir, d.cfg, claimed, d.botLogin));
      info.eligible = eligible.length;
      for (const dec of decisions) {
        if (dec.result.ok || dec.result.action !== "label") continue;
        const r = dec.result;
        await d.gh.addLabels(dec.issue, [r.label]).catch((e) => info.errors.push(`label ${dec.issue}: ${(e as Error).message}`));
        await d.gh.comment(dec.issue, `${r.label}: ${r.reason}`).catch((e) => info.errors.push(`comment ${dec.issue}: ${(e as Error).message}`));
        await d.notifier.notify({ issue: dec.issue, gate: dec.gate, label: r.label, text: r.reason });
      }
      const ranked = rankIssues(eligible, d.cfg.labels, await recentMerges(d.paths, d.now()));
      for (const issue of ranked.slice(0, free)) {
        if (this.#stopping) break;
        try {
          // Claim file before the label: a failure in between leaves a claim without in-progress, which the
          // next tick's stale-claim check drops (GitHub wins), never an in-progress label with no claim file.
          const wt = await ensureWorktree(d.repoDir, d.paths.worktrees, issue.number);
          const claim: Claim = {
            issue: issue.number, slot: this.#active.size, state: initialChainState(issue.number), worktree: wt.path,
            started_at: d.now().toISOString(), last_activity_at: d.now().toISOString(), run_id: null,
          };
          await writeClaim(d.paths, claim);
          await d.gh.addLabels(issue.number, [CLAIM_LABEL]);
          info.claimed.push(issue.number);
          this.#start(claim);
        } catch (e) {
          info.errors.push(`claim ${issue.number}: ${(e as Error).message}`);
        }
      }
      return info;
    } finally {
      this.#ticking = false;
      d.serviceLog.tick({ ...info, active: [...this.#active.keys()] });
      if (this.#restartPending && this.#active.size === 0) d.requestRestart();
    }
  }

  async run(): Promise<void> {
    const d = this.#deps;
    const intervalMs = d.cfg.poll_interval_s * 1000;
    let lastWall = d.now().getTime();
    let lastMono = d.monotonic();
    while (!this.#stopping) {
      await this.tick().catch((e) => d.log({ kind: "error", error: (e as Error).message }));
      lastWall = d.now().getTime();
      lastMono = d.monotonic();
      await d.sleep(intervalMs);
      const wall = d.now().getTime() - lastWall;
      const mono = d.monotonic() - lastMono;
      if (wall - mono > intervalMs) d.serviceLog.write({ kind: "resumed", slept_ms: wall - mono });
    }
    await Promise.allSettled([...this.#active.values()]);
    d.inhibitor.release();
    d.serviceLog.stopped(this.#stopReason);
  }
}
