/** Spec 013 AC-1 to AC-3: a provider's limit message as a limit key, scope and (where stated) reset instant. */
export type LimitScope = "session" | "weekly" | "model" | "unknown";
export interface ParsedLimit {
  key: string;
  scope: LimitScope;
  /** The stated reset, or null when the message names none (the caller backs off). */
  resetsAt: Date | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PROVIDER_WIDE = ["session", "weekly", "usage", "daily", "5-hour"];

/** The zone's offset from UTC, in ms, at instant `t`. Throws on an unknown zone. */
function offsetAt(t: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant at which the wall clock in `zone` reads y-m-d h:mi. */
export function zonedInstant(y: number, m: number, d: number, h: number, mi: number, zone: string): Date {
  const wall = Date.UTC(y, m, d, h, mi);
  let t = wall - offsetAt(wall, zone);
  t = wall - offsetAt(t, zone);
  return new Date(t);
}

/** The wall-clock date in `zone` at instant `t`. */
function zonedDate(t: Date, zone: string): { y: number; m: number; d: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(t).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day) };
}

/** `8:10am`, `3am`, `15:10`, optionally after `Nov 3,`; the next such instant after `now` in `zone`, or null. */
export function parseReset(text: string, zone: string, now: Date): Date | null {
  try {
    offsetAt(now.getTime(), zone);
  } catch {
    return null;
  }
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  } else if (!m[4]) return null;
  if (hour > 23 || minute > 59) return null;
  const today = zonedDate(now, zone);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    const day = Number(m[2]);
    for (const y of [today.y, today.y + 1]) {
      const t = zonedInstant(y, month, day, hour, minute, zone);
      if (t > now) return t;
    }
    return null;
  }
  for (let add = 0; add < 2; add++) {
    const t = zonedInstant(today.y, today.m, today.d + add, hour, minute, zone);
    if (t > now) return t;
  }
  return null;
}

/** AC-1 to AC-3. `harness` and `model` name the run that hit the limit, for an unrecognised message's key. */
export function parseLimit(reason: string | null, harness: string, model: string, now: Date): ParsedLimit {
  const text = reason ?? "";
  const named = /(?:hit|reached) your ([\w -]+?) limit/i.exec(text);
  const reset = /resets\s+([^()·]+?)\s*\(([^)]+)\)/i.exec(text);
  const resetsAt = reset ? parseReset(reset[1], reset[2].trim(), now) : null;
  if (!named || harness !== "claude") return { key: `${harness}:${model}`, scope: "unknown", resetsAt };
  const words = named[1].toLowerCase().split(/\s+/);
  const family = words.find((w) => !PROVIDER_WIDE.includes(w));
  if (family) return { key: `claude:${family}`, scope: "model", resetsAt };
  return { key: "claude", scope: words.includes("weekly") ? "weekly" : "session", resetsAt };
}

/** True when a limit key covers a run of `model` on `harness`. */
export function keyCovers(key: string, harness: string, model: string): boolean {
  if (key === harness) return true;
  if (key === `${harness}:${model}`) return true;
  if (harness === "claude" && key.startsWith("claude:")) return model.includes(`-${key.slice(7)}-`) || model.endsWith(`-${key.slice(7)}`);
  return false;
}
