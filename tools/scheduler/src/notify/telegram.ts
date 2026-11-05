import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Notification, Notifier } from "./types.ts";

const SEND_TIMEOUT_MS = 10_000;
const KEEP_ALERT_IDS = 200;

export async function readAlertIds(path: string): Promise<number[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as number[];
  } catch {
    return [];
  }
}

async function rememberAlert(path: string, id: number): Promise<void> {
  const ids = [...(await readAlertIds(path)), id].slice(-KEEP_ALERT_IDS);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(ids));
  await rename(path + ".tmp", path);
}

export const alertText = (n: Notification) => `${n.gate} / ${n.label}${n.issue > 0 ? ` (#${n.issue})` : ""}\n\n${n.text}`;

/**
 * Spec 030 AC-9: every notification that passes the rate limiter is sent to the chat as one message with no buttons,
 * then written to the service log through the inner notifier with the channel it went by. A failed send is logged
 * once per outage and never retried: alerts are not questions.
 */
export class TelegramNotifier implements Notifier {
  #failing = false;
  readonly inner: Notifier;
  readonly send: (text: string) => Promise<number>;
  readonly alertsPath: string;
  readonly warn: (rec: Record<string, unknown>) => void;
  constructor(inner: Notifier, send: (text: string) => Promise<number>, alertsPath: string, warn: (rec: Record<string, unknown>) => void) {
    this.inner = inner;
    this.send = send;
    this.alertsPath = alertsPath;
    this.warn = warn;
  }

  async notify(n: Notification): Promise<void> {
    let channel: "telegram" | "log" = "log";
    try {
      const id = await Promise.race([this.send(alertText(n)), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("send timed out")), SEND_TIMEOUT_MS).unref())]);
      await rememberAlert(this.alertsPath, id).catch(() => {});
      channel = "telegram";
      this.#failing = false;
    } catch {
      if (!this.#failing) this.warn({ kind: "telegram-alert-failed", gate: n.gate, label: n.label });
      this.#failing = true;
    }
    await this.inner.notify({ ...n, channel });
  }
}
