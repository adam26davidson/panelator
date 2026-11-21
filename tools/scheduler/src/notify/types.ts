export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
  /** Spec 022 AC-7: when set, the recorded `maintainer.contact` event has this kind (and `request`) instead of `notification`. */
  contact?: { kind: "funds"; request?: Record<string, unknown> };
}

/** Spec 099 AC-6: which channel carried the notification; `suppressed` is the rate limiter dropping it. */
export interface NotifyResult { channel: "telegram" | "log" | "suppressed" }

export interface Notifier {
  notify(n: Notification, extra?: { channel?: "telegram" | "log" }): Promise<NotifyResult | void>;
}
