/** Spec 013 AC-1 to AC-3: a provider's limit message as a limit key, scope and (where stated) reset instant. */
export type LimitScope = "session" | "weekly" | "model" | "unknown";
export interface ParsedLimit {
  key: string;
  scope: LimitScope;
  /** The stated reset, or null when the message names none (the caller backs off). */
  resetsAt: Date | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Claude model families a model limit can name; any other word is not a model limit. */
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
/** A stated reset at most this far in the past means the limit has just lifted (the 429 raced the reset). */
export const JUST_PASSED_MS = 30 * 60_000;
/** The wait used for a reset that has just passed. */
export const JUST_RESET_WAIT_MS = 60_000;
/** A dated reset further in the past than this is next year's date (a December message naming January). */
const YEAR_WRAP_MS = 300 * 86_400_000;

/** The zone's offset from UTC, in ms, at instant `t`. Throws on an unknown zone. */
function offsetAt(t: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(t)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant at which the wall clock in `zone` reads y-m-d h:mi; a time in a spring-forward gap lands after the gap. */
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

/**
 * `8:10am`, `3am`, `15:10`, optionally after `Nov 3,`, in `zone`; or null. An undated time is the next such time
 * after `now`, except that one at most 30 minutes past is "just reset" (now plus a minute), never tomorrow. A dated
 * time is this year's, "just reset" when past, and next year's only across the year boundary.
 */
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
  const justReset = new Date(now.getTime() + JUST_RESET_WAIT_MS);
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) return null;
    const t = zonedInstant(today.y, month, day, hour, minute, zone);
    if (t > now) return t;
    if (now.getTime() - t.getTime() > YEAR_WRAP_MS) return zonedInstant(today.y + 1, month, day, hour, minute, zone);
    return justReset;
  }
  const t = zonedInstant(today.y, today.m, today.d, hour, minute, zone);
  if (t > now) return t;
  if (now.getTime() - t.getTime() <= JUST_PASSED_MS) return justReset;
  return zonedInstant(today.y, today.m, today.d + 1, hour, minute, zone);
}

/** AC-1 to AC-3. `harness` and `model` name the run that hit the limit, for an unrecognised message's key. */
export function parseLimit(reason: string | null, harness: string, model: string, now: Date): ParsedLimit {
  const text = reason ?? "";
  const named = /(?:hit|reached) your ([\w -]+?) limit/i.exec(text);
  const reset = /resets\s+([^()·]+?)\s*\(([^)]+)\)/i.exec(text);
  const resetsAt = reset ? parseReset(reset[1], reset[2].trim(), now) : null;
  const unknown: ParsedLimit = { key: `${harness}:${model}`, scope: "unknown", resetsAt };
  if (!named || harness !== "claude") return unknown;
  const words = named[1].toLowerCase().split(/\s+/);
  const family = words.find((w) => FAMILIES.includes(w));
  if (family) return { key: `claude:${family}`, scope: "model", resetsAt };
  if (words.includes("weekly")) return { key: "claude", scope: "weekly", resetsAt };
  if (words.includes("session") || words.includes("5-hour")) return { key: "claude", scope: "session", resetsAt };
  return unknown;
}

/** True when a limit key covers a run of `model` on `harness`. */
export function keyCovers(key: string, harness: string, model: string): boolean {
  if (key === harness) return true;
  if (key === `${harness}:${model}`) return true;
  if (harness === "claude" && key.startsWith("claude:")) return model.includes(`-${key.slice(7)}-`) || model.endsWith(`-${key.slice(7)}`);
  return false;
}
