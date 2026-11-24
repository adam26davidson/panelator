import type { Notifier } from "./types.ts";
import type { StatePaths } from "../state/paths.ts";
import { record } from "../events/store.ts";
import { isSpaceFailure } from "../runner/host-space.ts";

/** Spec 114 AC-5: contact events kept in memory while the state volume takes no writes. */
export const CONTACTS_KEPT = 100;

interface Kept { at: Date; payload: Record<string, unknown>; issue?: number }

/**
 * Records a `maintainer.contact` event beside each send (spec 026 AC-2). Wrap the sender inside `rateLimited`, so a
 * suppressed notification is not a contact. A send that happened is a delivered notification whatever happens to its
 * event: one that cannot be written for lack of space is kept and written later (spec 114 AC-5).
 */
export function recordedNotifier(inner: Notifier, paths: StatePaths, clock: () => Date = () => new Date(), log?: (rec: Record<string, unknown>) => void): Notifier {
  let kept: Kept[] = [];
  let reported = false;
  const report = (e: unknown) => {
    if (reported) return;
    reported = true;
    log?.({ kind: "error", error: `notify record: ${(e as Error).message}` });
  };
  const write = (k: Kept) => record(paths, "maintainer.contact", k.at, k.payload, k.issue ? { issue: k.issue } : {});
  // One drain or record at a time: an entry is removed only by the call that wrote it.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const drain = async (): Promise<boolean> => {
    while (kept.length > 0) {
      try {
        await write(kept[0]!);
      } catch (e) {
        if (isSpaceFailure(e)) { report(e); return false; }
        report(e);
      }
      kept.shift();
    }
    return true;
  };
  return {
    async notify(n, extra) {
      const res = await inner.notify(n, extra);
      const item: Kept = { at: clock(), issue: n.issue || undefined, payload: { channel: res?.channel ?? "log", kind: n.contact?.kind ?? "notification", ...(n.issue ? { issue: n.issue } : {}), label: n.label || n.gate, text: n.text, ...(n.contact?.request ? { request: n.contact.request } : {}) } };
      await serial(async () => {
        if (await drain()) {
          try {
            await write(item);
            reported = false;
          } catch (e) {
            report(e);
            if (isSpaceFailure(e)) { kept.push(item); if (kept.length > CONTACTS_KEPT) kept.shift(); }
          }
        } else {
          kept.push(item);
          if (kept.length > CONTACTS_KEPT) kept.shift();
        }
      });
      return res;
    },
    flush: async () => {
      if (await serial(drain)) reported = false;
      return (await inner.flush?.()) ?? 0;
    },
    clear: async (sel) => { await inner.clear?.(sel); },
  };
}
