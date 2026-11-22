import { setTimeout as delay } from "node:timers/promises";
import type { ActionContext } from "../actions/index.ts";
import type { ConsoleConfig } from "../config.ts";
import { applyChange, cursor } from "./apply.ts";
import { readChanges, type ChangeRecord } from "./state.ts";
import { readApiKey, type ConsolePusher, type Fetch } from "./push.ts";

export interface PollerDeps {
  cfg: ConsoleConfig; fetch: Fetch; action: () => ActionContext; pusher: ConsolePusher; log: (rec: Record<string, unknown>) => void;
  readKey?: () => Promise<string>; sleep?: (ms: number) => Promise<void>;
}

/** Spec 051 AC-4: the held long-poll for console changes; reconnects on return, backs off on error, nothing listens on the laptop. */
export class ConsolePoller {
  #d: PollerDeps;
  #ctl = new AbortController();
  #running: Promise<void> | null = null;
  constructor(d: PollerDeps) { this.#d = d; }
  start(): void { this.#running ??= this.#loop(); }
  async stop(): Promise<void> { this.#ctl.abort(); await this.#running; }

  async #sleep(ms: number): Promise<void> {
    try { await (this.#d.sleep ? this.#d.sleep(ms) : delay(ms, undefined, { signal: this.#ctl.signal })); } catch { /* stopping */ }
  }

  #unposted = new Map<number, ChangeRecord>();
  #resumed = false;

  #noted = new Set<string>();

  /**
   * POSTs a change's outcome. A network error, a 5xx, 408 or 429 keeps it for a later poll; any other 4xx (for example 404
   * after the stack was destroyed and deployed again) is permanent and is dropped. Either is logged once, never thrown:
   * a result that cannot be delivered must not stop the poll from asking for changes.
   */
  async #report(auth: Record<string, string>, change: ChangeRecord): Promise<void> {
    const d = this.#d;
    const out = change.status === "applied" ? { status: "applied", ...(change.action_id ? { action_id: change.action_id } : {}) } : { status: "refused", reason: change.reason ?? "refused" };
    let why: string;
    try {
      const post = await d.fetch(`${d.cfg.url}/changes/${change.id}/result`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(out), signal: this.#ctl.signal });
      if (post.ok) { this.#unposted.delete(change.id); this.#noted.delete(`${change.id}`); return; }
      why = `POST result answered ${post.status}`;
      if (post.status >= 400 && post.status < 500 && post.status !== 408 && post.status !== 429) {
        this.#unposted.delete(change.id);
        d.log({ kind: "console", status: "result-dropped", id: change.id, reason: why });
        return;
      }
    } catch (e) {
      if (this.#ctl.signal.aborted) return;
      why = (e as Error).message;
    }
    if (!this.#noted.has(`${change.id}`)) { this.#noted.add(`${change.id}`); d.log({ kind: "console", status: "result-failed", id: change.id, reason: why }); }
  }

  /** One poll: re-post any outcome still owed, fetch the changes after the cursor, apply and report each. Returns how many arrived. */
  async once(): Promise<number> {
    const d = this.#d;
    const key = await (d.readKey ?? (() => readApiKey(d.cfg.credentials_path)))();
    const auth = { authorization: `Bearer ${key}` };
    const ctx = d.action();
    // The cursor moves when a change is recorded, so a result POST that failed is retried from here, not by a re-delivery.
    if (!this.#resumed) {
      this.#resumed = true;
      for (const r of (await readChanges(ctx.paths)).slice(-50)) if (r.status !== "pending") this.#unposted.set(r.id, r);
    }
    for (const c of [...this.#unposted.values()]) await this.#report(auth, c);
    const after = await cursor(ctx);
    const res = await d.fetch(`${d.cfg.url}/changes?after=${after}&wait=${d.cfg.long_poll_s}`, { headers: auth, signal: this.#ctl.signal });
    if (!res.ok) throw new Error(`GET /changes answered ${res.status}`);
    const body = (await res.json()) as { changes?: unknown[] };
    const list = Array.isArray(body.changes) ? body.changes : [];
    for (const raw of list) {
      const { change } = await applyChange(ctx, raw);
      d.log({ kind: "console", status: "change", id: change.id, change_kind: change.kind, outcome: change.status });
      this.#unposted.set(change.id, change);
      await this.#report(auth, change);
      void d.pusher.now();
    }
    return list.length;
  }

  async #loop(): Promise<void> {
    let backoff = 1;
    let failed: string | null = null;
    while (!this.#ctl.signal.aborted) {
      try {
        const n = await this.once();
        backoff = 1;
        if (failed) this.#d.log({ kind: "console", status: "poll-recovered" });
        failed = null;
        if (n === 0 && this.#d.sleep) await this.#sleep(0);
      } catch (e) {
        if (this.#ctl.signal.aborted) break;
        const msg = (e as Error).message;
        if (failed !== msg) this.#d.log({ kind: "console", status: "poll-failed", reason: msg });
        failed = msg;
        await this.#sleep(backoff * 1000);
        backoff = Math.min(backoff * 2, 60);
      }
    }
  }
}
