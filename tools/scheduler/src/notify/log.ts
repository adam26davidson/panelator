import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Notification, Notifier, NotifyResult } from "./types.ts";

/** v0 implementation (spec section 15): one JSON line per notification in the service log. */
export class LogNotifier implements Notifier {
  readonly path: string;
  constructor(logPath: string) {
    this.path = logPath;
  }
  async notify(n: Notification, extra?: { channel?: "telegram" | "log" }): Promise<NotifyResult> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ kind: "notify", at: new Date().toISOString(), ...n, ...(extra?.channel ? { channel: extra.channel } : {}) }) + "\n");
    return { channel: "log" };
  }
}
