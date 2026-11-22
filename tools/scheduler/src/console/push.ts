import { readFile } from "node:fs/promises";
import type { ConsoleConfig } from "../config.ts";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Log = (rec: Record<string, unknown>) => void;

/** The scheduler's API key, from `credentials_path` (`{"api_key": "..."}`, mode 0600); never logged. */
export async function readApiKey(path: string): Promise<string> {
  const j = JSON.parse(await readFile(path, "utf8")) as { api_key?: unknown };
  if (typeof j.api_key !== "string" || !j.api_key) throw new Error("console credentials hold no api_key");
  return j.api_key;
}

export interface PusherDeps {
  cfg: ConsoleConfig; build: () => Promise<{ generated_at: string }>; fetch: Fetch; readKey?: () => Promise<string>;
  now: () => Date; log: Log;
  /** Test seam for the debounce timer. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

/** Spec 051 AC-3: push the snapshot when it changed or `push_min_s` has passed; event pushes are debounced; outcomes push at once. */
export class ConsolePusher {
  #d: PusherDeps;
  #last: string | null = null;
  #lastAt = -Infinity;
  #failed: string | null = null;
  #timer: unknown = null;
  #inflight: Promise<boolean> = Promise.resolve(true);
  constructor(d: PusherDeps) { this.#d = d; }

  async #push(): Promise<boolean> {
    const d = this.#d;
    try {
      const snap = await d.build();
      const { generated_at: _g, ...rest } = snap;
      const key = JSON.stringify(rest);
      const apiKey = await (d.readKey ?? (() => readApiKey(d.cfg.credentials_path)))();
      const res = await d.fetch(`${d.cfg.url}/state`, { method: "PUT", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify(snap) });
      if (!res.ok) throw new Error(`PUT /state answered ${res.status}`);
      this.#last = key;
      this.#lastAt = d.now().getTime();
      if (this.#failed) d.log({ kind: "console", status: "push-recovered" });
      this.#failed = null;
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (this.#failed !== msg) d.log({ kind: "console", status: "push-failed", reason: msg });
      this.#failed = msg;
      return false;
    }
  }

  /** Serialised so two triggers never race on the last-pushed record. */
  #run(): Promise<boolean> {
    const p = this.#inflight.then(() => this.#push());
    this.#inflight = p.catch(() => false);
    return p;
  }

  /** The tick's push: when the snapshot differs from the last pushed one, or `push_min_s` has passed. Never throws. */
  async tick(): Promise<void> {
    const d = this.#d;
    const elapsed = d.now().getTime() - this.#lastAt;
    if (elapsed >= d.cfg.push_min_s * 1000 || this.#failed !== null || this.#last === null) { await this.#run(); return; }
    const { generated_at: _g, ...rest } = await d.build().catch(() => ({ generated_at: "" }));
    if (JSON.stringify(rest) !== this.#last) await this.#run();
  }

  /** A change's own outcome: pushed at once. */
  async now(): Promise<void> { await this.#run(); }

  /** An event outside the tick: one push per `push_min_s`. */
  notify(): void {
    const d = this.#d;
    if (this.#timer) return;
    const wait = Math.max(0, this.#lastAt + d.cfg.push_min_s * 1000 - d.now().getTime());
    const fire = () => { this.#timer = null; void this.#run(); };
    this.#timer = wait === 0 ? (void fire(), null) : (d.setTimer ?? setTimeout)(fire, wait);
  }

  stop(): void { if (this.#timer) clearTimeout(this.#timer as NodeJS.Timeout); this.#timer = null; }
}
