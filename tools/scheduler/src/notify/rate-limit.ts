import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../credentials/check.ts";
import type { ClearSelector, Notification, Notifier } from "./types.ts";

export function identity(n: Notification): string {
  return `${n.issue}:${n.gate}:${n.label}`;
}

/** Spec 102 AC-5: gates that describe a condition lasting days; they repeat at `repeatHours`, the others at `hours`. */
export const LASTING_GATES = new Set(["standing", "infra", "chain_error", "aws", "credential-expiry"]);

/** Spec 102 AC-6: does an identity (`issue:gate:label`) match the selector. */
export function matchesClear(id: string, sel: ClearSelector): boolean {
  const prefix = `${sel.issue}:${sel.gate}:`;
  if (!id.startsWith(prefix)) return false;
  const label = id.slice(prefix.length);
  if (sel.label !== undefined) return label === sel.label;
  if (sel.labelPrefix !== undefined) return label.startsWith(sel.labelPrefix);
  return true;
}

export function rateLimited(inner: Notifier, opts: { hours: number; repeatHours: number; path: string }, clock: () => Date = () => new Date()): Notifier & { sent: Map<string, number> } {
  const sent = new Map<string, number>();
  const shortMs = opts.hours * 3_600_000;
  const longMs = opts.repeatHours * 3_600_000;
  let loaded = false;
  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const v = JSON.parse(await readFile(opts.path, "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, at] of Object.entries(v as Record<string, unknown>)) {
          const t = typeof at === "string" ? Date.parse(at) : NaN;
          if (!Number.isNaN(t) && !sent.has(k)) sent.set(k, t);
        }
      }
    } catch { /* missing or unreadable: an empty map */ }
  }
  async function persist(): Promise<void> {
    const cutoff = clock().getTime() - Math.max(shortMs, longMs);
    for (const [k, t] of sent) if (t < cutoff) sent.delete(k);
    await writeJsonAtomic(opts.path, Object.fromEntries([...sent].map(([k, t]) => [k, new Date(t).toISOString()]))).catch(() => {});
  }
  return {
    sent,
    async notify(n, extra) {
      await load();
      const key = identity(n);
      const now = clock().getTime();
      const last = sent.get(key);
      const windowMs = LASTING_GATES.has(n.gate) ? longMs : shortMs;
      if (last !== undefined && now - last < windowMs) return { channel: "suppressed" };
      sent.set(key, now);
      await persist();
      return inner.notify(n, extra);
    },
    async flush() {
      return (await inner.flush?.()) ?? 0;
    },
    async clear(sel) {
      await load();
      let changed = false;
      for (const k of [...sent.keys()]) if (matchesClear(k, sel)) { sent.delete(k); changed = true; }
      if (changed) await persist();
      await inner.clear?.(sel);
    },
  };
}
