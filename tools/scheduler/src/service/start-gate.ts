import { outageBackoffS } from "../chain/transient.ts";
import { isSpaceFailure, MIN_FREE_BYTES, MIN_FREE_INODES, statfsFreeSpace, underWriteFloor, type FreeSpace } from "../runner/host-space.ts";

/** Spec 114 AC-6: what a start that waited reports once it can write. */
export interface StartWaited { since: string; waited_ms: number; free_bytes: number; free_inodes: number | null }

export interface StartGateDeps {
  /** The state root. */
  root: string;
  freeSpace?: (path: string) => Promise<FreeSpace>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  stderr?: (line: string) => void;
  /** Sends one message to the maintainer; absent when Telegram is off. Its error must not carry the bot token. */
  send?: (text: string) => Promise<void>;
  signal?: AbortSignal;
}

const mib = (b: number): number => Math.floor(b / 2 ** 20);
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });

/**
 * Spec 114 AC-6: a scheduler started on a full state volume waits before its first write instead of dying, tells the
 * maintainer once (again at each re-read until a send succeeds), and returns when the volume is above the launch
 * floors. A read that fails counts as room: the gate never blocks a start on its own failure. Null when it did not wait.
 */
export async function waitForStateSpace(deps: StartGateDeps): Promise<StartWaited | null> {
  const read = deps.freeSpace ?? statfsFreeSpace;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const stderr = deps.stderr ?? ((l: string) => { process.stderr.write(l + "\n"); });
  let first: FreeSpace;
  try {
    first = await read(deps.root);
  } catch {
    return null;
  }
  if (!underWriteFloor(first)) return null;
  const t0 = now();
  const since = new Date(t0).toISOString();
  const numbers = `${deps.root} has ${mib(first.bytes)} MiB free and ${first.inodes ?? "unknown"} free inodes`;
  stderr(`panelator-scheduler: state volume full, waiting to start: ${numbers}`);
  const text = `The scheduler cannot start: the state volume is full (${numbers}). It starts by itself when there is room.`;
  let sent = false;
  const trySend = async (): Promise<void> => {
    if (sent || !deps.send) return;
    try {
      await deps.send(text);
      sent = true;
    } catch (e) {
      stderr(`panelator-scheduler: state volume notice not sent: ${e instanceof Error ? e.message : "send failed"}`);
    }
  };
  await trySend();
  for (let n = 1; ; n++) {
    await sleep(outageBackoffS(n) * 1000, deps.signal);
    let f: FreeSpace;
    try {
      f = await read(deps.root);
    } catch {
      break;
    }
    if (f.bytes >= MIN_FREE_BYTES && (f.inodes === null || f.inodes >= MIN_FREE_INODES)) break;
    await trySend();
  }
  return { since, waited_ms: now() - t0, free_bytes: first.bytes, free_inodes: first.inodes };
}

/** AC-7: the exit a start failure earns: 75 and its one stderr line for a space failure, else null (the failure ends as it does today). */
export function startFailureExit(e: unknown): { code: 75; line: string } | null {
  if (!isSpaceFailure(e)) return null;
  return { code: 75, line: `panelator-scheduler: state volume full during start: ${e instanceof Error ? e.message : String(e)}` };
}

/** AC-7: the running service's `unhandledRejection` handler: a space failure is logged and the process goes on; any other reason is rethrown, which ends the process as today. */
export function unhandledRejectionHandler(log: (rec: Record<string, unknown>) => void): (reason: unknown) => void {
  return (reason) => {
    if (!isSpaceFailure(reason)) throw reason;
    log({ kind: "error", error: `unhandled: ${reason instanceof Error ? reason.message : String(reason)}` });
  };
}
