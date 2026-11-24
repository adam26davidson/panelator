import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../credentials/check.ts";
import type { ClearSelector, Notification, Notifier } from "./types.ts";

export function identity(n: Notification): string {
  return `${n.issue}:${n.gate}:${n.label}`;
}

/** Spec 102 AC-5: gates that describe a lasting condition; they repeat at `repeatHours`, not `hours`. */
export const LASTING_GATES = ["standing", "infra", "chain_error", "aws", "credential-expiry"];

/** Whether an identity (`<issue>:<gate>:<label>`) is the one `sel` names. */
export function matches(id: string, sel: ClearSelector): boolean {
  const head = `${sel.issue}:${sel.gate}:`;
  if (!id.startsWith(head)) return false;
  const label = id.slice(head.length);
  if (sel.label !== undefined) return label === sel.label;
  if (sel.labelPrefix !== undefined) return label.startsWith(sel.labelPrefix);
  return true;
}

async function load(path: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, t] of Object.entries(v)) { const ms = typeof t === "string" ? Date.parse(t) : NaN; if (!Number.isNaN(ms)) m.set(k, ms); }
  } catch { /* missing or unreadable: empty */ }
  return m;
}

/** Spec 001 AC-27 as amended by spec 102 AC-5 and AC-6: one window per gate, persisted, re-armed by `clear`. */
export function rateLimited(inner: Notifier, opts: { hours: number; repeatHours: number; path: string }, clock: () => Date = () => new Date()): Notifier {
  let sent: Promise<Map<string, number>> | undefined;
  const get = () => (sent ??= load(opts.path));
  const windowMs = (gate: string) => (LASTING_GATES.includes(gate) ? opts.repeatHours : opts.hours) * 3_600_000;
  const longest = Math.max(opts.hours, opts.repeatHours) * 3_600_000;
  const save = async (m: Map<string, number>) => {
    const o: Record<string, string> = {};
    for (const [k, t] of m) o[k] = new Date(t).toISOString();
    await writeJsonAtomic(opts.path, o);
  };
  return {
    async notify(n) {
      const m = await get();
      const key = identity(n);
      const now = clock().getTime();
      const last = m.get(key);
      if (last !== undefined && now - last < windowMs(n.gate)) return { channel: "suppressed" };
      m.set(key, now);
      for (const [k, t] of m) if (now - t >= longest) m.delete(k);
      const save_ = save(m).catch(() => {});
      let res: Awaited<ReturnType<Notifier["notify"]>>;
      try {
        res = await inner.notify(n);
      } catch (e) {
        // Spec 114 AC-5: an identity that was not delivered is not held.
        await save_;
        if (last === undefined) m.delete(key);
        else m.set(key, last);
        await save(m).catch(() => {});
        throw e;
      }
      await save_;
      return res;
    },
    async flush() {
      return (await inner.flush?.()) ?? 0;
    },
    async clear(sel) {
      const m = await get();
      let changed = false;
      for (const k of [...m.keys()]) if (matches(k, sel)) { m.delete(k); changed = true; }
      if (changed) await save(m).catch(() => {});
      await inner.clear?.(sel);
    },
  };
}
