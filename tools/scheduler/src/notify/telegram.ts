import { readFile } from "node:fs/promises";
import type { TelegramChannel } from "../telegram/channel.ts";
import { writeJsonAtomic } from "../credentials/check.ts";
import type { Notification, Notifier, NotifyResult } from "./types.ts";

export const ALERT_IDS_KEPT = 200;

export async function readAlertIds(path: string): Promise<number[]> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function alertText(n: Notification): string {
  return `${n.gate}: ${n.label}${n.issue ? ` #${n.issue}` : ""}\n\n${n.text}`;
}

/** Spec 099 AC-6: every notification also goes to the chat as one message with no buttons; a failed send is logged once per outage and never retried. */
export function TelegramNotifier(inner: Notifier, deps: { telegram: () => TelegramChannel | null; alertsPath: string; log: (rec: Record<string, unknown>) => void }): Notifier {
  let failing = false;
  return {
    async notify(n: Notification): Promise<NotifyResult> {
      const channel = deps.telegram();
      let carried: "telegram" | "log" = "log";
      if (channel) {
        try {
          const id = await channel.sendReply(alertText(n));
          failing = false;
          carried = "telegram";
          await writeJsonAtomic(deps.alertsPath, [...(await readAlertIds(deps.alertsPath)), id].slice(-ALERT_IDS_KEPT)).catch(() => {});
        } catch (e) {
          if (!failing) deps.log({ kind: "telegram-send-failed", what: "alert", error: (e as Error).message });
          failing = true;
        }
      }
      await inner.notify(n, { channel: carried });
      return { channel: carried };
    },
  };
}
