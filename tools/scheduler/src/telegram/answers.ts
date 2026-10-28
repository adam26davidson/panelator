import { readFile } from "node:fs/promises";
import type { DriverDeps } from "../chain/driver.ts";
import { listPaused, writePaused, type PausedRecord } from "../state/paused.ts";
import { answeredEntry, appendQuestionLog } from "../state/questions.ts";
import type { TelegramUpdate } from "./client.ts";
import {
  ackText,
  alreadyAnswered,
  chosenLine,
  matchUpdate,
  openQuestionsList,
  NO_OPEN_QUESTION,
  type PendingSelection,
} from "./questions.ts";
import { saveJson } from "./poller.ts";
interface Journal {
  selection: PendingSelection | null;
  handled: number[];
  answered: PausedRecord[];
}
export class TelegramAnswers {
  private d: DriverDeps;
  private wake: () => void;
  constructor(d: DriverDeps, wake: () => void) {
    this.d = d;
    this.wake = wake;
  }
  private async journal(): Promise<Journal> {
    return JSON.parse(
      await readFile(this.d.paths.telegramPending, "utf8").catch(
        () => '{"selection":null,"handled":[],"answered":[]}',
      ),
    );
  }
  async acknowledge(r: PausedRecord, u?: TelegramUpdate) {
    const tg = r.telegram;
    const channel = this.d.telegram;
    if (!tg || !channel || tg.channel !== "telegram" || tg.ack_sent) return;
    // Mark before send: delivery is at-most-once across an ambiguous network failure.
    tg.ack_sent = true;
    await writePaused(this.d.paths, r);
    const m = u?.message;
    const date = m ? new Date(m.date * 1000) : undefined;
    const id = await channel.sendReply(
      ackText(
        r.asking_stage,
        r.issue,
        date && this.d.now().getTime() - date.getTime() > 120000
          ? date
          : undefined,
      ),
      tg.thread_last_message_id ?? tg.message_id ?? undefined,
    );
    tg.thread_message_ids.push(id);
    await writePaused(this.d.paths, r);
  }
  async archive(r: PausedRecord) {
    const j = await this.journal();
    j.answered = j.answered.filter((a) => a.nonce !== r.nonce);
    j.answered.push({ ...r, phase: "resuming" });
    j.answered = j.answered.slice(-1000);
    await saveJson(this.d.paths.telegramPending, j);
  }
  async handle(u: TelegramUpdate) {
    const d = this.d;
    const channel = d.telegram;
    if (!channel) return;
    const journal = await this.journal();
    if (journal.handled.includes(u.update_id)) return;
    const records = await listPaused(d.paths);
    const match = matchUpdate(
      u,
      [
        ...records,
        ...journal.answered.filter(
          (a) => !records.some((r) => r.nonce === a.nonce),
        ),
      ],
      journal.selection,
    );
    if (match.kind === "answer" || match.kind === "pick") {
      let r = records.find((r) => r.nonce === match.record.nonce);
      if (
        !r ||
        (r.phase === "resuming" && r.telegram?.answer_update_id !== u.update_id)
      ) {
        d.log({kind:'telegram-answer-ignored',issue:match.record.issue,channel:match.record.telegram?.channel??'issue',update_id:u.update_id});
        if(u.callback_query)await channel.answerCallback(u.callback_query.id);
        await channel.sendReply(
          alreadyAnswered(match.record.telegram?.channel ?? "the issue"),
          u.message?.message_id,
        );
      } else if (r.telegram) {
        if (r.phase !== "resuming") {
          // The nonce permits adoption after a crash between GitHub delivery and local persistence.
          const marker = `<!-- panelator-telegram-answer:${u.update_id} -->`;
          const comments = await d.gh.listComments(r.issue);
          const existing = comments.find((c) => c.body.includes(marker));
          const posted =
            existing ??
            (await d.gh.comment(
              r.issue,
              `Answer from the maintainer (Telegram)\n\n${match.text
                .split("\n")
                .map((l) => "> " + l)
                .join("\n")}\n\n${marker}`,
            ));
          r = {
            ...r,
            phase: "resuming",
            answer: match.text,
            reply_comment_id: posted.id,
            telegram: {
              ...r.telegram,
              answer_update_id: u.update_id,
              channel: "telegram",
              thread_last_message_id:
                u.message?.message_id ?? u.callback_query?.message?.message_id ?? r.telegram.message_id,
            },
          };
          await writePaused(d.paths, r);
        }
        if (!(await answeredEntry(d.paths, r.question_comment_id!)))
          await appendQuestionLog(d.paths, {
            issue: r.issue,
            at: d.now().toISOString(),
            event: "answered",
            asking_stage: r.asking_stage,
            question_comment_id: r.question_comment_id!,
            reply_comment_id: r.reply_comment_id!,
            answer: r.answer!,
            question: r.question,
            channel: "telegram",
            telegram_message_id:
              u.message?.message_id ?? u.callback_query?.message?.message_id,
          });
        if (!journal.answered.some((a) => a.nonce === r!.nonce))
          journal.answered.push(r);
        if (match.kind === "pick") journal.selection = null;
      }
    } else if (match.kind === "list" || match.kind === "questions") {
      const open = records.filter((r) => r.phase === "paused");
      const list = openQuestionsList(open);
      const id = await channel.sendReply(
        list.text,
        u.message?.message_id,
        list.reply_markup,
      );
      if (match.kind === "list")
        journal.selection = {
          list_message_id: id,
          text: match.text,
          at: d.now().toISOString(),
          update_id: u.update_id,
        };
    } else if (match.kind === "none")
      await channel.sendReply(NO_OPEN_QUESTION, u.message?.message_id);
    journal.handled.push(u.update_id);
    journal.handled = journal.handled.slice(-1000);
    journal.answered = journal.answered.slice(-1000);
    await saveJson(d.paths.telegramPending, journal);
  }
  async confirmed(u: TelegramUpdate) {
    const records = await listPaused(this.d.paths);
    const r = records.find((r) => r.telegram?.answer_update_id === u.update_id);
    if (r) {
      await this.acknowledge(r, u);
      this.wake();
      if (u.callback_query) {
        await this.d.telegram!.answerCallback(u.callback_query.id);
        if (u.callback_query.data?.startsWith("q:")) {
          await this.d.telegram!.replaceKeyboard(
            u.callback_query.message!.message_id,
          );
          const n = Number(u.callback_query.data.split(":")[2]);
          await this.d.telegram!.sendReply(
            chosenLine(n, r.question.options[n - 1]?.label ?? ""),
            r.telegram?.message_id ?? undefined,
          );
        }
      }
    }
  }
}
