import { readFile } from "node:fs/promises";
import type { TelegramChannel } from "../telegram/channel.ts";
import { writeJsonAtomic } from "../credentials/check.ts";
import { identity, matchesClear } from "./rate-limit.ts";
import type { ClearSelector, Notification, Notifier, NotifyResult } from "./types.ts";

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

export const OUTBOX_MAX = 100;

/** Spec 102 AC-1: these gates are delivered by the question path (spec 007 AC-5, AC-11); the notifier only records them. */
export const QUESTION_GATES = new Set(["question", "question-reminder"]);

export interface OutboxEntry { identity: string; issue: number; gate: string; label: string; text: string; queued_at: string; repeats: number }

export async function readOutbox(path: string): Promise<OutboxEntry[]> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is OutboxEntry => !!x && typeof x === "object" && typeof (x as OutboxEntry).identity === "string" && typeof (x as OutboxEntry).text === "string") : [];
  } catch {
    return [];
  }
}

/** Spec 102 AC-3: the heading, the `queued` line and the text of a notice sent from the outbox. */
function queuedText(e: OutboxEntry): string {
  return `${e.gate}: ${e.label}${e.issue ? ` #${e.issue}` : ""}\n\nqueued ${e.queued_at}${e.repeats > 1 ? `, repeated ${e.repeats} times` : ""}\n\n${e.text}`;
}

/**
 * Spec 099 AC-6, spec 102: every notification except the question gates also goes to the chat as one message with no buttons.
 * A notice the chat cannot take (Telegram off, or the send throws) is queued in the outbox for the channel's return; a failed send is logged once per outage.
 */
export function TelegramNotifier(inner: Notifier, deps: { telegram: () => TelegramChannel | null; alertsPath: string; outboxPath: string; log: (rec: Record<string, unknown>) => void; clock?: () => Date }): Notifier {
  const clock = deps.clock ?? (() => new Date());
  let failing = false;
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
    const run = lock.then(f, f);
    lock = run.catch(() => {});
    return run;
  };

  async function sendOne(channel: TelegramChannel, text: string): Promise<number | null> {
    try {
      const id = await channel.sendReply(text);
      failing = false;
      await writeJsonAtomic(deps.alertsPath, [...(await readAlertIds(deps.alertsPath)), id].slice(-ALERT_IDS_KEPT)).catch(() => {});
      return id;
    } catch (e) {
      if (!failing) deps.log({ kind: "telegram-send-failed", what: "alert", error: (e as Error).message });
      failing = true;
      return null;
    }
  }

  async function flushLocked(): Promise<number> {
    const channel = deps.telegram();
    if (!channel) return 0;
    let sent = 0;
    for (;;) {
      const outbox = await readOutbox(deps.outboxPath);
      const e = outbox[0];
      if (!e) return sent;
      const id = await sendOne(channel, queuedText(e));
      if (id === null) return sent;
      await writeJsonAtomic(deps.outboxPath, (await readOutbox(deps.outboxPath)).filter((x) => x.identity !== e.identity || x.queued_at !== e.queued_at));
      deps.log({ kind: "telegram-outbox-sent", identity: e.identity, queued_at: e.queued_at, message_id: id });
      sent++;
    }
  }

  async function enqueue(n: Notification): Promise<void> {
    const outbox = await readOutbox(deps.outboxPath);
    const key = identity(n);
    const existing = outbox.find((x) => x.identity === key);
    if (existing) {
      existing.repeats += 1;
      existing.text = n.text;
    } else {
      outbox.push({ identity: key, issue: n.issue, gate: n.gate, label: n.label, text: n.text, queued_at: clock().toISOString(), repeats: 1 });
    }
    while (outbox.length > OUTBOX_MAX) {
      const d = outbox.shift()!;
      deps.log({ kind: "telegram-outbox-dropped", identity: d.identity, queued_at: d.queued_at });
    }
    await writeJsonAtomic(deps.outboxPath, outbox);
  }

  return {
    notify(n: Notification): Promise<NotifyResult> {
      if (QUESTION_GATES.has(n.gate)) return inner.notify(n, { channel: "log" }).then(() => ({ channel: "log" as const }));
      return exclusive(async () => {
        if ((await readOutbox(deps.outboxPath)).length > 0) await flushLocked().catch((e) => deps.log({ kind: "telegram-flush-failed", error: (e as Error).message }));
        const channel = deps.telegram();
        const pending = (await readOutbox(deps.outboxPath)).length > 0;
        if (channel && !pending && (await sendOne(channel, alertText(n))) !== null) {
          await inner.notify(n, { channel: "telegram" });
          return { channel: "telegram" as const };
        }
        await enqueue(n);
        await inner.notify(n, { channel: "queued" });
        return { channel: "queued" as const };
      });
    },
    flush(): Promise<number> {
      return exclusive(flushLocked);
    },
    async clear(sel: ClearSelector): Promise<void> {
      await exclusive(async () => {
        const outbox = await readOutbox(deps.outboxPath);
        const kept = outbox.filter((e) => !matchesClear(e.identity, sel));
        if (kept.length !== outbox.length) await writeJsonAtomic(deps.outboxPath, kept);
      });
      await inner.clear?.(sel);
    },
  };
}
