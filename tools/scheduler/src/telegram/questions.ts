import type { PausedRecord } from "../state/paused.ts";
import type { TelegramUpdate, Keyboard } from "./client.ts";
import type { Question, Request } from "../types.ts";
import { renderRequest } from "../chain/question.ts";

/** Spec 030 AC-7: a request has a fixed keyboard; the stage's own options stay in the comment as the record. */
export function fixedButtons(r: Request): string[] {
  return r.type === "credential" ? ["Done", "Can't do this"] : r.type === "funds" ? ["Approved", "Declined"] : ["Approve", "Deny"];
}
/** The label of button `n` (1-based), for the answer text and the chosen line. */
export function buttonLabel(q: Question, n: number): string | undefined {
  return q.request ? fixedButtons(q.request)[n - 1] : q.options[n - 1]?.label;
}
export interface PendingSelection {
  message_id?: number;
  list_message_id: number;
  text: string;
  at: string;
  update_id?: number;
}
export const NO_OPEN_QUESTION = "No open question";
export function questionMessage(
  issue: { number: number; title: string },
  r: PausedRecord,
  commentUrl: string,
) {
  return {
    text: [
      `#${issue.number} ${issue.title}`,
      r.question.question,
      ...(r.question.request ? [renderRequest(r.question.request).join("\n")] : r.question.options.map((o, i) => `${i + 1}. ${o.label} — ${o.cost}`)),
      `Recommendation: ${r.question.recommendation}`,
      commentUrl,
    ].join("\n\n"),
    reply_markup: {
      inline_keyboard: (r.question.request ? fixedButtons(r.question.request).map((label) => ({ label })) : r.question.options).map((o, i) => {
        const callback_data = `q:${r.nonce}:${i + 1}`;
        if (Buffer.byteLength(callback_data) > 64)
          throw Error("callback data too long");
        return [{ text: (r.question.request ? o.label : `${i + 1}. ${o.label}`).slice(0, 64), callback_data }];
      }),
    },
  };
}
export const followUpMessage = questionMessage;
export const reminderText = (r: PausedRecord) =>
  `Still waiting on your answer: ${r.question.question}`;
export const chosenLine = (n: number, label: string) =>
  `Chosen: ${n}. ${label}`;
export const ackText = (stage: string, issue: number, pickedUpFrom?: Date) =>
  pickedUpFrom
    ? `Picked up your reply from ${pickedUpFrom.toISOString().slice(11, 16)}; resuming ${stage} on #${issue}.`
    : `Got it, resuming ${stage} on #${issue}.`;
export const alreadyAnswered = (where: string) =>
  `That question was already answered on ${where}.`;
export function doneLine(
  kind: "settled" | "settled_no_record" | "spec_pr" | "other" | "failed",
  detail = "",
) {
  return kind === "settled"
    ? `Settled: ${detail.split("\n")[0]}; recording it next`
    : kind === "settled_no_record"
      ? "Settled: continuing with your answer"
      : kind === "spec_pr"
        ? `Done: recorded in ${detail}`
        : kind === "failed"
          ? `The ${detail} run failed; the chain retries`
          : "Done: continuing with your answer";
}
export function openQuestionsList(records: PausedRecord[]) {
  return {
    text: records.length
      ? records
          .map(
            (r) =>
              `#${r.issue} ${r.issue_title ?? r.question.question.split("\n")[0]}`,
          )
          .join("\n")
      : NO_OPEN_QUESTION,
    reply_markup: {
      inline_keyboard: records.map((r) => [
        {
          text: `#${r.issue} ${r.issue_title ?? r.question.question}`.slice(
            0,
            64,
          ),
          callback_data: `pick:${r.issue}`,
        },
      ]),
    } satisfies Keyboard,
  };
}
type Match =
  | {
      kind: "answer" | "pick";
      record: PausedRecord;
      text: string;
      viaCallback?: { id: string; message_id: number; n: number };
    }
  | { kind: "list"; text: string }
  | { kind: "questions" | "none" | "ignore" };
export function matchUpdate(
  u: TelegramUpdate,
  records: PausedRecord[],
  pending: PendingSelection | null,
): Match {
  if (u.edited_message) return { kind: "ignore" };
  const m = u.message;
  const cb = u.callback_query;
  const open = records.filter(
    (r) => r.phase === "paused" && r.telegram?.message_id,
  );
  if (m?.text === "/questions") return { kind: "questions" };
  if (cb?.data?.startsWith("q:")) {
    const [, nonce, option] = cb.data.split(":");
    const r = records.find((r) => r.nonce === nonce);
    const n = Number(option);
    const o = r ? buttonLabel(r.question, n) : undefined;
    if (!r || !o) return { kind: "ignore" };
    return {
      kind: "answer",
      record: r,
      text: r.question.request ? o : `${n}. ${o}`,
      viaCallback: { id: cb.id, message_id: cb.message?.message_id ?? 0, n },
    };
  }
  if (pending) {
    const picked = cb?.data?.startsWith("pick:")
      ? Number(cb.data.slice(5))
      : m?.reply_to_message?.message_id === pending.list_message_id
        ? Number(m.text?.match(/#?(\d+)/)?.[1])
        : NaN;
    const r = open.find((r) => r.issue === picked);
    if (r) return { kind: "pick", record: r, text: pending.text };
  }
  if (!m?.text) return { kind: "ignore" };
  const r = m.reply_to_message
    ? records.find((r) =>
        [
          r.telegram?.message_id,
          r.telegram?.reminder_message_id,
          ...(r.telegram?.thread_message_ids ?? []),
        ].includes(m.reply_to_message!.message_id),
      )
    : open.length === 1
      ? open[0]
      : undefined;
  if (r) {
    // Telegram dates have second resolution; a reply in the send's second is not stale.
    if (
      m.date <
      Math.floor(Date.parse(r.telegram?.sent_at ?? r.asked_at ?? "") / 1000)
    )
      return { kind: "ignore" };
    return { kind: "answer", record: r, text: m.text };
  }
  if (m.reply_to_message) return { kind: "ignore" };
  return open.length > 1 ? { kind: "list", text: m.text } : { kind: "none" };
}
