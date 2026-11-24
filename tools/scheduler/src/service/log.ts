import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Spec 114 AC-1: records kept in memory while the log cannot be appended. */
export const LOG_QUEUE_MAX = 2000;

export interface ServiceLogOptions {
  append?: (path: string, text: string) => void;
  stderr?: (line: string) => void;
}

/**
 * The service log never throws (spec 114 AC-1): a record that cannot be appended goes to stderr and waits in memory;
 * the next append that succeeds writes the waiting records first, with their own times.
 */
export class ServiceLog {
  readonly path: string;
  #append: (path: string, text: string) => void;
  #stderr: (line: string) => void;
  #queue: Record<string, unknown>[] = [];
  #dropped: { count: number; from: string; to: string } | null = null;
  #failed = false;
  constructor(path: string, opts: ServiceLogOptions = {}) {
    this.path = path;
    this.#append = opts.append ?? ((p, t) => appendFileSync(p, t));
    this.#stderr = opts.stderr ?? ((l) => { process.stderr.write(l + "\n"); });
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch { /* the first append reports it */ }
  }
  write(rec: Record<string, unknown>): void {
    const full = { at: new Date().toISOString(), ...rec };
    this.#queue.push(full);
    while (this.#queue.length > LOG_QUEUE_MAX) {
      const at = String(this.#queue.shift()!.at);
      this.#dropped = this.#dropped ? { ...this.#dropped, count: this.#dropped.count + 1, to: at } : { count: 1, from: at, to: at };
    }
    let text = this.#queue.map((r) => JSON.stringify(r) + "\n").join("");
    if (this.#dropped) text += JSON.stringify({ at: new Date().toISOString(), kind: "service-log-dropped", ...this.#dropped }) + "\n";
    if (this.#failed) text = "\n" + text;
    try {
      this.#append(this.path, text);
    } catch {
      this.#failed = true;
      try { this.#stderr(`service-log unwritten: ${JSON.stringify(full)}`); } catch { /* nothing else to try */ }
      return;
    }
    this.#failed = false;
    this.#queue = [];
    this.#dropped = null;
  }
  tick(info: Record<string, unknown>): void {
    this.write({ kind: "tick", ...info });
  }
  stopped(reason: string): void {
    this.write({ kind: "stopped", reason });
  }
}
