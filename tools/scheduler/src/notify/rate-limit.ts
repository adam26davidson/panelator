import type { Notification, Notifier } from "./types.ts";

export function identity(n: Notification): string {
  return `${n.issue}:${n.gate}:${n.label}`;
}

export function rateLimited(inner: Notifier, hours: number, clock: () => Date = () => new Date()): Notifier & { sent: Map<string, number> } {
  const sent = new Map<string, number>();
  const windowMs = hours * 3_600_000;
  return {
    sent,
    async notify(n) {
      const key = identity(n);
      const now = clock().getTime();
      const last = sent.get(key);
      if (last !== undefined && now - last < windowMs) return;
      sent.set(key, now);
      await inner.notify(n);
    },
  };
}
