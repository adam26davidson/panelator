export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
  /** Spec 030 AC-9: where the alert went; set by the TelegramNotifier, `log` when nothing else is said. */
  channel?: "telegram" | "log";
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}
