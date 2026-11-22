import { setTimeout as delay } from "node:timers/promises";
import type { ActionContext } from "../actions/index.ts";
import type { ConsoleConfig } from "../config.ts";
import { applyChange, cursor } from "./apply.ts";
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

  /** One poll: fetch the changes after the cursor, apply and report each. Returns how many arrived. */
  async once(): Promise<number> {
    const d = this.#d;
    const key = await (d.readKey ?? (() => readApiKey(d.cfg.credentials_path)))();
    const auth = { authorization: `Bearer ${key}` };
    const ctx = d.action();
    const after = await cursor(ctx);
    const res = await d.fetch(`${d.cfg.url}/changes?after=${after}&wait=${d.cfg.long_poll_s}`, { headers: auth, signal: this.#ctl.signal });
    if (!res.ok) throw new Error(`GET /changes answered ${res.status}`);
    const body = (await res.json()) as { changes?: unknown[] };
    const list = Array.isArray(body.changes) ? body.changes : [];
    for (const raw of list) {
      const { change } = await applyChange(ctx, raw);
      d.log({ kind: "console", status: "change", id: change.id, change_kind: change.kind, outcome: change.status });
      const out = change.status === "applied" ? { status: "applied", ...(change.action_id ? { action_id: change.action_id } : {}) } : { status: "refused", reason: change.reason ?? "refused" };
      const post = await d.fetch(`${d.cfg.url}/changes/${change.id}/result`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(out), signal: this.#ctl.signal });
      if (!post.ok) throw new Error(`POST result answered ${post.status}`);
      await d.pusher.now();
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
