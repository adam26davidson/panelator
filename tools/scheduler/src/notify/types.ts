export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
  /** Spec 022 AC-7: when set, the recorded `maintainer.contact` event has this kind (and `request`) instead of `notification`. */
  contact?: { kind: "funds"; request?: Record<string, unknown> };
}

/** Spec 099 AC-6: which channel carried the notification; `suppressed` is the rate limiter dropping it. */
export interface NotifyResult { channel: "telegram" | "log" | "queued" | "suppressed" }

/** Spec 102 AC-6: which sent notices a cleared condition re-arms; `keepQueued` leaves a matching notice in the outbox (the host pause notice is still sent after the resume, AC-4). */
export type ClearSelector = { issue: number; gate: string; label?: string; labelPrefix?: string; keepQueued?: boolean };

export interface Notifier {
  notify(n: Notification, extra?: { channel?: "telegram" | "log" | "queued" }): Promise<NotifyResult | void>;
  /** Spec 102 AC-3: send what the channel could not take; resolves to the number sent. */
  flush?(): Promise<number>;
  /** Spec 102 AC-6: the condition cleared; the next notice of it is sent at once. */
  clear?(sel: ClearSelector): Promise<void>;
}
