import { readFile } from "node:fs/promises";
import type { TelegramChannel } from "../telegram/channel.ts";
import { writeJsonAtomic } from "../credentials/check.ts";
import { identity, matches } from "./rate-limit.ts";
import type { ClearSelector, Notification, Notifier, NotifyResult } from "./types.ts";

export const ALERT_IDS_KEPT = 200;
/** Spec 102 AC-2: the outbox holds at most this many notices. */
export const OUTBOX_KEPT = 100;
/** Spec 102 AC-1: the question path sends these itself; the notifier only logs them. */
export const QUESTION_GATES = ["question", "question-reminder"];

export interface OutboxEntry {
  identity: string;
  issue: number;
  gate: string;
  label: string;
  text: string;
  queued_at: string;
  repeats: number;
  cleared_at?: string;
}

export async function readAlertIds(path: string): Promise<number[]> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export async function readOutbox(path: string): Promise<OutboxEntry[]> {
  try {
    const v = JSON.parse(await readFile(path, "utf8")) as unknown;
    return Array.isArray(v) ? v.filter((x): x is OutboxEntry => !!x && typeof x === "object" && typeof (x as OutboxEntry).identity === "string" && typeof (x as OutboxEntry).text === "string") : [];
  } catch {
    return [];
  }
}

export function alertText(n: Notification): string {
  return `${n.gate}: ${n.label}${n.issue ? ` #${n.issue}` : ""}\n\n${n.text}`;
}

function queuedText(e: OutboxEntry): string {
  const line = `queued ${e.queued_at}${e.repeats > 1 ? `, repeated ${e.repeats} times` : ""}${e.cleared_at ? `, cleared ${e.cleared_at}` : ""}`;
  return `${e.gate}: ${e.label}${e.issue ? ` #${e.issue}` : ""}\n${line}\n\n${e.text}`;
}

/**
 * Spec 099 AC-6 as amended by spec 102: every notification but the question gates goes to the chat as one
 * informational message (no buttons, no mention); one the chat cannot take waits in the outbox and is sent,
 * oldest first, by `flush` once the channel is back. A clear never removes a queued notice, it stamps it.
 */
export function TelegramNotifier(inner: Notifier, deps: { telegram: () => TelegramChannel | null; alertsPath: string; outboxPath: string; now: () => Date; log: (rec: Record<string, unknown>) => void }): Notifier {
  let failing = false;
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn, fn);
    chain = r.catch(() => {});
    return r;
  };

  async function sendText(channel: TelegramChannel, text: string): Promise<number | null> {
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

  async function flushLocked(channel: TelegramChannel): Promise<number> {
    let sent = 0;
    for (;;) {
      const box = await readOutbox(deps.outboxPath);
      const e = box[0];
      if (!e) return sent;
      const id = await sendText(channel, queuedText(e));
      if (id === null) return sent;
      await writeJsonAtomic(deps.outboxPath, box.slice(1));
      sent++;
      deps.log({ kind: "telegram-outbox-sent", identity: e.identity, queued_at: e.queued_at, message_id: id });
    }
  }

  async function queue(n: Notification): Promise<void> {
    const box = await readOutbox(deps.outboxPath);
    const id = identity(n);
    const at = box.findIndex((e) => e.identity === id);
    if (at >= 0) {
      const { cleared_at: _c, ...rest } = box[at]!;
      box[at] = { ...rest, text: n.text, repeats: box[at]!.repeats + 1 };
    } else {
      box.push({ identity: id, issue: n.issue, gate: n.gate, label: n.label, text: n.text, queued_at: deps.now().toISOString(), repeats: 1 });
      while (box.length > OUTBOX_KEPT) {
        const dropped = box.shift()!;
        deps.log({ kind: "telegram-outbox-dropped", identity: dropped.identity, queued_at: dropped.queued_at });
      }
    }
    await writeJsonAtomic(deps.outboxPath, box);
  }

  return {
    notify: (n: Notification): Promise<NotifyResult> =>
      locked(async () => {
        if (QUESTION_GATES.includes(n.gate)) {
          await inner.notify(n, { channel: "log" });
          return { channel: "log" };
        }
        const channel = deps.telegram();
        if (channel) {
          if ((await readOutbox(deps.outboxPath)).length > 0) await flushLocked(channel).catch((e) => deps.log({ kind: "error", error: `notify flush: ${(e as Error).message}` }));
          if ((await readOutbox(deps.outboxPath)).length === 0 && (await sendText(channel, alertText(n))) !== null) {
            await inner.notify(n, { channel: "telegram" });
            return { channel: "telegram" };
          }
        }
        try {
          await queue(n);
        } catch (e) {
          deps.log({ kind: "error", error: `notify outbox: ${(e as Error).message}` });
          await inner.notify(n, { channel: "log" });
          return { channel: "log" };
        }
        await inner.notify(n, { channel: "queued" });
        return { channel: "queued" };
      }),
    flush: () =>
      locked(async () => {
        const channel = deps.telegram();
        if (!channel) return 0;
        return flushLocked(channel);
      }),
    clear: (sel: ClearSelector) =>
      locked(async () => {
        const box = await readOutbox(deps.outboxPath);
        let changed = false;
        for (const e of box) if (!e.cleared_at && matches(e.identity, sel)) { e.cleared_at = deps.now().toISOString(); changed = true; }
        if (changed) await writeJsonAtomic(deps.outboxPath, box);
      }),
  };
}
