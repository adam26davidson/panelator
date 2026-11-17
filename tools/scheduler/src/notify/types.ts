export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
  /** Spec 022 AC-7: when set, the recorded `maintainer.contact` event has this kind (and `request`) instead of `notification`. */
  contact?: { kind: "funds"; request?: Record<string, unknown> };
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}
