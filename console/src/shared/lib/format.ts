const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "10:44" in UTC; the snapshot's times are ISO strings. */
export const clock = (iso: string) => `${pad(new Date(iso).getUTCHours())}:${pad(new Date(iso).getUTCMinutes())}`;

/** "13 Oct" for a date or a week label. */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function duration(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** "4 min old" for a snapshot age. */
export function age(s: number): string {
  if (s < 90) return `${Math.round(s)} s old`;
  if (s < 5400) return `${Math.round(s / 60)} min old`;
  return `${(s / 3600).toFixed(1)} h old`;
}

export function when(iso: string | null): string {
  if (!iso) return "—";
  return `${dayMonth(iso)} ${clock(iso)}`;
}
