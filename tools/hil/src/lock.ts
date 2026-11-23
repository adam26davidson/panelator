// An exclusive lock on <cache>/board.lock without a native dependency (spec 106 AC-9): the file is created
// with the exclusive flag and names its holder, so a holder that died does not hold the board for ever.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export class LockTimeout extends Error {}

export interface LockOptions {
  clock?: Clock;
  timeoutMs: number;
  pollMs?: number;
  /** A lock older than this is stale whatever its holder (the job's own timeout is 20 minutes). */
  maxAgeMs?: number;
  isAlive?: (pid: number) => boolean;
  pid?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireLock(path: string, opts: LockOptions): Promise<() => void> {
  const clock = opts.clock ?? realClock;
  const pollMs = opts.pollMs ?? 1000;
  const maxAge = opts.maxAgeMs ?? 60 * 60 * 1000;
  const isAlive = opts.isAlive ?? processAlive;
  const pid = opts.pid ?? process.pid;
  const deadline = clock.now() + opts.timeoutMs;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid, at: clock.now() }), { flag: "wx" });
      return () => {
        try {
          const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
          if (held.pid === pid) rmSync(path, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (isStale(path, clock.now(), maxAge, isAlive)) {
      rmSync(path, { force: true });
      continue;
    }
    if (clock.now() >= deadline) throw new LockTimeout(`the board lock ${path} was not free within ${opts.timeoutMs / 1000} s`);
    await clock.sleep(pollMs);
  }
}

function isStale(path: string, now: number, maxAge: number, isAlive: (pid: number) => boolean): boolean {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    if (typeof held.pid !== "number" || !isAlive(held.pid)) return true;
    return typeof held.at === "number" && now - held.at > maxAge;
  } catch {
    // unreadable or half-written: a holder writes it in one call, so only a dead one leaves this
    return true;
  }
}
