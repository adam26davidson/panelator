export interface Notification {
  issue: number;
  gate: string;
  label: string;
  text: string;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}
